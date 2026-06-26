const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const multer = require("multer");
const mammoth = require("mammoth");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

async function callProviderText({ providerConfig, systemPrompt, userPrompt, maxTokens = 520 }) {
  if (providerConfig.type === "responses") {
    const upstream = await fetch(providerConfig.endpoint, {
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

  const upstream = await fetch(providerConfig.endpoint, {
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
  const upstream = await fetch(endpoint, {
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
  const upstream = await fetch(endpoint, {
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

app.post("/api/chat", upload.array("files", 2), async (req, res) => {
  try {
    const providerConfig = getProviderConfig();
    if (!providerConfig.apiKey) {
      return res.status(500).json({
        error: "Missing API key",
        detail: `服务端未配置 ${providerConfig.keyEnv}，请在 .env 中设置后重启服务`
      });
    }

    const userInput = (req.body && req.body.message ? String(req.body.message) : "").trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!userInput && files.length === 0) {
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

    return res.json({
      text: displayText,
      compiled,
      compileRetries: result.compileRetries,
      provider: providerConfig.provider,
      model: providerConfig.model,
      raw: result.raw
    });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      detail: error && error.message ? error.message : String(error)
    });
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
