const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const multer = require("multer");
const mammoth = require("mammoth");
const cors = require("cors");
const crypto = require("crypto");
const os = require("os");
const { spawnSync, spawn } = require("child_process");
const PptxGenJS = require("pptxgenjs");
const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AUDIT_LOG_ENABLED = String(process.env.AUDIT_LOG_ENABLED || "true").toLowerCase() !== "false";
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(__dirname, "logs");
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, "audit.log");
const AUDIT_SALT = process.env.AUDIT_SALT || "daymori-audit-salt";
const LLM_FETCH_TIMEOUT_MS = Number(process.env.LLM_FETCH_TIMEOUT_MS || 20000);
const LLM_FETCH_RETRY = Number(process.env.LLM_FETCH_RETRY || 1);

async function fetchWithRetry(url, options, retries = 0) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (i === retries) throw error;
    }
  }
  throw lastError;
}

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

app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: corsOriginHandler }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});
app.use("/games", express.static(path.join(__dirname, "games")));
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "docs", "index.html"));
});

app.get("/fighter", (req, res) => {
  res.sendFile(path.join(__dirname, "games", "fighter", "index.html"));
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
  const zhipuModel = (process.env.ZHIPU_MODEL || "").trim();

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
      model: zhipuModel || "glm-5.2"
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

// GLM-4.5/4.6/Z 系列是思考型模型：默认会把 token 预算烧在 reasoning_content 上，
// 导致正式 content 返回空/半截，应用只能退回本地骨架内容。关闭 thinking 后可直接
// 拿到高质量正文。对不支持该参数的模型返回空对象，避免 400。
function buildThinkingExtras(model) {
  if (/^glm-(4\.5|4\.6|z)/i.test(String(model || ""))) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

function extractChatText(data) {
  const choice = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message : null;
  const message = choice ? choice.content : "";
  if (typeof message === "string") {
    const t = message.trim();
    // 思考模型即便关闭 thinking 仍可能偶发把正文放进 reasoning_content，做一次兜底回退。
    if (t) return message;
    if (choice && typeof choice.reasoning_content === "string") return choice.reasoning_content;
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

const MOJIBAKE_PATTERN = /(?:锛|鏄|瀵|琛|缁|鍔|鎴|璇|鎬|琚|闂|銆|鈥|锝|锟�|�)/g;

function countMojibakeTokens(text) {
  const m = String(text || "").match(MOJIBAKE_PATTERN);
  return m ? m.length : 0;
}

function countZhChars(text) {
  const m = String(text || "").match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function scoreReadableText(text) {
  const value = String(text || "");
  const zh = countZhChars(value);
  const bad = countMojibakeTokens(value);
  const replacement = (value.match(/�/g) || []).length;
  return zh - bad * 2 - replacement * 3;
}

function tryRepairMojibakeText(input) {
  const original = String(input || "");
  if (!original) return "";
  if (countMojibakeTokens(original) < 2) return original;
  try {
    const repaired = iconv.decode(iconv.encode(original, "gbk"), "utf8");
    if (!repaired || repaired === original) return original;
    return scoreReadableText(repaired) > scoreReadableText(original) + 1 ? repaired : original;
  } catch {
    return original;
  }
}

function sanitizeContractText(value, maxLen = 0) {
  let text = normalizeText(value);
  if (!text) return "";
  text = text
    .replace(/<\/?[a-z]+:[^>]*>/gi, " ")
    .replace(/\/[a-z]+:[a-z]+>/gi, " ")
    .replace(/<[^>]{1,220}>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = tryRepairMojibakeText(text);
  if (maxLen > 0 && text.length > maxLen) {
    return `${text.slice(0, maxLen)}…`;
  }
  return text;
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

function getOfficeplusTemplateInboxDir() {
  return path.join(__dirname, "docs", "benchmarks", "templates", "inbox");
}

function getOfficeplusPickUrl() {
  const raw = String(process.env.OFFICEPLUS_PICK_URL || "").trim();
  return raw || "https://www.officeplus.cn/Template/Home.shtml";
}

function ensureOfficeplusTemplateInboxDir() {
  const dir = getOfficeplusTemplateInboxDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listInboxPptxFiles() {
  const dir = ensureOfficeplusTemplateInboxDir();
  const files = fs.readdirSync(dir)
    .map((name) => {
      const absPath = path.join(dir, name);
      const stat = fs.statSync(absPath);
      return { name, absPath, stat };
    })
    .filter((x) => x.stat && x.stat.isFile() && /\.pptx$/i.test(x.name));
  return files.sort((a, b) => Number(b.stat.mtimeMs || 0) - Number(a.stat.mtimeMs || 0));
}

function getLatestInboxPptxFile() {
  const files = listInboxPptxFiles();
  return files.length ? files[0] : null;
}

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/g, "''");
}

function buildPowerPointLaunchScript(officeplusUrl, inboxDir) {
  const ppCandidates = [
    "powerpnt.exe",
    path.join(process.env.ProgramFiles || "", "Microsoft Office", "root", "Office16", "POWERPNT.EXE"),
    path.join(process.env.ProgramFiles || "", "Microsoft Office", "Office16", "POWERPNT.EXE"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft Office", "root", "Office16", "POWERPNT.EXE"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft Office", "Office16", "POWERPNT.EXE")
  ].filter(Boolean);

  const candidateExpr = ppCandidates.map((x) => `'${escapePowerShellSingleQuoted(x)}'`).join(", ");
  const safeUrl = escapePowerShellSingleQuoted(officeplusUrl);
  const safeInbox = escapePowerShellSingleQuoted(inboxDir);

  return [
    "$ErrorActionPreference = 'Stop'",
    "$result = [ordered]@{",
    "  powerPoint = [ordered]@{ ok = $false; mode = ''; detail = '' }",
    "  officeplus = [ordered]@{ ok = $false; detail = '' }",
    "  inbox = [ordered]@{ ok = $false; detail = '' }",
    "}",
    `$ppCandidates = @(${candidateExpr})`,
    "foreach ($candidate in $ppCandidates) {",
    "  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
    "  try {",
    "    $p = Start-Process -FilePath $candidate -PassThru",
    "    $result.powerPoint.ok = $true",
    "    $result.powerPoint.mode = 'process'",
    "    $result.powerPoint.detail = ('started:' + $p.Id + ':' + $candidate)",
    "    break",
    "  } catch {",
    "    continue",
    "  }",
    "}",
    "if (-not $result.powerPoint.ok) {",
    "  try {",
    "    $pp = New-Object -ComObject PowerPoint.Application",
    "    $pp.Visible = $true",
    "    $result.powerPoint.ok = $true",
    "    $result.powerPoint.mode = 'com'",
    "    $result.powerPoint.detail = 'com-visible'",
    "  } catch {",
    "    $result.powerPoint.detail = $_.Exception.Message",
    "  }",
    "}",
    "try {",
    `  Start-Process -FilePath '${safeUrl}' | Out-Null`,
    "  $result.officeplus.ok = $true",
    "  $result.officeplus.detail = 'opened'",
    "} catch {",
    "  $result.officeplus.detail = $_.Exception.Message",
    "}",
    "try {",
    `  Start-Process -FilePath explorer.exe -ArgumentList '${safeInbox}' | Out-Null`,
    "  $result.inbox.ok = $true",
    "  $result.inbox.detail = 'opened'",
    "} catch {",
    "  $result.inbox.detail = $_.Exception.Message",
    "}",
    "$result | ConvertTo-Json -Compress"
  ].join("\n");
}

function launchPowerPointAndOpenInbox() {
  if (process.platform !== "win32") {
    return { ok: false, reason: "windows_only" };
  }
  const inboxDir = ensureOfficeplusTemplateInboxDir();
  const officeplusUrl = getOfficeplusPickUrl();
  try {
    const script = buildPowerPointLaunchScript(officeplusUrl, inboxDir);
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      script
    ], {
      encoding: "utf8",
      windowsHide: true
    });

    const stdout = String(result && result.stdout ? result.stdout : "").trim();
    const stderr = String(result && result.stderr ? result.stderr : "").trim();

    if (result.status !== 0 || !stdout) {
      const detail = stderr || stdout || "no_output";
      return {
        ok: false,
        reason: `open_powerpoint_failed:${sanitizeAuditDetail(detail)}`,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path.relative(__dirname, inboxDir).replace(/\\/g, "/")
      };
    }

    let launchStatus = null;
    try {
      launchStatus = JSON.parse(stdout);
    } catch (error) {
      return {
        ok: false,
        reason: `open_powerpoint_failed:invalid_script_output:${sanitizeAuditDetail(stdout)}`,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path.relative(__dirname, inboxDir).replace(/\\/g, "/")
      };
    }

    const powerPointOk = !!(launchStatus && launchStatus.powerPoint && launchStatus.powerPoint.ok);
    const officeplusOk = !!(launchStatus && launchStatus.officeplus && launchStatus.officeplus.ok);
    const inboxOk = !!(launchStatus && launchStatus.inbox && launchStatus.inbox.ok);
    if (!powerPointOk || !officeplusOk || !inboxOk) {
      return {
        ok: false,
        reason: `open_powerpoint_failed:${sanitizeAuditDetail(JSON.stringify(launchStatus))}`,
        launchStatus,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path.relative(__dirname, inboxDir).replace(/\\/g, "/")
      };
    }

    return {
      ok: true,
      inboxDir,
      officeplusUrl,
      inboxRelativePath: path.relative(__dirname, inboxDir).replace(/\\/g, "/"),
      launchStatus
    };
  } catch (error) {
    return {
      ok: false,
      reason: `open_powerpoint_failed:${sanitizeAuditDetail(error && error.message ? error.message : String(error))}`
    };
  }
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
    title: sanitizeContractText((s && s.title) || `第${i + 1}页`, 96),
    goal: sanitizeContractText((s && s.goal) || "", 260),
    layoutType: String((s && s.layoutType) || "").trim(),
    keyPoints: Array.isArray(s && s.keyPoints)
      ? s.keyPoints.map((x) => sanitizeContractText(x, 120)).filter(Boolean)
      : [],
    assetPlaceholders: Array.isArray(s && s.assetPlaceholders)
      ? s.assetPlaceholders.map((x) => sanitizeContractText(x, 80)).filter(Boolean)
      : [],
    speakerNotes: sanitizeContractText((s && s.speakerNotes) || "", 520)
  }));

  return {
    ok: true,
    contract: {
      contractVersion: "aippt.v1",
      engineType: String(input.engineType || "generic-aippt"),
      sceneType: String(input.sceneType || "通用"),
      templateId: String(input.templateId || "template-default"),
      templateSource: String(input.templateSource || "internal"),
      externalTemplateId: String(input.externalTemplateId || ""),
      externalTemplateName: String(input.externalTemplateName || ""),
      templateFileName: String(input.templateFileName || ""),
      templateFileBase64: String(input.templateFileBase64 || ""),
      pageCount,
      visualStyle: String(input.visualStyle || "简洁商务风"),
      tone: String(input.tone || "清晰、可执行"),
      fontTheme: String(input.fontTheme || "business-cn"),
      chartStyle: String(input.chartStyle || "calm"),
      narrativeMode: String(input.narrativeMode || "standard"),
      topic: sanitizeContractText(input.topic || "当前需求", 140),
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

function isPowerPointComEnabled() {
  const raw = String(process.env.POWERPOINT_COM_ENABLED || "").trim().toLowerCase();
  if (!raw) return process.platform === "win32";
  return !["0", "false", "off", "no"].includes(raw);
}

function getPowerPointComTimeoutMs() {
  const n = Number(process.env.POWERPOINT_COM_TIMEOUT_MS || 120000);
  if (!Number.isFinite(n) || n < 10000) return 120000;
  return Math.min(n, 600000);
}

function probePowerPointComRuntime() {
  if (!isPowerPointComEnabled()) {
    return { ok: false, reason: "powerpoint_com_disabled" };
  }
  if (process.platform !== "win32") {
    return { ok: false, reason: "powerpoint_com_windows_only" };
  }

  const ps = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "$ErrorActionPreference='Stop'; $pp=New-Object -ComObject PowerPoint.Application; $pp.Quit(); 'ok'"
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });

  if (ps.error) {
    return { ok: false, reason: `powerpoint_com_probe_error:${sanitizeAuditDetail(ps.error.message || String(ps.error))}` };
  }
  if (ps.status !== 0) {
    const detail = sanitizeAuditDetail(String(ps.stderr || ps.stdout || `exit_${ps.status}`));
    return { ok: false, reason: `powerpoint_com_probe_failed:${detail}` };
  }
  return { ok: true, reason: "ok" };
}

// 纯 ASCII JSON：把所有非 ASCII 字符转成 \uXXXX，彻底规避 PowerShell 读取 payload
// 时的中文乱码问题（PS 会用 ConvertFrom-Json 解回真实 Unicode，再交给 COM 写入）。
function toAsciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function clampText(value, max) {
  const text = String(value || "").trim();
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// 关键：所有中文/项目符号的正文组装都在 Node 侧完成，PowerShell 脚本保持纯 ASCII，
// 避免 .ps1 non-ASCII 解析失败导致回退低保真引擎。
function buildPowerPointComContractPayload(contract) {
  const slidesIn = Array.isArray(contract && contract.slides) ? contract.slides : [];
  const slides = slidesIn.map((s, i) => {
    const title = sanitizeContractText((s && s.title) || `第${i + 1}页`, 88);
    const goal = sanitizeContractText((s && s.goal) || "", 220);
    const points = (Array.isArray(s && s.keyPoints) ? s.keyPoints : [])
      .map((x) => sanitizeContractText(x, 120))
      .filter(Boolean)
      .slice(0, 8);
    const notes = sanitizeContractText((s && s.speakerNotes) || "", 420);

    const pointChunks = [];
    for (let p = 0; p < points.length; p += 3) {
      pointChunks.push(points.slice(p, p + 3).map((x) => `• ${x}`).join("\r\n"));
    }
    const pointText = pointChunks.join("\r\n\r\n");
    const blocks = [];
    if (goal) blocks.push(goal);
    for (const chunk of pointChunks.slice(0, 3)) {
      if (chunk) blocks.push(chunk);
    }

    return {
      index: Number(s && s.index) || i + 1,
      title,
      goal,
      pointText,
      notes,
      blocks,
      bodyText: blocks.join("\r\n\r\n")
    };
  });

  return {
    topic: sanitizeContractText((contract && contract.topic) || "Daymori", 120),
    sceneType: sanitizeContractText((contract && contract.sceneType) || "通用", 40),
    slideCount: slides.length,
    slides
  };
}

function buildPowerPointComScript() {
  return [
    "param([string]$TemplatePath,[string]$PayloadPath,[string]$OutputPath)",
    "$ErrorActionPreference = 'Stop'",
    "$ppt = $null",
    "$pres = $null",
    "try {",
    "  $payloadRaw = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8",
    "  $payload = $payloadRaw | ConvertFrom-Json",
    "  $ppt = New-Object -ComObject PowerPoint.Application",
    "  $ppt.Visible = -1",
    "  $pres = $ppt.Presentations.Open($TemplatePath, $false, $false, $false)",
    "",
    "  $normalizeForBody = {",
    "    param([string]$text)",
    "    $x = [string]$text",
    "    $x = $x -replace '\\r\\n?', \"`n\"",
    "    if ($x -notmatch \"`n\") {",
    "      $x = $x -replace '[;；]\\s*', \"`n\"",
    "      $x = $x -replace '\\s+\\|\\s+', \"`n\"",
    "    }",
    "    $x = $x -replace '\\s{2,}', ' '",
    "    return $x.Trim()",
    "  }",
    "",
    "  $wrapLine = {",
    "    param([string]$line, [int]$maxChars)",
    "    $out = New-Object System.Collections.ArrayList",
    "    $src = [string]$line",
    "    if ([string]::IsNullOrWhiteSpace($src)) { return ,$out }",
    "    if ($maxChars -lt 10) { $maxChars = 10 }",
    "    $src = $src.Trim()",
    "    while ($src.Length -gt $maxChars) {",
    "      $cut = $maxChars",
    "      $scanStart = [Math]::Max(0, $cut - 10)",
    "      for ($i = $cut; $i -ge $scanStart; $i--) {",
    "        if ($i -ge $src.Length) { continue }",
    "        $ch = $src[$i]",
    "        if (',，。；;:：、 '.IndexOf($ch) -ge 0) {",
    "          $cut = $i + 1",
    "          break",
    "        }",
    "      }",
    "      $part = $src.Substring(0, $cut).Trim()",
    "      if ([string]::IsNullOrWhiteSpace($part) -eq $false) { [void]$out.Add($part) }",
    "      $src = $src.Substring($cut).TrimStart()",
    "    }",
    "    if ([string]::IsNullOrWhiteSpace($src) -eq $false) { [void]$out.Add($src) }",
    "    return ,$out",
    "  }",
    "",
    "  $fitBodyText = {",
    "    param([string]$text, $shape, [double]$fontSize)",
    "    $norm = &$normalizeForBody $text",
    "    if ([string]::IsNullOrWhiteSpace($norm)) { return @{ text = ''; overflow = '' } }",
    "",
    "    $w = 300.0",
    "    $h = 120.0",
    "    try { $w = [double]$shape.Width } catch {}",
    "    try { $h = [double]$shape.Height } catch {}",
    "",
    "    $charsPerLine = [int][Math]::Floor(($w - 12) / ([Math]::Max(6.0, $fontSize * 0.95)))",
    "    if ($charsPerLine -lt 10) { $charsPerLine = 10 }",
    "",
    "    $lineCap = [int][Math]::Floor(($h - 8) / ([Math]::Max(10.0, $fontSize * 1.55)))",
    "    if ($lineCap -lt 2) { $lineCap = 2 }",
    "",
    "    $lines = New-Object System.Collections.ArrayList",
    "    foreach ($ln in ($norm -split \"`n\")) {",
    "      $chunks = &$wrapLine ([string]$ln) $charsPerLine",
    "      foreach ($chunk in $chunks) {",
    "        if ([string]::IsNullOrWhiteSpace([string]$chunk)) { continue }",
    "        [void]$lines.Add([string]$chunk)",
    "      }",
    "    }",
    "",
    "    if ($lines.Count -eq 0) { return @{ text = ''; overflow = '' } }",
    "",
    "    $take = [Math]::Min($lineCap, $lines.Count)",
    "    $kept = New-Object System.Collections.ArrayList",
    "    for ($i = 0; $i -lt $take; $i++) { [void]$kept.Add([string]$lines[$i]) }",
    "",
    "    $overflow = ''",
    "    if ($lines.Count -gt $lineCap) {",
    "      $rest = New-Object System.Collections.ArrayList",
    "      for ($i = $lineCap; $i -lt $lines.Count; $i++) { [void]$rest.Add([string]$lines[$i]) }",
    "      $overflow = ($rest -join ' ')",
    "      if ($kept.Count -gt 0) {",
    "        $last = [string]$kept[$kept.Count - 1]",
    "        $kept[$kept.Count - 1] = ($last.TrimEnd('.', '。', ';', '；', ',', '，') + '...')",
    "      }",
    "    }",
    "",
    "    return @{ text = ($kept -join \"`r`n\"); overflow = $overflow }",
    "  }",
    "",
    "  $applyText = {",
    "    param($shape, [string]$text, [string]$kind)",
    "    try {",
    "      if ($shape -eq $null) { return '' }",
    "      $final = [string]$text",
    "      if ([string]::IsNullOrWhiteSpace($final)) { return '' }",
    "",
    "      $shape.TextFrame.WordWrap = -1",
    "      $shape.TextFrame.AutoSize = 0",
    "      try {",
    "        $shape.TextFrame2.WordWrap = -1",
    "        $shape.TextFrame2.AutoSize = 2",
    "      } catch {}",
    "",
    "      if ($kind -eq 'title') {",
    "        $shape.TextFrame.TextRange.Text = $final",
    "        if ($shape.TextFrame.TextRange.Font.Size -le 0) { $shape.TextFrame.TextRange.Font.Size = 30 }",
    "        for ($k = 0; $k -lt 8; $k++) {",
    "          try {",
    "            $bh = [double]$shape.TextFrame2.TextRange.BoundHeight",
    "            if ($bh -le ($shape.Height - 4)) { break }",
    "            $cur = [double]$shape.TextFrame.TextRange.Font.Size",
    "            if ($cur -le 18) { break }",
    "            $shape.TextFrame.TextRange.Font.Size = $cur - 1",
    "          } catch { break }",
    "        }",
    "        return ''",
    "      }",
    "",
    "      $base = 14.0",
    "      $len = $final.Length",
    "      if ($len -gt 600) { $base = 11.0 }",
    "      elseif ($len -gt 420) { $base = 12.0 }",
    "      elseif ($len -gt 280) { $base = 13.0 }",
    "",
    "      $fit = &$fitBodyText $final $shape $base",
    "      $finalBody = [string]$fit.text",
    "      if ([string]::IsNullOrWhiteSpace($finalBody)) { return [string]$fit.overflow }",
    "",
    "      $shape.TextFrame.TextRange.Text = $finalBody",
    "      try { $shape.TextFrame.TextRange.Font.Size = $base } catch {}",
    "",
    "      for ($k = 0; $k -lt 8; $k++) {",
    "        try {",
    "          $bh = [double]$shape.TextFrame2.TextRange.BoundHeight",
    "          if ($bh -le ($shape.Height - 4)) { break }",
    "          $cur = [double]$shape.TextFrame.TextRange.Font.Size",
    "          if ($cur -le 10) { break }",
    "          $shape.TextFrame.TextRange.Font.Size = $cur - 1",
    "        } catch { break }",
    "      }",
    "      return [string]$fit.overflow",
    "    } catch {",
    "      return ''",
    "    }",
    "  }",
    "",
    "  $keepCount = 0",
    "  try { $keepCount = [int]$payload.slideCount } catch { $keepCount = 0 }",
    "",
    "  foreach ($s in $payload.slides) {",
    "    $idx = [int]$s.index",
    "    if ($idx -lt 1 -or $idx -gt $pres.Slides.Count) { continue }",
    "",
    "    $slide = $pres.Slides.Item($idx)",
    "    $slideH = 0",
    "    $slideW = 0",
    "    try { $slideH = [double]$pres.PageSetup.SlideHeight } catch { $slideH = 540 }",
    "    try { $slideW = [double]$pres.PageSetup.SlideWidth } catch { $slideW = 960 }",
    "    $titleText = [string]$s.title",
    "    $goalText = [string]$s.goal",
    "    $pointText = [string]$s.pointText",
    "    $notes = [string]$s.notes",
    "",
    "    $blocks = @()",
    "    if ($s.blocks) { foreach ($b in $s.blocks) { $blocks += [string]$b } }",
    "    if ($blocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($pointText) -eq $false) { $blocks += $pointText }",
    "",
    "    $titleTargets = New-Object System.Collections.ArrayList",
    "    $bodyTargets = New-Object System.Collections.ArrayList",
    "    $titleHintTargets = New-Object System.Collections.ArrayList",
    "    $bodyHintTargets = New-Object System.Collections.ArrayList",
    "    $bodyTextTargets = New-Object System.Collections.ArrayList",
    "    $tokenTargets = New-Object System.Collections.ArrayList",
    "    $textShapes = New-Object System.Collections.ArrayList",
    "    $usedShapeIds = New-Object 'System.Collections.Generic.HashSet[int]'",
    "",
    "    foreach ($shape in $slide.Shapes) {",
    "      try {",
    "        if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "        [void]$textShapes.Add($shape)",
    "",
    "        $orig = ''",
    "        try { $orig = [string]$shape.TextFrame.TextRange.Text } catch { $orig = '' }",
    "        $origTrim = $orig.Trim()",
    "        $isBrandOrMeta = $false",
    "        if ($origTrim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$') { $isBrandOrMeta = $true }",

    "        if (-not $isBrandOrMeta) {",
    "          $isTitleHint = $false",
    "          if ($origTrim -match '(?i)输入.*标题|标题文字添加|enter\\s*your\\s*title|work\\s*report|this is your title|^title$|汇报|总结|大标题') { $isTitleHint = $true }",
    "          if ($isTitleHint -and $shape.Top -lt ($slideH * 0.5) -and $shape.Height -ge 220000) {",
    "            [void]$titleHintTargets.Add($shape)",
    "          }",

    "          $isBodyHint = $false",
    "          if ($origTrim -match '(?i)您的内容打在这里|点击此处|输入副标题|lorem|添加文本|输入标题|标题信息|副标题内容') { $isBodyHint = $true }",
    "          if ($isBodyHint -and $shape.Top -lt ($slideH * 0.88)) {",
    "            [void]$bodyHintTargets.Add($shape)",
    "          }",

    "          if ([string]::IsNullOrWhiteSpace($origTrim) -eq $false -and -not $isTitleHint -and $shape.Top -ge ($slideH * 0.30) -and $shape.Top -lt ($slideH * 0.88)) {",
    "            [void]$bodyTextTargets.Add($shape)",
    "          }",
    "        }",

    "        if ($orig -match '\\{\\{title\\}\\}' -or $orig -match '\\{\\{goal\\}\\}' -or $orig -match '\\{\\{points\\}\\}' -or $orig -match '\\{\\{notes\\}\\}') {",
    "          [void]$tokenTargets.Add(@{ shape = $shape; text = $orig })",
    "        }",
    "",
    "        if ($shape.Type -eq 14) {",
    "          $ptype = 0",
    "          try { $ptype = [int]$shape.PlaceholderFormat.Type } catch { $ptype = 0 }",
    "          if ($ptype -eq 1 -or $ptype -eq 3) { [void]$titleTargets.Add($shape); continue }",
    "          if ($ptype -eq 2 -or $ptype -eq 4 -or $ptype -eq 7) { [void]$bodyTargets.Add($shape); continue }",
    "        }",
    "      } catch {",
    "      }",
    "    }",
    "",
    "    if ($titleHintTargets.Count -gt 0) {",
    "      $titleTargets.Clear()",
    "      $orderedTitleHints = @($titleHintTargets | Where-Object {",
    "        try { $_.Width -ge ($slideW * 0.25) -and $_.Top -le ($slideH * 0.55) } catch { $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Left } })",
    "      if ($orderedTitleHints.Count -gt 0) { [void]$titleTargets.Add($orderedTitleHints[0]) }",
    "    }",

    "    if ($titleTargets.Count -eq 0 -and $titleHintTargets.Count -gt 0) {",
    "      $orderedTitleHints = @($titleHintTargets | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Left } })",
    "      if ($orderedTitleHints.Count -gt 0) { [void]$titleTargets.Add($orderedTitleHints[0]) }",
    "    }",

    "    if ($titleTargets.Count -eq 0 -and $textShapes.Count -gt 0) {",
    "      $bestTitle = $null",
    "      $bestScore = [double]::NegativeInfinity",
    "      foreach ($shape in $textShapes) {",
    "        try {",
    "          if ($shape.Width -lt ($slideW * 0.35)) { continue }",
    "          if ($shape.Top -gt ($slideH * 0.35)) { continue }",
    "          if ($shape.Height -lt 180000) { continue }",
    "          $score = (($slideH - $shape.Top) * 2.0) + ($shape.Width * 0.4) + ($shape.Height * 0.2)",
    "          if ($score -gt $bestScore) { $bestScore = $score; $bestTitle = $shape }",
    "        } catch {}",
    "      }",
    "      if ($bestTitle -ne $null) { [void]$titleTargets.Add($bestTitle) }",
    "    }",
    "",
    "    if ($titleTargets.Count -gt 0) {",
    "      [void](&$applyText $titleTargets[0] $titleText 'title')",
    "      try { [void]$usedShapeIds.Add([int]$titleTargets[0].Id) } catch {}",
    "    }",
    "",
    "    foreach ($token in $tokenTargets) {",
    "      try {",
    "        $shape = $token.shape",
    "        $orig = [string]$token.text",
    "        $replaced = $orig.Replace('{{title}}', $titleText)",
    "        $replaced = $replaced.Replace('{{goal}}', $goalText)",
    "        $replaced = $replaced.Replace('{{points}}', $pointText)",
    "        $replaced = $replaced.Replace('{{notes}}', $notes)",
    "        $ov = [string](&$applyText $shape $replaced 'body')",
    "        if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "          if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "        }",
    "        try { [void]$usedShapeIds.Add([int]$shape.Id) } catch {}",
    "      } catch {",
    "      }",
    "    }",
    "",
    "    $orderedBodies = @($bodyHintTargets | Where-Object {",
    "      try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "    } | Where-Object {",
    "      try {",
    "        if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -lt ($slideH * 0.30)) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -gt ($slideH * 0.88)) { return $false }",
    "        return $true",
    "      } catch { return $false }",
    "    } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "",
    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($bodyTextTargets | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          if ($_.Width -lt 120 -or $_.Height -lt 40) { return $false }",
    "          return $true",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "    }",

    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($bodyTargets | Where-Object {",
    "      try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "    } | Where-Object {",
    "      try {",
    "        if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -lt ($slideH * 0.30)) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -gt ($slideH * 0.88)) { return $false }",
    "        return $true",
    "      } catch { return $false }",
    "    } | Sort-Object @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } })",
    "    }",

    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($textShapes | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
          "          if ($slideH -gt 0 -and $_.Top -lt ($slideH * 0.30)) { return $false }",
    "          if ($slideH -gt 0 -and $_.Top -gt ($slideH * 0.88)) { return $false }",
    "          return $true",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } })",
    "    }",
    "",
    "    if ($orderedBodies.Count -gt 0 -and $blocks.Count -gt 0) {",
    "      if ($blocks.Count -eq 1) {",
    "        $b0 = [string]$blocks[0]",
    "        $ov = [string](&$applyText $orderedBodies[0] $b0 'body')",
    "        if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "          if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "        }",
    "        try { [void]$usedShapeIds.Add([int]$orderedBodies[0].Id) } catch {}",
    "      }",
    "      elseif ($orderedBodies.Count -ge $blocks.Count) {",
    "        for ($i = 0; $i -lt $blocks.Count; $i++) {",
    "          $bi = [string]$blocks[$i]",
    "          $ov = [string](&$applyText $orderedBodies[$i] $bi 'body')",
    "          if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "            if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "          }",
    "          try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "        }",
    "      }",
    "      else {",
    "        for ($i = 0; $i -lt $orderedBodies.Count; $i++) {",
    "          if ($i -lt ($orderedBodies.Count - 1)) {",
    "            $txt = ''",
    "            if ($i -lt $blocks.Count) { $txt = [string]$blocks[$i] }",
    "            if ([string]::IsNullOrWhiteSpace($txt) -eq $false) {",
    "              $ov = [string](&$applyText $orderedBodies[$i] $txt 'body')",
    "              if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "                if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "              }",
    "              try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "            }",
    "          } else {",
    "            $rest = @()",
    "            for ($j = $i; $j -lt $blocks.Count; $j++) { $rest += [string]$blocks[$j] }",
    "            $restText = ($rest -join \"`r`n`r`n\")",
    "            $ov = [string](&$applyText $orderedBodies[$i] $restText 'body')",
    "            if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "              if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "            }",
    "            try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "          }",
    "        }",
    "      }",
    "    }",
    "",
    "    # write speaker notes into the notes page, not the body",
    "    if ([string]::IsNullOrWhiteSpace($notes) -eq $false) {",
    "      try {",
    "        $np = $slide.NotesPage",
    "        foreach ($ns in $np.Shapes) {",
    "          try {",
    "            if ($ns.HasTextFrame -ne -1) { continue }",
    "            $npt = 0",
    "            try { $npt = [int]$ns.PlaceholderFormat.Type } catch { $npt = 0 }",
    "            if ($npt -eq 2) { $ns.TextFrame.TextRange.Text = $notes; break }",
    "          } catch {}",
    "        }",
    "      } catch {}",
    "    }",
    "",
    "    # only clear known placeholder copy that was not used; keep branded/meta template text",
    "    foreach ($shape in $textShapes) {",
    "      try {",
    "        $sid = [int]$shape.Id",
    "        if ($usedShapeIds.Contains($sid)) { continue }",
    "        $cur = [string]$shape.TextFrame.TextRange.Text",
    "        $curTrim = $cur.Trim()",
    "        if ([string]::IsNullOrWhiteSpace($curTrim)) { continue }",
    "        if ($curTrim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$|^\\d+([\\/\\-]\\d+)?$') { continue }",
    "        if ($curTrim -notmatch '(?i)您的内容打在这里|点击此处|输入.*标题|标题文字添加|lorem ipsum|添加文本|副标题内容') { continue }",
    "        $shape.TextFrame.TextRange.Text = ''",
    "      } catch {}",
    "    }",
    "  }",
    "",
    "  # delete extra template slides so final count matches requested pages",
    "  if ($keepCount -ge 1 -and $pres.Slides.Count -gt $keepCount) {",
    "    for ($i = $pres.Slides.Count; $i -gt $keepCount; $i--) {",
    "      try { $pres.Slides.Item($i).Delete() } catch {}",
    "    }",
    "  }",
    "",
    "  $pres.SaveAs($OutputPath, 24)",
    "  $pres.Close()",
    "  $ppt.Quit()",
    "  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null",
    "  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "",
    "  $info = @{ ok = $true; outputPath = $OutputPath; engine = 'local-powerpoint-com' }",
    "  $info | ConvertTo-Json -Depth 5 -Compress",
    "} catch {",
    "  if ($pres -ne $null) { try { $pres.Close() } catch {} }",
    "  if ($ppt -ne $null) { try { $ppt.Quit() } catch {} }",
    "  $err = @{ ok = $false; reason = [string]$_.Exception.Message }",
    "  $err | ConvertTo-Json -Depth 5 -Compress",
    "  exit 1",
    "}"
  ].join("\r\n");
}

async function buildPowerPointComPptx(contract) {
  if (!isPowerPointComEnabled()) {
    return { ok: false, reason: "powerpoint_com_disabled" };
  }
  if (process.platform !== "win32") {
    return { ok: false, reason: "powerpoint_com_windows_only" };
  }

  const b64 = String(contract && contract.templateFileBase64 || "").trim();
  const templateBuffer = parseBase64Payload(b64);
  if (!templateBuffer.length) {
    return { ok: false, reason: "powerpoint_com_template_required" };
  }

  const workDir = path.join(os.tmpdir(), `daymori-com-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  const templatePath = path.join(workDir, "template.pptx");
  const payloadPath = path.join(workDir, "payload.json");
  const scriptPath = path.join(workDir, "run-com-export.ps1");
  const outputPath = path.join(workDir, "output.pptx");

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(templatePath, templateBuffer);
    fs.writeFileSync(payloadPath, toAsciiJson(buildPowerPointComContractPayload(contract)), "utf8");
    // 关键：.ps1 必须带 UTF-8 BOM，否则 PowerShell 5.1 会按 ANSI 解析脚本，
    // 导致 COM 写入的中文被降级成 "?"（脚本本身保持纯 ASCII，双保险）。
    fs.writeFileSync(scriptPath, "\ufeff" + buildPowerPointComScript(), "utf8");

    const timeoutMs = getPowerPointComTimeoutMs();
    const ps = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-TemplatePath", templatePath,
      "-PayloadPath", payloadPath,
      "-OutputPath", outputPath
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024
    });

    if (ps.error) {
      return { ok: false, reason: `powerpoint_com_exec_error:${sanitizeAuditDetail(ps.error.message || String(ps.error))}` };
    }

    const stdout = String(ps.stdout || "").trim();
    const stderr = String(ps.stderr || "").trim();
    if (ps.status !== 0) {
      return { ok: false, reason: `powerpoint_com_failed:${sanitizeAuditDetail(stderr || stdout || `exit_${ps.status}`)}` };
    }

    if (!fs.existsSync(outputPath)) {
      return { ok: false, reason: "powerpoint_com_no_output" };
    }

    const outBuffer = fs.readFileSync(outputPath);
    if (!outBuffer.length) {
      return { ok: false, reason: "powerpoint_com_empty_output" };
    }

    return {
      ok: true,
      engine: "local-powerpoint-com",
      fileName: `${sanitizeFileName(contract.topic)}.pptx`,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: outBuffer
    };
  } catch (error) {
    return { ok: false, reason: `powerpoint_com_exception:${sanitizeAuditDetail(error && error.message ? error.message : String(error))}` };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
    }
  }
}

function normalizeHexColor(value) {
  const raw = String(value || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (raw.length >= 6) return raw.slice(0, 6);
  return "";
}

function resolveSysColorHex(val) {
  const key = String(val || "").toLowerCase();
  if (key === "windowtext") return "000000";
  if (key === "window") return "FFFFFF";
  return "";
}

function findSchemeColor(xml, tag) {
  const regex = new RegExp(`<a:${tag}>[\\s\\S]*?<a:(?:srgbClr|sysClr)\\s+([^>]+?)\\/?>(?:[\\s\\S]*?)<\\/a:${tag}>|<a:${tag}>[\\s\\S]*?<a:(?:srgbClr|sysClr)\\s+([^>]+?)\\/>(?:[\\s\\S]*?)<\\/a:${tag}>`, "i");
  const m = xml.match(regex);
  const attrs = (m && (m[1] || m[2])) || "";
  const srgb = attrs.match(/val=\"([0-9a-fA-F]{6})\"/i);
  if (srgb && srgb[1]) return normalizeHexColor(srgb[1]);
  const sys = attrs.match(/lastClr=\"([0-9a-fA-F]{6})\"/i);
  if (sys && sys[1]) return normalizeHexColor(sys[1]);
  const sysVal = attrs.match(/val=\"([a-zA-Z]+)\"/);
  if (sysVal && sysVal[1]) return resolveSysColorHex(sysVal[1]);
  return "";
}

function parseThemeFonts(xml) {
  const major = xml.match(/<a:majorFont>[\s\S]*?<a:latin[^>]*typeface=\"([^\"]+)\"/i);
  const minor = xml.match(/<a:minorFont>[\s\S]*?<a:latin[^>]*typeface=\"([^\"]+)\"/i);
  return {
    titleFont: (major && major[1]) ? String(major[1]).trim() : "",
    bodyFont: (minor && minor[1]) ? String(minor[1]).trim() : ""
  };
}

function parseTemplateThemeFromPptxBuffer(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("ppt/theme/theme1.xml");
    if (!entry) return null;
    const xml = entry.getData().toString("utf8");
    const dk1 = findSchemeColor(xml, "dk1") || "12100F";
    const lt1 = findSchemeColor(xml, "lt1") || "FFFFFF";
    const accent1 = findSchemeColor(xml, "accent1") || "2D6CDF";
    const accent2 = findSchemeColor(xml, "accent2") || accent1;
    const accent3 = findSchemeColor(xml, "accent3") || "A5A5A5";
    const fonts = parseThemeFonts(xml);

    return {
      palette: {
        bg: lt1,
        panel: lt1,
        panelSoft: normalizeHexColor(accent3) || "F2F4F8",
        line: normalizeHexColor(accent2) || "9BB8E6",
        title: dk1,
        text: dk1,
        muted: normalizeHexColor(accent3) || "667A99",
        accent: accent1,
        accentSoft: normalizeHexColor(accent2) || "DCE8FF"
      },
      fontPack: {
        title: fonts.titleFont || "Microsoft YaHei",
        body: fonts.bodyFont || "Microsoft YaHei"
      }
    };
  } catch {
    return null;
  }
}

function resolveTemplateThemeOverride(contract) {
  const b64 = String(contract && contract.templateFileBase64 || "").trim();
  if (!b64) return null;
  const buffer = parseBase64Payload(b64);
  if (!buffer.length) return null;
  return parseTemplateThemeFromPptxBuffer(buffer);
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

function inspectOfficeplusExportConfig() {
  const comEnabled = isPowerPointComEnabled();
  const comProbe = probePowerPointComRuntime();
  const comAvailable = !!comProbe.ok;
  let config = null;
  let configError = "";
  try {
    config = getAipptExportConfig();
  } catch (error) {
    configError = error && error.message ? error.message : String(error);
  }

  if (!config) {
    return {
      ready: false,
      officeplusLocalFallbackReady: true,
      officeplusComEnabled: comEnabled,
      officeplusComAvailable: comAvailable,
      officeplusComReason: comProbe.reason,
      issues: [sanitizeAuditDetail(configError || "aippt_config_invalid")],
      warnings: [],
      config: {
        provider: String(process.env.AIPPT_PROVIDER || "generic").toLowerCase().trim() || "generic",
        endpointConfigured: false,
        apiKeyConfigured: false,
        modelConfigured: false,
        authMode: String(process.env.AIPPT_API_AUTH_MODE || "bearer").toLowerCase().trim() || "bearer"
      }
    };
  }

  const issues = [];
  const warnings = [];
  const endpointConfigured = !!String(config.endpoint || "").trim();
  const apiKeyConfigured = config.authMode === "none" ? true : !!String(config.apiKey || "").trim();
  const modelConfigured = !!String(config.model || "").trim();

  if (!endpointConfigured) {
    issues.push("AIPPT_API_ENDPOINT/LAZYMAN_API_ENDPOINT 未配置");
  }
  if (!apiKeyConfigured) {
    issues.push("AIPPT_API_KEY 未配置（当前鉴权模式需要密钥）");
  }
  if (!modelConfigured) {
    warnings.push("AIPPT_API_MODEL 未配置，将使用默认模型，可能与上游不兼容");
  }
  if (config.provider === "generic") {
    warnings.push("AIPPT_PROVIDER=generic 需要你的上游直接接受 contract 并返回 fileBase64/downloadUrl");
  }
  if (config.provider === "lazyman" && !String(process.env.LAZYMAN_API_ENDPOINT || "").trim() && !String(process.env.AIPPT_API_ENDPOINT || "").trim()) {
    issues.push("AIPPT_PROVIDER=lazyman 但未设置 LAZYMAN_API_ENDPOINT");
  }

  return {
    ready: issues.length === 0,
    officeplusLocalFallbackReady: true,
    officeplusComEnabled: comEnabled,
    officeplusComAvailable: comAvailable,
    officeplusComReason: comProbe.reason,
    issues,
    warnings,
    config: {
      provider: config.provider,
      endpointConfigured,
      endpointPreview: endpointConfigured ? String(config.endpoint).slice(0, 120) : "",
      apiKeyConfigured,
      modelConfigured,
      authMode: config.authMode,
      keyHeader: config.authMode === "header" ? config.keyHeader : ""
    }
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
  const sceneTopicText = `${String(contract.sceneType || "")} ${String(contract.topic || "")} ${String(contract.visualStyle || "")}`.toLowerCase();

  const standardPalette = {
    bg: "12100F",
    panel: "1A1715",
    panelSoft: "26211D",
    line: "4A3A2D",
    title: "F4E5D4",
    text: "EAD8C4",
    muted: "B89E83",
    accent: "8A5B38",
    accentSoft: "2F241D"
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

  const eduSciencePalette = {
    bg: "F3F8FF",
    panel: "FFFFFF",
    panelSoft: "E7F0FF",
    line: "9BB8E6",
    title: "0E2A56",
    text: "173965",
    muted: "456A96",
    accent: "2D6CDF",
    accentSoft: "DCE8FF"
  };

  const warmTeachingPalette = {
    bg: "FFF8F0",
    panel: "FFFFFF",
    panelSoft: "FFEED9",
    line: "E6C59A",
    title: "5A2E12",
    text: "6B3B1D",
    muted: "8A5B3B",
    accent: "D17A2A",
    accentSoft: "FFE5CC"
  };
  const isEduScene = /教务|教学|课堂|学生|初中|物理|牛顿|力学|实验/.test(sceneTopicText);
  const isWarmTheme = /语文|历史|地理|文科|暖色|橙/.test(sceneTopicText);
  const templateThemeOverride = resolveTemplateThemeOverride(contract);
  let palette = isEduScene
    ? (isWarmTheme ? warmTeachingPalette : eduSciencePalette)
    : (narrativeMode === "lazyman" ? lazymanPalette : standardPalette);

  if (templateThemeOverride && templateThemeOverride.palette) {
    palette = {
      ...palette,
      ...templateThemeOverride.palette
    };
  }

  function srgbToLinear(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    const t = String(hex || "000000").replace(/[^0-9a-fA-F]/g, "").slice(0, 6).padEnd(6, "0");
    const r = parseInt(t.slice(0, 2), 16);
    const g = parseInt(t.slice(2, 4), 16);
    const b = parseInt(t.slice(4, 6), 16);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }

  function contrastRatio(hexA, hexB) {
    const l1 = luminance(hexA);
    const l2 = luminance(hexB);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Enforce readability floor: body >= 4.5:1, title >= 3:1.
  if (contrastRatio(palette.text, palette.panel) < 4.5 || contrastRatio(palette.title, palette.panel) < 3) {
    palette = isEduScene ? eduSciencePalette : standardPalette;
  }

  const fontTheme = String(contract.fontTheme || "business-cn");
  const chartStyle = String(contract.chartStyle || "calm");
  const fontMap = {
    "business-cn": { title: "Microsoft YaHei", body: "Microsoft YaHei" },
    "serif-cn": { title: "SimSun", body: "SimSun" },
    "modern-cn": { title: "Microsoft JhengHei", body: "Microsoft YaHei" }
  };
  let fontPack = fontMap[fontTheme] || fontMap["business-cn"];
  if (templateThemeOverride && templateThemeOverride.fontPack) {
    fontPack = {
      title: String(templateThemeOverride.fontPack.title || fontPack.title),
      body: String(templateThemeOverride.fontPack.body || fontPack.body)
    };
  }

  const chartStyleMap = {
    calm: { color: palette.accent, symbol: "circle" },
    contrast: { color: isEduScene ? "2D6CDF" : "A97A52", symbol: "diamond" },
    growth: { color: isEduScene ? "1B8AA6" : "6E4A2F", symbol: "triangle" }
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

  function toPptColor(hex, fallback) {
    const source = String(hex || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (source.length === 6) return source;
    if (source.length === 3) return source.split("").map((c) => c + c).join("");
    return String(fallback || "000000").replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, 6).padEnd(6, "0");
  }

  function mixColor(hexA, hexB, ratio = 0.5) {
    const a = toPptColor(hexA, "000000");
    const b = toPptColor(hexB, "FFFFFF");
    const t = Math.max(0, Math.min(1, Number(ratio) || 0));
    const ch = (i) => {
      const av = parseInt(a.slice(i, i + 2), 16);
      const bv = parseInt(b.slice(i, i + 2), 16);
      const v = Math.round(av * (1 - t) + bv * t);
      return v.toString(16).padStart(2, "0");
    };
    return `${ch(0)}${ch(2)}${ch(4)}`.toUpperCase();
  }

  function resolveSlideVisual(slideSpec, basePalette) {
    const vt = (slideSpec && slideSpec.visualTokens) || {};
    const vtPalette = (vt && vt.palette && typeof vt.palette === "object") ? vt.palette : {};
    const slidePalette = {
      bg: toPptColor(vtPalette.bg, basePalette.bg),
      panel: toPptColor(vtPalette.surface, basePalette.panel),
      panelSoft: toPptColor(vtPalette.surface, basePalette.panelSoft),
      line: toPptColor(vtPalette.accent, basePalette.line),
      title: toPptColor(vtPalette.title, basePalette.title),
      text: toPptColor(vtPalette.body, basePalette.text),
      muted: toPptColor(vtPalette.body, basePalette.muted),
      accent: toPptColor(vtPalette.accent, basePalette.accent),
      accentSoft: mixColor(toPptColor(vtPalette.accent, basePalette.accent), toPptColor(vtPalette.surface, basePalette.panelSoft), 0.7)
    };

    const typeScale = (vt && vt.typeScale && typeof vt.typeScale === "object") ? vt.typeScale : {};
    const layout = (vt && vt.layout && typeof vt.layout === "object") ? vt.layout : {};
    const shapeStyle = (vt && vt.shapeStyle && typeof vt.shapeStyle === "object") ? vt.shapeStyle : {};

    const titleSize = Math.max(20, Math.min(44, Number(typeScale.title) || 25));
    const bodySize = Math.max(9, Math.min(16, Number(typeScale.body) || 11.5));
    const noteSize = Math.max(8, Math.min(14, Number(typeScale.note) || 10.5));
    const columns = Math.max(1, Math.min(2, Number(layout.columns) || 1));
    const gap = Math.max(0.12, Math.min(0.52, (Number(layout.gap) || 8) / 28));
    const padding = Math.max(0.7, Math.min(1.35, (Number(layout.padding) || 11) / 10));
    const accentShape = String(shapeStyle.accent || "bar").toLowerCase();

    return {
      palette: slidePalette,
      titleSize,
      bodySize,
      noteSize,
      columns,
      gap,
      padding,
      accentShape
    };
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
    const lt = String(slideSpec.layoutType || "");
    if (lt === "evidence-chart" || lt === "risk-heatmap") return true;
    if (pageIndex === 3 || pageIndex === 4) return true;
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(数据|趋势|同比|环比|增长|收入|成本|转化|问题|风险|指标)/.test(text);
  }

  function isStrategyLikeSlide(slideSpec) {
    const lt = String(slideSpec.layoutType || "");
    if (lt === "strategy-compare" || lt === "roadmap-timeline") return true;
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(策略|路径|实施|里程碑|试点|验收|预算|资源)/.test(text);
  }

  function isDecisionLikeSlide(slideSpec, pageIndex, totalSlides) {
    const lt = String(slideSpec.layoutType || "");
    if (lt === "decision-board") return true;
    if (pageIndex === totalSlides) return true;
    const text = [slideSpec.title, slideSpec.goal, ...(slideSpec.keyPoints || [])].join(" ");
    return /(决策|下一步|拍板|行动建议|请求)/.test(text);
  }

  function addTeachingDiagram(slide, slideSpec, pageIndex) {
    const keyPoints = safeList(slideSpec.keyPoints, "补充关键教学要点").slice(0, 3).map((x) => shortText(x, 22));
    const left = 8.95;
    const top = 3.0;
    const boxW = 2.8;
    const boxH = 0.48;
    const gap = 0.2;
    const title = /实验/.test(`${slideSpec.title} ${slideSpec.goal}`) ? "实验流程图" : "受力示意流程";

    slide.addText(title, {
      x: left,
      y: 2.6,
      w: boxW,
      h: 0.28,
      fontSize: 10,
      bold: true,
      color: palette.accent,
      fontFace: fontPack.body
    });

    for (let i = 0; i < keyPoints.length; i++) {
      const y = top + i * (boxH + gap);
      slide.addShape(pptx.ShapeType.roundRect, {
        x: left,
        y,
        w: boxW,
        h: boxH,
        radius: 0.05,
        fill: { color: i % 2 === 0 ? "EAF1FF" : "DDEBFF" },
        line: { color: "9BB8E6", pt: 1 }
      });
      slide.addText(`${i + 1}. ${keyPoints[i]}`, {
        x: left + 0.12,
        y: y + 0.12,
        w: boxW - 0.2,
        h: 0.25,
        fontSize: 9.5,
        color: "173965",
        fontFace: fontPack.body
      });

      if (i < keyPoints.length - 1) {
        slide.addShape(pptx.ShapeType.chevron, {
          x: left + boxW / 2 - 0.09,
          y: y + boxH + 0.03,
          w: 0.18,
          h: 0.12,
          fill: { color: "2D6CDF" },
          line: { color: "2D6CDF", pt: 0.5 }
        });
      }
    }

    slide.addText(`课堂动作：第${pageIndex}页可安排30秒提问+60秒板演`, {
      x: left,
      y: 5.08,
      w: boxW,
      h: 0.34,
      fontSize: 9,
      color: "456A96",
      fontFace: fontPack.body
    });
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
    const visual = resolveSlideVisual(slideSpec, palette);
    const slidePalette = visual.palette;
    const contentLeft = visual.padding;
    const contentTop = 0.52;
    const contentW = 13.33 - visual.padding * 2;
    const contentH = 6.15;

    slide.background = { color: slidePalette.bg };

    const isCover = pageIndex === 1;
    if (isCover) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: 5.9,
        radius: 0.09,
        fill: { color: slidePalette.panel },
        line: { color: slidePalette.line, pt: 1.2 }
      });

      slide.addShape(pptx.ShapeType.rect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: 0.2,
        fill: { color: slidePalette.accent }
      });

      slide.addText(cleanText(contract.sceneType, "企业汇报"), {
        x: contentLeft + 0.38,
        y: 1.15,
        w: 4.8,
        h: 0.36,
        fontSize: 13,
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body
      });

      slide.addText(storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] || "封面总览", {
        x: contentLeft + contentW - 6.15,
        y: 1.2,
        w: 5.95,
        h: 0.34,
        align: "right",
        fontSize: 11,
        color: slidePalette.muted,
        fontFace: fontPack.body
      });

      slide.addText(title, {
        x: contentLeft + 0.38,
        y: 1.62,
        w: contentW - 1.2,
        h: 1.35,
        fontSize: Math.max(30, visual.titleSize + 12),
        bold: true,
        color: slidePalette.title,
        fontFace: fontPack.title,
        valign: "top"
      });

      slide.addText(goal, {
        x: contentLeft + 0.38,
        y: 3.2,
        w: contentW - 1.2,
        h: 0.9,
        fontSize: Math.max(14, visual.bodySize + 3),
        color: slidePalette.text,
        fontFace: fontPack.body
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + 0.38,
        y: 4.35,
        w: contentW - 1.2,
        h: 1.25,
        radius: 0.06,
        fill: { color: slidePalette.accentSoft },
        line: { color: slidePalette.line, pt: 1 }
      });

      slide.addText(`关键要点：${keyPoints.join(" ｜ ")}`, {
        x: contentLeft + 0.63,
        y: 4.72,
        w: contentW - 1.7,
        h: 0.5,
        fontSize: Math.max(11, visual.bodySize + 1),
        color: slidePalette.text,
        fontFace: fontPack.body
      });

      slide.addText(takeaway, {
        x: contentLeft + 0.38,
        y: 5.76,
        w: contentW - 1.2,
        h: 0.38,
        fontSize: Math.max(10, visual.noteSize),
        color: slidePalette.muted,
        fontFace: fontPack.body
      });
    } else {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: contentH,
        radius: 0.09,
        fill: { color: slidePalette.panel },
        line: { color: slidePalette.line, pt: 1.2 }
      });

      slide.addText(title, {
        x: contentLeft + 0.33,
        y: 0.82,
        w: Math.max(6.8, contentW - 4.8),
        h: 0.5,
        fontSize: Math.max(20, visual.titleSize + 7),
        bold: true,
        color: slidePalette.title,
        fontFace: fontPack.title
      });

      slide.addText(storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] || "补充说明", {
        x: contentLeft + contentW - 3.55,
        y: 1.29,
        w: 2.9,
        h: 0.22,
        align: "right",
        fontSize: 9,
        color: slidePalette.muted,
        fontFace: fontPack.body
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + contentW - 3.05,
        y: 0.78,
        w: 2.6,
        h: 0.48,
        radius: 0.08,
        fill: { color: slidePalette.panelSoft },
        line: { color: slidePalette.line, pt: 1 }
      });

      slide.addText(`目标：${goal.slice(0, 36)}`, {
        x: contentLeft + contentW - 2.89,
        y: 0.9,
        w: 2.26,
        h: 0.26,
        align: "center",
        fontSize: Math.max(9, visual.noteSize),
        color: slidePalette.accent,
        fontFace: fontPack.body
      });

      if (visual.accentShape === "orb") {
        slide.addShape(pptx.ShapeType.ellipse, {
          x: contentLeft + contentW - 1.2,
          y: 0.5,
          w: 0.62,
          h: 0.62,
          fill: { color: slidePalette.accentSoft, transparency: 5 },
          line: { color: slidePalette.accent, pt: 0.6 }
        });
      } else if (visual.accentShape === "ribbon") {
        slide.addShape(pptx.ShapeType.chevron, {
          x: contentLeft + contentW - 1.95,
          y: 0.7,
          w: 1.35,
          h: 0.46,
          fill: { color: slidePalette.accent },
          line: { color: slidePalette.accent, pt: 0.5 }
        });
      } else if (visual.accentShape === "grid") {
        for (let i = 0; i < 3; i++) {
          slide.addShape(pptx.ShapeType.roundRect, {
            x: contentLeft + contentW - 2.05 + i * 0.42,
            y: 0.72,
            w: 0.3,
            h: 0.3,
            radius: 0.03,
            fill: { color: slidePalette.accentSoft },
            line: { color: slidePalette.accent, pt: 0.4 }
          });
        }
      } else {
        slide.addShape(pptx.ShapeType.rect, {
          x: contentLeft + contentW - 1.25,
          y: 0.74,
          w: 0.62,
          h: 0.12,
          fill: { color: slidePalette.accent }
        });
      }

      const mainX = contentLeft + 0.33;
      const mainY = 1.52;
      const mainW = visual.columns === 2 ? Math.max(4.8, contentW - 4.4) : Math.max(6.4, contentW - 4.2);
      const assetX = mainX + mainW + visual.gap;
      const assetW = Math.max(2.55, contentLeft + contentW - assetX - 0.35);

      slide.addShape(pptx.ShapeType.roundRect, {
        x: mainX,
        y: mainY,
        w: mainW,
        h: 3.9,
        radius: 0.06,
        fill: { color: isEduScene ? "FFFFFF" : mixColor(slidePalette.panel, "000000", 0.18) },
        line: { color: slidePalette.line, pt: 1 }
      });

      slide.addText(takeaway, {
        x: mainX + 0.25,
        y: 1.62,
        w: mainW - 0.45,
        h: 0.38,
        fontSize: Math.max(9.5, visual.noteSize),
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body
      });

      const strategyLike = isStrategyLikeSlide(slideSpec);
      const decisionLike = isDecisionLikeSlide(slideSpec, pageIndex, totalSlides);
      const layoutType = String(slideSpec.layoutType || "");

      keyPoints.forEach((point, i) => {
        const row = visual.columns === 2 ? Math.floor(i / 2) : i;
        const col = visual.columns === 2 ? i % 2 : 0;
        const colGap = visual.columns === 2 ? 0.24 : 0;
        const blockW = visual.columns === 2 ? (mainW - 0.7 - colGap) / 2 : mainW - 0.57;
        const blockX = mainX + 0.25 + col * (blockW + colGap);
        const y = 2.06 + row * 0.8;
        const blockColor = isEduScene
          ? (i % 2 === 0 ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.52) : mixColor(slidePalette.accentSoft, "FFFFFF", 0.35))
          : (decisionLike ? (i % 2 === 0 ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.52) : mixColor(slidePalette.accentSoft, "FFFFFF", 0.4)) : (i % 2 === 0 ? mixColor(slidePalette.panel, "000000", 0.12) : mixColor(slidePalette.panel, "000000", 0.03)));
        slide.addShape(pptx.ShapeType.roundRect, {
          x: blockX,
          y,
          w: blockW,
          h: 0.66,
          radius: 0.05,
          fill: { color: blockColor },
          line: { color: isEduScene ? mixColor(slidePalette.accent, "FFFFFF", 0.62) : mixColor(slidePalette.line, "FFFFFF", 0.18), pt: 0.8 }
        });

        slide.addText(`0${i + 1}`, {
          x: blockX + 0.14,
          y: y + 0.18,
          w: 0.35,
          h: 0.2,
          fontSize: Math.max(8.5, visual.noteSize - 1),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body
        });

        slide.addText(point.slice(0, 60), {
          x: blockX + 0.58,
          y: y + 0.12,
          w: blockW - 0.65,
          h: 0.4,
          fontSize: Math.max(11, visual.bodySize + 1.5),
          color: isEduScene ? toPptColor(slidePalette.text, "173965") : toPptColor(slidePalette.title, "F3E7D9"),
          fontFace: fontPack.body
        });
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: assetX,
        y: 1.52,
        w: assetW,
        h: 3.9,
        radius: 0.06,
        fill: { color: slidePalette.panelSoft },
        line: { color: slidePalette.line, pt: 1 }
      });

      slide.addText("建议素材", {
        x: assetX + 0.25,
        y: 1.76,
        w: Math.max(2.0, assetW - 0.45),
        h: 0.3,
        fontSize: Math.max(11, visual.bodySize + 1),
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body
      });

      if (isEduScene) {
        addTeachingDiagram(slide, slideSpec, pageIndex);
      } else if (dataLike) {
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
          x: mainX + 0.25,
          y: 4.72,
          w: mainW - 0.5,
          h: 0,
          line: { color: slidePalette.accent, pt: 1.4 }
        });
        slide.addText("执行里程碑：M1 方案确认 -> M2 试点落地 -> M3 规模推广", {
          x: mainX + 0.25,
          y: 4.8,
          w: mainW - 0.55,
          h: 0.32,
          fontSize: Math.max(9.5, visual.noteSize),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body
        });
      }

      if (decisionLike) {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: assetX + 0.1,
          y: 5.52,
          w: Math.max(2.0, assetW - 0.2),
          h: 0.96,
          radius: 0.08,
          fill: { color: slidePalette.accentSoft },
          line: { color: slidePalette.accent, pt: 1 }
        });
        slide.addText("管理层决策请求\n批准试点预算与跨部门协同机制", {
          x: assetX + 0.26,
          y: 5.72,
          w: Math.max(1.7, assetW - 0.5),
          h: 0.56,
          fontSize: Math.max(9, visual.noteSize),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body
        });
      }

      assets.forEach((asset, i) => {
        slide.addText(`• ${asset.slice(0, 20)}`, {
          x: assetX + 0.25,
          y: 2.1 + i * 0.34,
          w: Math.max(1.8, assetW - 0.45),
          h: 0.25,
          fontSize: Math.max(9.5, visual.bodySize),
          color: slidePalette.text,
          fontFace: fontPack.body
        });
      });

      const noteFill = layoutType === "decision-board" ? slidePalette.accentSoft : (isEduScene ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.45) : mixColor(slidePalette.panel, "000000", 0.2));
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + 0.33,
        y: 5.52,
        w: contentW - 0.65,
        h: 0.96,
        radius: 0.05,
        fill: { color: noteFill },
        line: { color: slidePalette.line, pt: 1 }
      });

      slide.addText(`演讲备注：${notes.slice(0, 120)}`, {
        x: contentLeft + 0.53,
        y: 5.84,
        w: contentW - 1.05,
        h: 0.44,
        fontSize: Math.max(9.5, visual.noteSize),
        color: isEduScene ? toPptColor(slidePalette.muted, "365B88") : toPptColor(slidePalette.text, "E2CFB9"),
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
  const officeplusMode = String(contract && contract.templateSource || "").toLowerCase() === "officeplus";

  if (officeplusMode) {
    if (!String(contract && contract.templateFileBase64 || "").trim()) {
      return {
        result: { ok: false, reason: "officeplus_template_file_required" },
        exportConfig
      };
    }
    if (!result.ok) {
      const comResult = await buildPowerPointComPptx(contract);
      if (comResult && comResult.ok) {
        result = comResult;
        result.fallbackReason = `officeplus_com_fallback:${(result && result.reason) || "upstream_unavailable"}`;
      } else {
        result = await buildLocalPptx(contract);
        result.fallbackReason = `officeplus_local_fallback:${(comResult && comResult.reason) || (result && result.reason) || "upstream_unavailable"}`;
      }
    }
    return {
      result,
      exportConfig
    };
  }

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
        max_tokens: maxTokens,
        ...buildThinkingExtras(providerConfig.model)
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

async function callChatCompletions({ endpoint, apiKey, model, system, input, maxTokens }) {
  let upstream;
  try {
    upstream = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: String(system || "你是高信息密度助手，回答要清晰、可执行、低废话。") },
          { role: "user", content: input }
        ],
        temperature: 0.2,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : 850,
        ...buildThinkingExtras(model)
      })
    }, LLM_FETCH_RETRY);
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

async function callResponses({ endpoint, apiKey, model, input, maxTokens }) {
  let upstream;
  try {
    upstream = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input,
        max_output_tokens: Number.isFinite(maxTokens) ? maxTokens : 850
      })
    }, LLM_FETCH_RETRY);
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

app.get("/api/llm/runtime", (req, res) => {
  try {
    const cfg = getProviderConfig();
    return res.json({
      ok: true,
      provider: cfg.provider,
      model: cfg.model,
      endpoint: cfg.endpoint,
      apiKeyConfigured: !!cfg.apiKey
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "llm_runtime_read_failed",
      detail: error && error.message ? error.message : String(error)
    });
  }
});

app.get("/api/ppt/officeplus-status", (req, res) => {
  const inspection = inspectOfficeplusExportConfig();
  return res.json({
    ok: true,
    officeplusReady: inspection.ready,
    officeplusLocalFallbackReady: !!inspection.officeplusLocalFallbackReady,
    requiresTemplateFile: true,
    ...inspection
  });
});

app.post("/api/ppt/open-local-template-workflow", (req, res) => {
  const launched = launchPowerPointAndOpenInbox();
  if (!launched.ok) {
    return res.status(500).json({
      ok: false,
      error: "open_local_template_workflow_failed",
      detail: launched.reason || "unknown"
    });
  }
  return res.json({
    ok: true,
    inboxDir: launched.inboxDir,
    officeplusUrl: launched.officeplusUrl,
    inboxRelativePath: launched.inboxRelativePath,
    launchStatus: launched.launchStatus || null,
    steps: [
      "PowerPoint 已打开，同时已打开 OfficePLUS 模板页。请你自己手动点击鼠标选择模板。",
      `将模板保存到: ${launched.inboxDir}`,
      "返回 Daymori 后执行 /ppt pp-sync 同步最新模板。"
    ]
  });
});

app.get("/api/ppt/template-inbox/latest", (req, res) => {
  try {
    const latest = getLatestInboxPptxFile();
    if (!latest) {
      return res.status(404).json({
        ok: false,
        error: "template_inbox_empty",
        detail: "模板收件箱为空，请先在 PowerPoint 中另存为一个 .pptx 模板。",
        inboxRelativePath: path.relative(__dirname, ensureOfficeplusTemplateInboxDir()).replace(/\\/g, "/")
      });
    }

    const bin = fs.readFileSync(latest.absPath);
    return res.json({
      ok: true,
      fileName: latest.name,
      fileBase64: bin.toString("base64"),
      mtimeMs: Number(latest.stat.mtimeMs || 0),
      relativePath: path.relative(__dirname, latest.absPath).replace(/\\/g, "/")
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "template_inbox_read_failed",
      detail: error && error.message ? error.message : String(error)
    });
  }
});

app.post("/api/llm-proxy", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const providerConfig = getProviderConfig();
    const requestedModel = req.body && typeof req.body.model === "string" ? req.body.model.trim() : "";
    if (requestedModel) {
      if (providerConfig.provider === "deepseek") {
        providerConfig.model = requestedModel;
      } else if (providerConfig.provider === "qwen" && /^qwen/i.test(requestedModel)) {
        providerConfig.model = requestedModel;
      }
    }
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
    const maxTokens = Number.isFinite(maxTokensRaw) ? Math.min(Math.max(maxTokensRaw, 120), 8000) : 850;

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
        input: `${system}\n\n${userText}`,
        maxTokens
      });
    } else {
      result = await callChatCompletions({
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        system,
        input: userText,
        maxTokens
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

    const usage = (result && result.data && result.data.usage) || null;
    return res.json({
      text,
      provider: providerConfig.provider,
      model: providerConfig.model,
      usage
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

    if (!result || !result.ok) {
      const detail = sanitizeAuditDetail(result && result.reason ? result.reason : "ppt_export_unavailable");
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider
      });
      return res.status(409).json({ error: "ppt_export_unavailable", detail });
    }

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
    res.setHeader("x-template-source", String(contract.templateSource || "internal"));
    if (String(contract.templateFileName || "").trim()) {
      res.setHeader("x-template-file", encodeURIComponent(String(contract.templateFileName || "")).slice(0, 240));
    }
    if (result.fallbackReason) {
      const safeFallback = encodeURIComponent(String(result.fallbackReason || "")).slice(0, 400);
      res.setHeader("x-ppt-fallback", safeFallback);
    }
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

    if (!result || !result.ok) {
      const detail = sanitizeAuditDetail(result && result.reason ? result.reason : "ppt_export_unavailable");
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider
      });
      return res.status(409).json({ error: "ppt_export_unavailable", detail });
    }

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
      fallbackReason: result.fallbackReason || "",
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
