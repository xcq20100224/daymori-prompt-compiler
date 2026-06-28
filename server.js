const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const multer = require("multer");
const mammoth = require("mammoth");
const cors = require("cors");
const crypto = require("crypto");
const PptxGenJS = require("pptxgenjs");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AUDIT_LOG_ENABLED = String(process.env.AUDIT_LOG_ENABLED || "true").toLowerCase() !== "false";
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(__dirname, "logs");
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, "audit.log");
const AUDIT_SALT = process.env.AUDIT_SALT || "daymori-audit-salt";

function parseAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

function corsOriginHandler(origin, callback) {
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  return callback(new Error("CORS blocked: origin not allowed"));
}

function hashValue(value) {
  return crypto.createHash("sha256").update(`${AUDIT_SALT}:${String(value || "")}`).digest("hex").slice(0, 16);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function sanitizeAuditDetail(detail) {
  if (!detail) return "";
  const text = String(detail);
  if (text.length <= 220) return text;
  return `${text.slice(0, 220)}...[truncated]`;
}

function writeAuditLog(event) {
  if (!AUDIT_LOG_ENABLED) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG_FILE, line, "utf8");
  } catch (error) {
    console.error("audit_log_write_failed", error.message);
  }
}

function baseAuditEvent(req) {
  return {
    requestId: req.requestId,
    route: req.path,
    method: req.method,
    ipHash: hashValue(getClientIp(req)),
    uaHash: hashValue(req.headers["user-agent"] || ""),
    originHash: hashValue(req.headers.origin || ""),
    provider: (process.env.LLM_PROVIDER || "deepseek").toLowerCase().trim()
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 }
});

app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: corsOriginHandler }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "docs", "index.html"));
});

async function parseUploadedFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext === ".docx") {
    try {
      const doc = await mammoth.extractRawText({ buffer: file.buffer });
      return doc.value || "";
    } catch (error) {
      return `[文件 ${file.originalname}] docx 解析失败（${error.message}），请尝试另存为新的 docx 后重传。`;
    }
  }

  const textExts = new Set([".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".csv", ".yml", ".yaml", ".xml"]);
  if (textExts.has(ext) || (file.mimetype && file.mimetype.startsWith("text/"))) {
    return file.buffer.toString("utf8");
  }

  return `[文件 ${file.originalname}] 该格式暂不支持自动解析文本，请在输入框补充关键内容。`;
}

function getProviderConfig() {
  const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase().trim();
  const modelOverride = (process.env.LLM_MODEL || "").trim();

  if (provider === "deepseek") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "DEEPSEEK_API_KEY",
      apiKey: process.env.DEEPSEEK_API_KEY,
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: modelOverride || "deepseek-chat"
    };
  }

  if (provider === "qwen") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "QWEN_API_KEY",
      apiKey: process.env.QWEN_API_KEY,
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: modelOverride || "qwen-plus"
    };
  }

  if (provider === "zhipu") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "ZHIPU_API_KEY",
      apiKey: process.env.ZHIPU_API_KEY,
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: modelOverride || "glm-4-plus"
    };
  }

  if (provider === "openai") {
    return {
      provider,
      type: "responses",
      keyEnv: "OPENAI_API_KEY",
      apiKey: process.env.OPENAI_API_KEY,
      endpoint: "https://api.openai.com/v1/responses",
      model: modelOverride || "gpt-5.3-codex"
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function extractChatText(data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

function extractHeadings(text) {
  const lines = normalizeText(text).split("\n");
  const headingCandidates = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^#{1,6}\s+/.test(t)) return true;
    if (/^[一二三四五六七八九十0-9]+[、.)）]\s*/.test(t)) return true;
    if (/^chapter\s+\d+/i.test(t)) return true;
    return false;
  });
  return headingCandidates.slice(0, 18);
}

function topKeywords(text, limit = 16) {
  const tokens = normalizeText(text)
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.length >= 2);

  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "will", "into", "you", "your", "http", "https", "www", "com", "的", "了", "和", "是", "在", "与", "以及", "一个", "进行", "可以"]);
  const counts = new Map();
  for (const token of tokens) {
    if (stop.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function buildIngestorPack({ userInput, fileContexts }) {
  const merged = normalizeText(fileContexts.join("\n\n"));
  const clipped = merged.length > 18000 ? `${merged.slice(0, 18000)}\n...[context truncated]` : merged;
  const headings = extractHeadings(clipped);
  const keywords = topKeywords(clipped, 16);
  const lines = clipped.split("\n").filter((line) => line.trim());
  const keySnippets = lines.filter((line) => line.length >= 20).slice(0, 12);

  return {
    intentRaw: normalizeText(userInput),
    contextStats: {
      fileCount: fileContexts.length,
      contextChars: clipped.length,
      headingCount: headings.length
    },
    headings,
    keywords,
    keySnippets,
    contextBody: clipped
  };
}

function extractFirstJsonObject(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  return candidate.slice(firstBrace, lastBrace + 1);
}

function validateCompiledJson(parsed) {
  const requiredString = ["goal", "audience", "style", "contextSummary", "finalPrompt"];
  const requiredArray = ["constraints", "successCriteria", "checklist"];

  for (const key of requiredString) {
    if (!parsed || typeof parsed[key] !== "string" || !parsed[key].trim()) {
      return { ok: false, reason: `missing_or_invalid_${key}` };
    }
  }

  for (const key of requiredArray) {
    if (!parsed || !Array.isArray(parsed[key]) || parsed[key].length === 0) {
      return { ok: false, reason: `missing_or_invalid_${key}` };
    }
  }

  return { ok: true };
}

function describeUpstreamError(error) {
  const cause = error && error.cause ? error.cause : {};
  const code = cause.code || error.code || "UNKNOWN";
  const message = cause.message || (error && error.message ? error.message : String(error));
  return `upstream_connect_error(${code}): ${message}`;
}

function sanitizeFileName(name) {
  const base = String(name || "daymori-ppt").trim();
  const safe = base
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || "daymori-ppt";
}

function normalizeContract(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "contract_required" };
  }
  if (String(input.contractVersion || "") !== "aippt.v1") {
    return { ok: false, reason: "unsupported_contract_version" };
  }
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    return { ok: false, reason: "slides_required" };
  }

  const pageCount = Number(input.pageCount || input.slides.length);
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    return { ok: false, reason: "invalid_page_count" };
  }

  const slides = input.slides.map((s, i) => ({
    index: Number(s && s.index) || i + 1,
    title: String((s && s.title) || `第${i + 1}页`).trim(),
    goal: String((s && s.goal) || "").trim(),
    keyPoints: Array.isArray(s && s.keyPoints) ? s.keyPoints.map((x) => String(x || "").trim()).filter(Boolean) : [],
    assetPlaceholders: Array.isArray(s && s.assetPlaceholders) ? s.assetPlaceholders.map((x) => String(x || "").trim()).filter(Boolean) : [],
    speakerNotes: String((s && s.speakerNotes) || "").trim()
  }));

  return {
    ok: true,
    contract: {
      contractVersion: "aippt.v1",
      engineType: String(input.engineType || "generic-aippt"),
      sceneType: String(input.sceneType || "通用"),
      templateId: String(input.templateId || "template-default"),
      pageCount,
      visualStyle: String(input.visualStyle || "简洁商务风"),
      tone: String(input.tone || "清晰、可执行"),
      fontTheme: String(input.fontTheme || "business-cn"),
      chartStyle: String(input.chartStyle || "calm"),
      narrativeMode: String(input.narrativeMode || "standard"),
      topic: String(input.topic || "当前需求"),
      slides
    }
  };
}

function parseBase64Payload(value) {
  if (!value || typeof value !== "string") return Buffer.alloc(0);
  const raw = value.includes(",") ? value.split(",").pop() : value;
  return Buffer.from(raw, "base64");
}

function parseJsonSafe(text) {
  if (!text || typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getAipptExportConfig() {
  const provider = String(process.env.AIPPT_PROVIDER || "generic").toLowerCase().trim();
  const endpointRaw = String(process.env.AIPPT_API_ENDPOINT || "").trim();
  const apiKey = String(process.env.AIPPT_API_KEY || "").trim();
  const model = String(process.env.AIPPT_API_MODEL || "").trim();
  const authMode = String(process.env.AIPPT_API_AUTH_MODE || "bearer").toLowerCase().trim();
  const keyHeader = String(process.env.AIPPT_API_KEY_HEADER || "x-api-key").trim();
  const lazymanEndpoint = String(process.env.LAZYMAN_API_ENDPOINT || "").trim();
  const extraHeaders = parseJsonSafe(process.env.AIPPT_API_EXTRA_HEADERS || "");
  const supportedProviders = new Set(["generic", "openai-compatible", "openai", "lazyman"]);

  if (!supportedProviders.has(provider)) {
    throw new Error(`Unsupported AIPPT_PROVIDER: ${provider}`);
  }

  if (!["bearer", "header", "none"].includes(authMode)) {
    throw new Error(`Unsupported AIPPT_API_AUTH_MODE: ${authMode}`);
  }

  const endpoint = endpointRaw
    || (provider === "openai" ? "https://api.openai.com/v1/chat/completions" : "")
    || (provider === "lazyman" ? lazymanEndpoint : "");

  return {
    provider,
    endpoint,
    apiKey,
    model,
    authMode,
    keyHeader: keyHeader || "x-api-key",
    extraHeaders: extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}
  };
}

function buildAipptHeaders(config) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (config.authMode === "bearer" && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (config.authMode === "header" && config.apiKey) {
    headers[config.keyHeader] = config.apiKey;
  }

  for (const [key, value] of Object.entries(config.extraHeaders || {})) {
    if (typeof value === "string" && key) {
      headers[key] = value;
    }
  }

  return headers;
}

function buildAipptRequestPayload(config, contract) {
  if (config.provider === "openai-compatible" || config.provider === "openai" || config.provider === "lazyman") {
    return {
      model: config.model || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: [
            "You are an AIPPT export adapter.",
            "Generate a PPTX file from the provided contract.",
            "Return JSON only, without markdown fences.",
            "JSON schema:",
            "{\"fileBase64\":\"...\",\"fileName\":\"...pptx\",\"mimeType\":\"application/vnd.openxmlformats-officedocument.presentationml.presentation\"}",
            "You may return downloadUrl instead of fileBase64 if supported."
          ].join("\\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "export_contract_to_pptx",
            contractVersion: contract.contractVersion,
            contract
          })
        }
      ],
      temperature: 0.1
    };
  }

  return {
    model: config.model || undefined,
    contractVersion: contract.contractVersion,
    contract
  };
}

function parseAipptResponsePayload(config, data) {
  if (config.provider === "openai-compatible" || config.provider === "openai" || config.provider === "lazyman") {
    const content = extractChatText(data);
    const jsonText = extractFirstJsonObject(content || "");
    if (!jsonText) return { ok: false, reason: "aippt_openai_no_json_payload" };
    try {
      return { ok: true, payload: JSON.parse(jsonText) };
    } catch {
      return { ok: false, reason: "aippt_openai_json_parse_error" };
    }
  }

  return { ok: true, payload: data || {} };
}

async function callAipptEngine(contract, config) {
  const endpoint = config.endpoint;
  const apiKey = config.apiKey;

  const requiresApiKey = config.authMode !== "none";
  if (!endpoint || (requiresApiKey && !apiKey)) {
    return { ok: false, reason: "aippt_not_configured" };
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: buildAipptHeaders(config),
      body: JSON.stringify(buildAipptRequestPayload(config, contract))
    });
  } catch (error) {
    return { ok: false, reason: sanitizeAuditDetail(describeUpstreamError(error)) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return { ok: false, reason: `aippt_http_${upstream.status}:${sanitizeAuditDetail(rawText)}` };
  }

  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    return { ok: false, reason: "aippt_non_json_response" };
  }

  const parsedPayload = parseAipptResponsePayload(config, data);
  if (!parsedPayload.ok) {
    return { ok: false, reason: parsedPayload.reason };
  }

  const payload = parsedPayload.payload;

  if (payload.downloadUrl) {
    try {
      const fileResp = await fetch(String(payload.downloadUrl));
      if (!fileResp.ok) return { ok: false, reason: `aippt_download_${fileResp.status}` };
      const arr = await fileResp.arrayBuffer();
      return {
        ok: true,
        engine: `upstream-aippt-${config.provider}`,
        fileName: String(payload.fileName || `${sanitizeFileName(contract.topic)}.pptx`),
        mimeType: String(payload.mimeType || "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        buffer: Buffer.from(arr)
      };
    } catch (error) {
      return { ok: false, reason: sanitizeAuditDetail(describeUpstreamError(error)) };
    }
  }

  const b64 = payload.fileBase64 || payload.pptxBase64 || "";
  const bin = parseBase64Payload(b64);
  if (!bin.length) {
    return { ok: false, reason: "aippt_no_file_payload" };
  }

  return {
    ok: true,
    engine: `upstream-aippt-${config.provider}`,
    fileName: String(payload.fileName || `${sanitizeFileName(contract.topic)}.pptx`),
    mimeType: String(payload.mimeType || "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    buffer: bin
  };
}

async function buildLocalPptx(contract) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Daymori";
  pptx.company = "Daymori";
  pptx.subject = contract.sceneType;
  pptx.title = `${contract.topic} - ${contract.sceneType}`;

  const narrativeMode = String(contract.narrativeMode || "standard");

  const standardPalette = {
    bg: "F6F1EA",
    panel: "FFFFFF",
    panelSoft: "EFE7DB",
    line: "DCCBB6",
    title: "17191F",
    text: "1F2937",
    muted: "5B6472",
    accent: "8B5E34",
    accentSoft: "EBDDCB"
  };

  const lazymanPalette = {
    bg: "111111",
    panel: "181614",
    panelSoft: "25211D",
    line: "4A3A2D",
    title: "F5E7D8",
    text: "E9D7C3",
    muted: "B79E83",
    accent: "7A5130",
    accentSoft: "2E241D"
  };

  const palette = narrativeMode === "lazyman" ? lazymanPalette : standardPalette;

  const fontTheme = String(contract.fontTheme || "business-cn");
  const chartStyle = String(contract.chartStyle || "calm");
  const fontMap = {
    "business-cn": { title: "Microsoft YaHei", body: "Microsoft YaHei" },
    "serif-cn": { title: "SimSun", body: "SimSun" },
    "modern-cn": { title: "Microsoft JhengHei", body: "Microsoft YaHei" }
  };
  const fontPack = fontMap[fontTheme] || fontMap["business-cn"];

  const chartStyleMap = {
    calm: { color: palette.accent, symbol: "circle" },
    contrast: { color: "345F8A", symbol: "diamond" },
    growth: { color: "2E7D57", symbol: "triangle" }
  };
  const chartPack = chartStyleMap[chartStyle] || chartStyleMap.calm;

  const storyLabels = narrativeMode === "lazyman"
    ? ["董事会摘要", "关键目标", "数据证据", "问题归因", "执行动作", "战略补充"]
    : ["封面总览", "目标对齐", "数据洞察", "问题归因", "行动落地", "补充说明"];

  function cleanText(value, fallback = "") {
    const raw = String(value || fallback).replace(/\s+/g, " ").trim();
    return raw || fallback;
  }

  function safeList(items, fallback) {
    const out = Array.isArray(items) ? items.map((x) => cleanText(x)).filter(Boolean) : [];
    return out.length ? out : [fallback];
  }

  function shortText(text, max = 26) {
    const t = cleanText(text, "-");
    return t.length > max ? `${t.slice(0, max)}...` : t;
  }

  function extractNumericHints(slideSpec) {
    const source = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    const percentMatches = [...source.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    const numberMatches = [...source.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
    const values = [...percentMatches, ...numberMatches].filter((n) => n >= 0).slice(0, 6);
    return values;
  }

  function buildTakeaway(slideSpec) {
    const lead = cleanText(slideSpec.goal, "本页聚焦关键结论与行动");
    const first = safeList(slideSpec.keyPoints, "形成统一执行口径")[0];
    return `本页结论：${lead}；关键抓手：${first}`;
  }

  function isDataLikeSlide(slideSpec, pageIndex) {
    if (pageIndex === 3 || pageIndex === 4) return true;
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(数据|趋势|同比|环比|增长|收入|成本|转化|问题|风险|指标)/.test(text);
  }

  function isStrategyLikeSlide(slideSpec) {
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(策略|路径|实施|里程碑|试点|验收|预算|资源)/.test(text);
  }

  function isDecisionLikeSlide(slideSpec, pageIndex, totalSlides) {
    if (pageIndex === totalSlides) return true;
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(决策|下一步|拍板|行动建议|请求)/.test(text);
  }

  function chartSpecForSlide(slideSpec, pageIndex) {
    const labels = safeList(slideSpec.keyPoints, "关键指标").slice(0, 3).map((x) => shortText(x, 12));
    const hinted = extractNumericHints(slideSpec).slice(0, 3);
    let values = hinted;
    if (values.length < labels.length) {
      const base = pageIndex === 4 ? [42, 31, 21] : [58, 66, 74];
      values = [...values, ...base].slice(0, labels.length);
    }
    values = values.map((n, i) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return 40 + i * 12;
      if (v > 1000) return Math.round(v / 1000);
      return Math.max(5, Math.round(v));
    });

    const type = pageIndex === 4 ? pptx.ChartType.bar : pptx.ChartType.line;
    return {
      type,
      labels,
      values,
      seriesName: pageIndex === 4 ? "问题影响度" : "核心指标趋势"
    };
  }

  function addFooter(slide, index, total) {
    slide.addShape(pptx.ShapeType.line, {
      x: 0.6,
      y: 6.92,
      w: 12.1,
      h: 0,
      line: { color: palette.line, pt: 1 }
    });

    slide.addText(cleanText(contract.topic, "Daymori 演示文稿"), {
      x: 0.62,
      y: 6.95,
      w: 8.6,
      h: 0.28,
      fontSize: 9,
      color: palette.muted,
      fontFace: fontPack.body
    });

    slide.addText(`${index}/${total}`, {
      x: 11.95,
      y: 6.95,
      w: 0.8,
      h: 0.28,
      align: "right",
      fontSize: 9,
      color: palette.muted,
      fontFace: fontPack.body
    });
  }

  const totalSlides = contract.slides.length;
  for (const slideSpec of contract.slides) {
    const slide = pptx.addSlide();
    const pageIndex = Number(slideSpec.index) || 1;
    const title = cleanText(slideSpec.title, `第${pageIndex}页`);
    const goal = cleanText(slideSpec.goal, "明确本页目标并输出可执行内容");
    const keyPoints = safeList(slideSpec.keyPoints, "补充关键业务要点").slice(0, 4);
    const assets = safeList(slideSpec.assetPlaceholders, "补充图表或配图").slice(0, 4);
    const notes = cleanText(slideSpec.speakerNotes, "先结论，再依据，最后行动建议。") || "-";
    const takeaway = buildTakeaway(slideSpec);
    const dataLike = isDataLikeSlide(slideSpec, pageIndex);

    slide.background = { color: palette.bg };

    const isCover = pageIndex === 1;
    if (isCover) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.62,
        y: 0.52,
        w: 12.1,
        h: 5.9,
        radius: 0.09,
        fill: { color: palette.panel },
        line: { color: palette.line, pt: 1.2 }
      });

      slide.addShape(pptx.ShapeType.rect, {
        x: 0.62,
        y: 0.52,
        w: 12.1,
        h: 0.2,
        fill: { color: palette.accent }
      });

      slide.addText(cleanText(contract.sceneType, "企业汇报"), {
        x: 1.0,
        y: 1.15,
        w: 4.8,
        h: 0.36,
        fontSize: 13,
        bold: true,
        color: palette.accent,
        fontFace: fontPack.body
      });

      slide.addText(storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] || "封面总览", {
        x: 5.95,
        y: 1.2,
        w: 5.95,
        h: 0.34,
        align: "right",
        fontSize: 11,
        color: palette.muted,
        fontFace: fontPack.body
      });

      slide.addText(title, {
        x: 1.0,
        y: 1.62,
        w: 10.9,
        h: 1.35,
        fontSize: 39,
        bold: true,
        color: palette.title,
        fontFace: fontPack.title,
        valign: "top"
      });

      slide.addText(goal, {
        x: 1.0,
        y: 3.2,
        w: 10.9,
        h: 0.9,
        fontSize: 16,
        color: palette.text,
        fontFace: fontPack.body
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: 1.0,
        y: 4.35,
        w: 10.9,
        h: 1.25,
        radius: 0.06,
        fill: { color: palette.accentSoft },
        line: { color: palette.line, pt: 1 }
      });

      slide.addText(`关键要点：${keyPoints.join(" ｜ ")}`, {
        x: 1.25,
        y: 4.72,
        w: 10.45,
        h: 0.5,
        fontSize: 12,
        color: palette.text,
        fontFace: fontPack.body
      });

      slide.addText(takeaway, {
        x: 1.0,
        y: 5.76,
        w: 10.9,
        h: 0.38,
        fontSize: 11,
        color: palette.muted,
        fontFace: fontPack.body
      });
    } else {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.62,
        y: 0.52,
        w: 12.1,
        h: 6.15,
        radius: 0.09,
        fill: { color: palette.panel },
        line: { color: palette.line, pt: 1.2 }
      });

      slide.addText(title, {
        x: 0.95,
        y: 0.82,
        w: 8.2,
        h: 0.5,
        fontSize: 25,
        bold: true,
        color: palette.title,
        fontFace: fontPack.title
      });

      slide.addText(storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] || "补充说明", {
        x: 9.0,
        y: 1.29,
        w: 2.9,
        h: 0.22,
        align: "right",
        fontSize: 9,
        color: palette.muted,
        fontFace: fontPack.body
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: 9.5,
        y: 0.78,
        w: 2.6,
        h: 0.48,
        radius: 0.08,
        fill: { color: palette.panelSoft },
        line: { color: palette.line, pt: 1 }
      });

      slide.addText(`目标：${goal.slice(0, 36)}`, {
        x: 9.66,
        y: 0.9,
        w: 2.26,
        h: 0.26,
        align: "center",
        fontSize: 10,
        color: palette.accent,
        fontFace: fontPack.body
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.95,
        y: 1.52,
        w: 7.52,
        h: 3.9,
        radius: 0.06,
        fill: { color: "FBFAF8" },
        line: { color: palette.line, pt: 1 }
      });

      slide.addText(takeaway, {
        x: 1.2,
        y: 1.62,
        w: 6.95,
        h: 0.38,
        fontSize: 10,
        bold: true,
        color: palette.accent,
        fontFace: fontPack.body
      });

      const strategyLike = isStrategyLikeSlide(slideSpec);
      const decisionLike = isDecisionLikeSlide(slideSpec, pageIndex, totalSlides);

      keyPoints.forEach((point, i) => {
        const y = 2.06 + i * 0.8;
        const blockColor = decisionLike ? (i % 2 === 0 ? "F8EFE6" : "F4E4D4") : (i % 2 === 0 ? "FFFFFF" : "F6F1EA");
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 1.2,
          y,
          w: 6.95,
          h: 0.66,
          radius: 0.05,
          fill: { color: blockColor },
          line: { color: "E6DCCF", pt: 0.8 }
        });

        slide.addText(`0${i + 1}`, {
          x: 1.34,
          y: y + 0.18,
          w: 0.35,
          h: 0.2,
          fontSize: 9,
          bold: true,
          color: palette.accent,
          fontFace: fontPack.body
        });

        slide.addText(point.slice(0, 60), {
          x: 1.78,
          y: y + 0.12,
          w: 6.2,
          h: 0.4,
          fontSize: 13,
          color: palette.text,
          fontFace: fontPack.body
        });
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: 8.75,
        y: 1.52,
        w: 3.32,
        h: 3.9,
        radius: 0.06,
        fill: { color: palette.panelSoft },
        line: { color: palette.line, pt: 1 }
      });

      slide.addText("建议素材", {
        x: 9.0,
        y: 1.76,
        w: 2.8,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: palette.accent,
        fontFace: fontPack.body
      });

      if (dataLike) {
        const c = chartSpecForSlide(slideSpec, pageIndex);
        slide.addChart(
          c.type,
          [
            {
              name: c.seriesName,
              labels: c.labels,
              values: c.values
            }
          ],
          {
            x: 8.95,
            y: 3.1,
            w: 2.95,
            h: 1.95,
            showLegend: false,
            valAxisTitle: "指数",
            catAxisLabelRotate: -25,
            valAxisMinVal: 0,
            valAxisMaxVal: Math.max(100, ...c.values) + 10,
            chartColors: [chartPack.color],
            lineSize: 2,
            lineDataSymbol: chartPack.symbol
          }
        );
      }

      if (strategyLike) {
        slide.addShape(pptx.ShapeType.line, {
          x: 1.2,
          y: 4.72,
          w: 6.95,
          h: 0,
          line: { color: palette.accent, pt: 1.4 }
        });
        slide.addText("执行里程碑：M1 方案确认 -> M2 试点落地 -> M3 规模推广", {
          x: 1.2,
          y: 4.8,
          w: 6.9,
          h: 0.32,
          fontSize: 10.5,
          bold: true,
          color: palette.accent,
          fontFace: fontPack.body
        });
      }

      if (decisionLike) {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 8.85,
          y: 5.52,
          w: 3.2,
          h: 0.96,
          radius: 0.08,
          fill: { color: palette.accentSoft },
          line: { color: palette.accent, pt: 1 }
        });
        slide.addText("管理层决策请求\n批准试点预算与跨部门协同机制", {
          x: 9.02,
          y: 5.72,
          w: 2.85,
          h: 0.56,
          fontSize: 10,
          bold: true,
          color: palette.accent,
          fontFace: fontPack.body
        });
      }

      assets.forEach((asset, i) => {
        slide.addText(`• ${asset.slice(0, 20)}`, {
          x: 9.0,
          y: 2.1 + i * 0.34,
          w: 2.85,
          h: 0.25,
          fontSize: 10.5,
          color: palette.text,
          fontFace: fontPack.body
        });
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.95,
        y: 5.52,
        w: 11.12,
        h: 0.96,
        radius: 0.05,
        fill: { color: "F2EEE8" },
        line: { color: palette.line, pt: 1 }
      });

      slide.addText(`演讲备注：${notes.slice(0, 120)}`, {
        x: 1.15,
        y: 5.84,
        w: 10.72,
        h: 0.44,
        fontSize: 10.5,
        color: palette.muted,
        fontFace: fontPack.body
      });
    }

    addFooter(slide, pageIndex, totalSlides);
  }

  const stream = await pptx.write({ outputType: "nodebuffer" });
  return {
    ok: true,
    engine: "local-pptxgenjs",
    fileName: `${sanitizeFileName(contract.topic)}.pptx`,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(stream)
  };
}

async function buildPptExportResult(contract) {
  const exportConfig = getAipptExportConfig();
  let result = await callAipptEngine(contract, exportConfig);
  if (!result.ok) {
    result = await buildLocalPptx(contract);
    result.fallbackReason = result.fallbackReason || "upstream_unavailable";
  }
  return {
    result,
    exportConfig
  };
}

function saveExportedPptToWorkspace(contract, result) {
  const dir = path.join(__dirname, "docs", "benchmarks", "results", "exports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const fileName = `${stamp}-${sanitizeFileName(contract.topic || "daymori-ppt")}.pptx`;
  const absPath = path.join(dir, fileName);
  fs.writeFileSync(absPath, result.buffer);
  const relPath = path.relative(__dirname, absPath).replace(/\\/g, "/");
  return { fileName, absPath, relPath };
}

async function callProviderText({ providerConfig, systemPrompt, userPrompt, maxTokens = 520 }) {
  if (providerConfig.type === "responses") {
    let upstream;
    try {
      upstream = await fetch(providerConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerConfig.apiKey}`
        },
        body: JSON.stringify({
          model: providerConfig.model,
          input: `${systemPrompt}\n\n${userPrompt}`,
          max_output_tokens: maxTokens
        })
      });
    } catch (error) {
      return { ok: false, status: 502, detail: describeUpstreamError(error) };
    }

    const rawText = await upstream.text();
    if (!upstream.ok) return { ok: false, status: upstream.status, detail: rawText.slice(0, 1200) };

    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      return { ok: false, status: 502, detail: `上游返回非JSON: ${rawText.slice(0, 300)}` };
    }

    return { ok: true, text: data.output_text || "", raw: data };
  }

  let upstream;
  try {
    upstream = await fetch(providerConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerConfig.apiKey}`
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      })
    });
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) return { ok: false, status: upstream.status, detail: rawText.slice(0, 1200) };

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, status: 502, detail: `上游返回非JSON: ${rawText.slice(0, 300)}` };
  }

  return { ok: true, text: extractChatText(data), raw: data };
}

async function compilePromptWithRetry({ providerConfig, ingestorPack }) {
  const systemPrompt = [
    "你是语义编译器（Semantic Compiler），不是聊天助手。",
    "任务：将用户意图+文件骨架编译为高质量可直接执行的提示词。",
    "只允许输出严格 JSON，不要输出解释、markdown、代码块、前后缀。",
    "禁止输出推理过程。"
  ].join("\n");

  const schemaSpec = [
    "JSON字段必须完整：",
    "goal: string",
    "audience: string",
    "style: string",
    "constraints: string[] (4-8条)",
    "successCriteria: string[] (3-6条)",
    "contextSummary: string (120-240字)",
    "finalPrompt: string (可直接复制使用)",
    "checklist: string[] (4-8条)"
  ].join("\n");

  const baseUserPrompt = [
    "[INTENT]",
    ingestorPack.intentRaw || "用户仅上传文件，未写额外意图",
    "",
    "[CONTEXT_STATS]",
    JSON.stringify(ingestorPack.contextStats, null, 2),
    "",
    "[HEADINGS]",
    ingestorPack.headings.join("\n") || "(none)",
    "",
    "[KEYWORDS]",
    ingestorPack.keywords.join(", ") || "(none)",
    "",
    "[KEY_SNIPPETS]",
    ingestorPack.keySnippets.join("\n") || "(none)",
    "",
    "[CONTEXT_BODY]",
    ingestorPack.contextBody,
    "",
    schemaSpec
  ].join("\n");

  let lastReason = "unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryHint = attempt === 0 ? "" : `\n\n上一次输出不合规，原因: ${lastReason}。请只输出合规 JSON。`;
    const result = await callProviderText({
      providerConfig,
      systemPrompt,
      userPrompt: `${baseUserPrompt}${retryHint}`,
      maxTokens: 800
    });

    if (!result.ok) {
      return result;
    }

    const jsonText = extractFirstJsonObject(result.text);
    if (!jsonText) {
      lastReason = "no_json_object";
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      lastReason = "json_parse_error";
      continue;
    }

    const valid = validateCompiledJson(parsed);
    if (!valid.ok) {
      lastReason = valid.reason;
      continue;
    }

    return { ok: true, compiled: parsed, raw: result.raw, compileRetries: attempt };
  }

  return { ok: false, status: 422, detail: `结构化编译失败: ${lastReason}` };
}

async function callChatCompletions({ endpoint, apiKey, model, input }) {
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是高信息密度助手，回答要清晰、可执行、低废话。" },
          { role: "user", content: input }
        ],
        temperature: 0.2,
        max_tokens: 420
      })
    });
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, detail: rawText.slice(0, 1200) };
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, status: 502, detail: `上游返回非JSON: ${rawText.slice(0, 300)}` };
  }

  return { ok: true, data, text: extractChatText(data) };
}

async function callResponses({ endpoint, apiKey, model, input }) {
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input,
        max_output_tokens: 420
      })
    });
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, detail: rawText.slice(0, 1200) };
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return { ok: false, status: 502, detail: `上游返回非JSON: ${rawText.slice(0, 300)}` };
  }

  return { ok: true, data, text: data.output_text || "" };
}

app.get("/api/audit/status", (req, res) => {
  return res.json({
    ok: true,
    auditEnabled: AUDIT_LOG_ENABLED,
    auditLogFile: AUDIT_LOG_FILE,
    allowedOriginsCount: ALLOWED_ORIGINS.length
  });
});

app.post("/api/llm-proxy", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const providerConfig = getProviderConfig();
    if (!providerConfig.apiKey) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 500,
        latencyMs: Date.now() - startedAt,
        reason: `missing_${providerConfig.keyEnv}`
      });
      return res.status(500).json({
        error: "Missing API key",
        detail: `服务端未配置 ${providerConfig.keyEnv}，请在 .env 中设置后重启服务`
      });
    }

    const system = req.body && typeof req.body.system === "string" ? req.body.system : "你是高信息密度助手，回答要清晰、可执行、低废话。";
    const userText = req.body && typeof req.body.userText === "string" ? req.body.userText : "";
    const maxTokensRaw = req.body && req.body.maxTokens ? Number(req.body.maxTokens) : 850;
    const maxTokens = Number.isFinite(maxTokensRaw) ? Math.min(Math.max(maxTokensRaw, 80), 1200) : 850;

    if (!userText.trim()) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: "empty_user_text"
      });
      return res.status(400).json({ error: "userText is required" });
    }

    let result;
    if (providerConfig.type === "responses") {
      result = await callResponses({
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        input: `${system}\n\n${userText}`
      });
    } else {
      result = await callChatCompletions({
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        input: userText
      });
    }

    if (!result.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: result.status,
        model: providerConfig.model,
        latencyMs: Date.now() - startedAt,
        promptChars: userText.length,
        reason: sanitizeAuditDetail(result.detail)
      });
      return res.status(result.status).json({
        error: `${providerConfig.provider} API error`,
        detail: result.detail
      });
    }

    const text = typeof result.text === "string" ? result.text : "";
    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      model: providerConfig.model,
      latencyMs: Date.now() - startedAt,
      promptChars: userText.length,
      outputChars: text.length
    });

    return res.json({
      text,
      provider: providerConfig.provider,
      model: providerConfig.model
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(error && error.message ? error.message : String(error))
    });
    return res.status(500).json({
      error: "Server error",
      detail: error && error.message ? error.message : String(error)
    });
  }
});

app.post("/api/chat", upload.array("files", 2), async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const providerConfig = getProviderConfig();
    if (!providerConfig.apiKey) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 500,
        latencyMs: Date.now() - startedAt,
        reason: `missing_${providerConfig.keyEnv}`
      });
      return res.status(500).json({
        error: "Missing API key",
        detail: `服务端未配置 ${providerConfig.keyEnv}，请在 .env 中设置后重启服务`
      });
    }

    const userInput = (req.body && req.body.message ? String(req.body.message) : "").trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!userInput && files.length === 0) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: "empty_input_and_files"
      });
      return res.status(400).json({ error: "message or files is required" });
    }

    const fileContexts = await Promise.all(
      files.map(async (file, i) => {
        const content = await parseUploadedFile(file);
        const clipped = content.length > 12000 ? `${content.slice(0, 12000)}\n...[已截断]` : content;
        const name = file && file.originalname ? String(file.originalname) : `file-${i + 1}`;
        return `文件${i + 1}: ${name}\n${clipped}`;
      })
    );

    const ingestorPack = buildIngestorPack({ userInput, fileContexts });
    const result = await compilePromptWithRetry({ providerConfig, ingestorPack });

    if (!result.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: result.status,
        model: providerConfig.model,
        latencyMs: Date.now() - startedAt,
        promptChars: userInput.length,
        fileCount: files.length,
        reason: sanitizeAuditDetail(result.detail)
      });
      return res.status(result.status).json({
        error: `${providerConfig.provider} API error`,
        detail: result.detail
      });
    }

    const compiled = result.compiled;
    const displayText = [
      `目标: ${compiled.goal}`,
      `受众: ${compiled.audience}`,
      `风格: ${compiled.style}`,
      "",
      "最终提示词:",
      compiled.finalPrompt
    ].join("\n");

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      model: providerConfig.model,
      latencyMs: Date.now() - startedAt,
      promptChars: userInput.length,
      fileCount: files.length,
      outputChars: compiled.finalPrompt.length,
      compileRetries: result.compileRetries
    });

    return res.json({
      text: displayText,
      compiled,
      compileRetries: result.compileRetries,
      provider: providerConfig.provider,
      model: providerConfig.model,
      raw: result.raw
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(error && error.message ? error.message : String(error))
    });
    return res.status(500).json({
      error: "Server error",
      detail: error && error.message ? error.message : String(error)
    });
  }
});

app.post("/api/ppt/export", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const normalized = normalizeContract(req.body && req.body.contract);
    if (!normalized.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: normalized.reason
      });
      return res.status(400).json({ error: "invalid_contract", detail: normalized.reason });
    }

    const contract = normalized.contract;
    const { result, exportConfig } = await buildPptExportResult(contract);

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      latencyMs: Date.now() - startedAt,
      model: exportConfig.model || "local-pptxgenjs",
      promptChars: JSON.stringify(contract).length,
      outputChars: result.buffer.length,
      pptEngine: result.engine,
      aipptProvider: exportConfig.provider,
      templateId: contract.templateId
    });

    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFileName(result.fileName)}"`);
    res.setHeader("x-ppt-engine", result.engine);
    return res.status(200).send(result.buffer);
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(error && error.message ? error.message : String(error))
    });
    return res.status(500).json({ error: "ppt_export_error", detail: error && error.message ? error.message : String(error) });
  }
});

app.post("/api/ppt/export-save", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const normalized = normalizeContract(req.body && req.body.contract);
    if (!normalized.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: normalized.reason
      });
      return res.status(400).json({ error: "invalid_contract", detail: normalized.reason });
    }

    const contract = normalized.contract;
    const { result, exportConfig } = await buildPptExportResult(contract);
    const saved = saveExportedPptToWorkspace(contract, result);

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      latencyMs: Date.now() - startedAt,
      model: exportConfig.model || "local-pptxgenjs",
      promptChars: JSON.stringify(contract).length,
      outputChars: result.buffer.length,
      pptEngine: result.engine,
      aipptProvider: exportConfig.provider,
      templateId: contract.templateId,
      detail: `saved:${saved.relPath}`
    });

    return res.json({
      ok: true,
      engine: result.engine,
      fileName: saved.fileName,
      relativePath: saved.relPath,
      absolutePath: saved.absPath,
      bytes: result.buffer.length
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(error && error.message ? error.message : String(error))
    });
    return res.status(500).json({ error: "ppt_export_save_error", detail: error && error.message ? error.message : String(error) });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "upload too large",
        detail: "单个文件超过 15MB，请压缩后重试"
      });
    }
    return res.status(400).json({
      error: "upload failed",
      detail: err.message
    });
  }

  if (err) {
    return res.status(500).json({
      error: "upload server error",
      detail: err.message || String(err)
    });
  }

  return next();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
