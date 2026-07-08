import fs from "node:fs";
import path from "node:path";

const apiBase = process.env.BENCH_API_BASE || "http://localhost:3402";
const repoRoot = process.cwd();

const defaultConfig = {
  count: 10,
  concurrency: 2,
  fetchTimeoutMs: 120000,
  retryOnTimeout: true,
  maxRetries: 2
};

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv) {
  const out = {
    topic: "AI客服降本增效方案",
    count: defaultConfig.count,
    concurrency: defaultConfig.concurrency,
    topN: 10,
    pageCount: 10,
    sceneType: "企业",
    scenario: "proposal",
    templatePath: "",
    temperatureBase: 0.7,
    temperatureStep: 0.1,
    variants: ["v4_strict", "v4_creative", "v4_concise"],
    enhanced: false,
    updateTraining: true,
    fetchTimeoutMs: Math.max(3000, parseIntOrFallback(process.env.VARIANT_FETCH_TIMEOUT_MS, defaultConfig.fetchTimeoutMs)),
    retryOnTimeout: String(process.env.VARIANT_RETRY_ON_TIMEOUT || String(defaultConfig.retryOnTimeout)).toLowerCase() !== "false",
    maxRetries: Math.max(0, Math.min(5, parseIntOrFallback(process.env.VARIANT_MAX_RETRIES, defaultConfig.maxRetries))),
    debugScore: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "topic" && v) out.topic = v;
    if (k === "count" && v) out.count = Math.max(1, Math.min(500, Number(v) || 100));
    if (k === "concurrency" && v) out.concurrency = Math.max(1, Math.min(20, Number(v) || 5));
    if (k === "top" && v) out.topN = Math.max(1, Math.min(50, Number(v) || 10));
    if (k === "pageCount" && v) out.pageCount = Math.max(8, Math.min(12, Number(v) || 10));
    if (k === "sceneType" && v) out.sceneType = v;
    if (k === "scenario" && v) out.scenario = v;
    if (k === "template" && v) out.templatePath = v;
    if (k === "fetchTimeoutMs" && v) out.fetchTimeoutMs = Math.max(3000, parseIntOrFallback(v, out.fetchTimeoutMs));
    if (k === "retryOnTimeout" && v) out.retryOnTimeout = String(v).toLowerCase() !== "false";
    if (k === "maxRetries" && v !== "") out.maxRetries = Math.max(0, Math.min(5, parseIntOrFallback(v, out.maxRetries)));
    if (k === "debug-score") out.debugScore = true;
    if (k === "learnedRulesFile" && v) out.learnedRulesFile = v;
    if (k === "variants" && v) {
      const arr = v.split(",").map((x) => x.trim()).filter(Boolean);
      if (arr.length) out.variants = arr;
    }
    if (k === "enhanced") out.enhanced = v === "" ? true : String(v).toLowerCase() !== "false";
    if (k === "no-training") out.updateTraining = false;
  }

  return out;
}

function loadLearnedRules(repoRootDir, fileArg) {
  const p = fileArg
    ? (path.isAbsolute(fileArg) ? fileArg : path.resolve(repoRootDir, fileArg))
    : path.resolve(repoRootDir, "docs", "benchmarks", "training", "learned_rules.json");
  if (!fs.existsSync(p)) return [];
  const arr = readJsonSafe(p, []);
  return Array.isArray(arr) ? arr : [];
}

function buildPromptWithLearnedRules(basePrompt, learnedRules) {
  if (!Array.isArray(learnedRules) || !learnedRules.length) return basePrompt;
  const rulePrompt = learnedRules
    .slice()
    .sort((a, b) => Number(b && b.strength || 0) - Number(a && a.strength || 0))
    .slice(0, 5)
    .map((r) => `- ${String(r && r.rule || "")}${r && r.evidence ? `（${String(r.evidence)}）` : ""}`)
    .join("\n");
  return [
    basePrompt,
    "",
    "【从历史样本中学到的重要规则】",
    rulePrompt,
    "",
    "请严格遵守以上规则。"
  ].join("\n");
}

function slugify(input) {
  return String(input || "topic")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "topic";
}

function readJsonSafe(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLatestTemplate(absArgPath = "") {
  if (absArgPath) {
    const abs = path.isAbsolute(absArgPath) ? absArgPath : path.resolve(repoRoot, absArgPath);
    if (!fs.existsSync(abs)) throw new Error(`template not found: ${abs}`);
    return abs;
  }
  const inbox = path.resolve(repoRoot, "docs", "benchmarks", "templates", "inbox");
  if (!fs.existsSync(inbox)) throw new Error(`template inbox not found: ${inbox}`);
  const files = fs.readdirSync(inbox)
    .filter((x) => /\.pptx$/i.test(x))
    .map((name) => {
      const absPath = path.join(inbox, name);
      const st = fs.statSync(absPath);
      return { name, absPath, mtimeMs: Number(st.mtimeMs || 0) };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) throw new Error(`no pptx found in: ${inbox}`);
  return files[0].absPath;
}

function variance(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((acc, x) => acc + ((x - mean) ** 2), 0) / values.length;
}

function detectRepetition(text) {
  const tokens = String(text || "").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]+/g) || [];
  const map = new Map();
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1);
  let maxCount = 0;
  for (const [, n] of map) maxCount = Math.max(maxCount, n);
  return { maxCount, tokenCount: tokens.length };
}

function autoScoreDeck(result) {
  if (!result.ok) return { score: 0, blockerCount: 99, notes: ["request_failed"] };

  const baseScore = Number(result.qualityScore && result.qualityScore.overall || 65);
  const notes = [];
  let score = baseScore;

  const validationErrors = Array.isArray(result.validation && result.validation.errors)
    ? result.validation.errors
    : [];
  const blockerCount = validationErrors.length;

  for (const e of validationErrors) {
    const t = String(e && e.type || "");
    if (/blank|missing|incomplete|slideCountMismatch/i.test(t)) {
      score -= 12;
      notes.push(`BLOCKER:${t}`);
    } else if (/forbiddenText|duplicate/i.test(t)) {
      score -= 8;
      notes.push(`MAJOR:${t}`);
    } else {
      score -= 3;
      notes.push(`MINOR:${t}`);
    }
  }

  const slides = Array.isArray(result.dump && result.dump.slides) ? result.dump.slides : [];
  const titleLens = [];

  for (const slide of slides) {
    const title = String(slide && slide.title || "").trim();
    titleLens.push(title.length);

    if (/\d+\s*\/\s*\d+/.test(title)) {
      score -= 8;
      notes.push("title_has_page_number");
    }
    if (/V\d|新版|执行版/i.test(title)) {
      score -= 5;
      notes.push("title_has_version_word");
    }

    const texts = Array.isArray(slide && slide.texts) ? slide.texts.map((x) => String(x || "").trim()).filter(Boolean) : [];
    if (!texts.length) {
      score -= 20;
      notes.push("empty_slide");
      continue;
    }

    if (texts.length <= 1) {
      score -= 10;
      notes.push("half_filled_slide");
    }

    const joined = texts.join(" ");
    const rep = detectRepetition(joined);
    if (rep.maxCount > 3) {
      score -= rep.maxCount * 2;
      notes.push("high_repetition");
    }
  }

  if (titleLens.length) {
    const v = variance(titleLens);
    if (v > 50) {
      score -= 10;
      notes.push("title_length_variance_high");
    }
  }

  score = clamp(Math.round(score), 0, 100);
  return { score, blockerCount, notes: Array.from(new Set(notes)) };
}

function debugScoreDifference(result) {
  if (!result || !result.ok) return;
  const systemScore = Number(result.qualityScore && result.qualityScore.overall || 0);
  const autoResult = autoScoreDeck(result);
  const autoScore = autoResult.score;
  const qualityScore = result.qualityScore || {};

  console.log([
    "",
    `系统评分: ${systemScore}`,
    `自动评分: ${autoScore}`,
    `差距: ${Math.abs(systemScore - autoScore)}`,
    "",
    "系统的判断依据:",
    `- templateUsage: ${Number(qualityScore.templateUsage || 0)}`,
    `- contentSpecificity: ${Number(qualityScore.contentSpecificity || 0)}`,
    `- narrativeFlow: ${Number(qualityScore.narrativeFlow || 0)}`,
    "",
    "自动评分的扣分项:",
    `- blockerCount: ${autoResult.blockerCount}`,
    `- scoreNotes: ${(autoResult.notes || []).join(",")}`
  ].join("\n"));
}

function buildContract(args, seed, variant, templateName, templateB64) {
  const variantIdx = seed % Math.max(1, args.variants.length);
  const toneCycle = ["专业可信", "简洁有力", "清晰可执行"];
  const visualCycle = ["business clean", "信息密度均衡", "结构清晰"];
  const narrativeCycle = ["standard", "lazyman", "standard"];
  const chartCycle = ["calm", "calm", "dynamic"];
  const temperature = args.temperatureBase + (variantIdx % 3) * args.temperatureStep;

  const basePrompt = [
    `【核心主题】${args.topic}`,
    "",
    `请严格围绕\"${args.topic}\"输出${args.scenario}风格的PPT内容。`,
    "",
    "要求：",
    `1. 所有页面标题和内容必须与\"${args.topic}\"直接相关`,
    "2. 不要复用模板示例主题词或固定业务案例",
    `3. 封面标题必须包含主题名称\"${args.topic}\"`,
    "4. 内容简洁、完整、无元数据污染",
    "5. 每页内容填充完整，避免空白或半填充"
  ].join("\n");

  const prohibitions = [
    "【禁止事项】",
    "1. 禁止添加\"内容由AI生成\"等水印",
    "2. 禁止添加\"X/Y\"格式页码",
    "3. 禁止在标题中重复主题名称超过3次",
    "4. 禁止只有标题没有内容的空页"
  ].join("\n");

  const contentRules = [
    "【内容密度标准】",
    "对于content类型页面：",
    "- 每页至少3条完整要点",
    "- 每条要点包含主标题(5-8字) + 详细说明(15-30字)",
    "- 至少2页包含结构化布局（步骤、对比、列表）"
  ].join("\n");

  const enhancedPrompt = args.enhanced
    ? [
      basePrompt,
      "",
      prohibitions,
      "",
      contentRules,
      "",
      `请开始生成关于\"${args.topic}\"的高质量PPT契约。`
    ].join("\n")
    : basePrompt;

  const learnedPrompt = buildPromptWithLearnedRules(enhancedPrompt, args.learnedRules || []);

  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: args.sceneType,
    scenario: args.scenario,
    templateId: "default-business-template",
    templateSource: "officeplus",
    templateFileName: templateName,
    templateFileBase64: templateB64,
    pageCount: args.pageCount,
    visualStyle: visualCycle[variantIdx % visualCycle.length],
    tone: toneCycle[variantIdx % toneCycle.length],
    fontTheme: "business-cn",
    chartStyle: chartCycle[variantIdx % chartCycle.length],
    narrativeMode: narrativeCycle[variantIdx % narrativeCycle.length],
    topic: args.topic,
    lockToTemplate: false,
    promptVersion: variant,
    promptVariant: variant,
    promptHints: learnedPrompt,
    customInstructions: `必须严格围绕主题\"${args.topic}\"生成内容，不要使用模板示例内容；禁止水印与页码；content页保持至少3条完整要点。`,
    learnedRules: Array.isArray(args.learnedRules) ? args.learnedRules.slice(0, 5) : [],
    temperature,
    seed,
    layoutPolicy: {
      mode: "strict-layout",
      minScore: 80,
      mappingVersion: "semantic-slot-v1"
    },
    slides: []
  };
}

async function exportOne(args, templateName, templateB64, seed) {
  const variant = args.variants[seed % args.variants.length];
  const contract = buildContract(args, seed, variant, templateName, templateB64);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.fetchTimeoutMs);
  let resp;
  try {
    resp = await fetch(`${apiBase}/api/ppt/export-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract }),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err && err.name === "AbortError";
    const detail = isTimeout
      ? `request_timeout_${args.fetchTimeoutMs}ms`
      : String(err && err.message ? err.message : err);
    return {
      ok: false,
      seed,
      variant,
      status: 0,
      error: isTimeout ? "request_timeout" : "request_failed",
      detail,
      requestId: "",
      generationTracePath: "",
      qualityScore: null,
      validation: null,
      dump: null,
      relativePath: ""
    };
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return {
      ok: false,
      seed,
      variant,
      status: resp.status,
      error: data.error || "request_failed",
      detail: data.detail || "",
      requestId: data.requestId || "",
      generationTracePath: data.generationTracePath || "",
      qualityScore: data.qualityScore || null,
      validation: data.validation || null,
      dump: null,
      relativePath: ""
    };
  }

  const dumpAbs = data.dumpRelativePath ? path.resolve(repoRoot, data.dumpRelativePath) : "";
  const validationAbs = data.validationRelativePath ? path.resolve(repoRoot, data.validationRelativePath) : "";

  const dump = dumpAbs && fs.existsSync(dumpAbs) ? readJsonSafe(dumpAbs, null) : null;
  const validation = validationAbs && fs.existsSync(validationAbs) ? readJsonSafe(validationAbs, null) : null;

  const scored = autoScoreDeck({
    ok: true,
    qualityScore: data.qualityScore || null,
    validation,
    dump
  });

  return {
    ok: true,
    seed,
    variant,
    temperature: Number(contract.temperature || 0),
    status: resp.status,
    requestId: data.requestId || "",
    engine: data.engine || "",
    relativePath: data.relativePath || "",
    generationTracePath: data.generationTracePath || "",
    qualityScore: data.qualityScore || null,
    validation,
    dump,
    autoScore: scored.score,
    blockerCount: scored.blockerCount,
    scoreNotes: scored.notes
  };
}

async function exportOneWithRetry(args, templateName, templateB64, seed) {
  let last = null;
  const maxAttempts = Math.max(1, (Number(args.maxRetries || 0) + 1));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await exportOne(args, templateName, templateB64, seed);
    if (result.ok) {
      if (attempt > 0) {
        result.retried = attempt;
      }
      return result;
    }

    last = result;
    const isRetryable = args.retryOnTimeout
      && (result.error === "request_timeout"
        || result.error === "request_failed"
        || /timeout|unreachable|fetch failed/i.test(String(result.detail || "")));

    if (!isRetryable || attempt >= maxAttempts - 1) {
      return result;
    }

    const waitMs = (attempt + 1) * 5000;
    console.log(`seed=${seed} attempt=${attempt + 1} failed(${result.error}) wait=${waitMs}ms then retry`);
    await sleep(waitMs);
  }

  return {
    ok: false,
    seed,
    variant: args.variants[seed % args.variants.length],
    status: 0,
    error: "max_retries_exceeded",
    detail: String(last && last.detail || ""),
    requestId: "",
    generationTracePath: "",
    qualityScore: null,
    validation: null,
    dump: null,
    relativePath: ""
  };
}

async function runWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const cur = idx;
      idx += 1;
      if (cur >= items.length) return;
      out[cur] = await fn(items[cur], cur);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return out;
}

function appendBadSamples(topic, rows) {
  if (!rows.length) return 0;
  const file = path.resolve(repoRoot, "docs", "benchmarks", "training", "bad_samples.jsonl");
  const lines = rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  fs.appendFileSync(file, lines, "utf8");
  return rows.length;
}

function updateGoldenSamples(rows) {
  if (!rows.length) return 0;
  const file = path.resolve(repoRoot, "docs", "benchmarks", "training", "golden_samples.json");
  const current = readJsonSafe(file, []);
  const list = Array.isArray(current) ? current : [];
  for (const row of rows) {
    list.push({
      slideType: "deck_variant",
      example: {
        topic: row.topic,
        score: row.autoScore,
        requestId: row.requestId,
        pptPath: row.relativePath,
        generationTracePath: row.generationTracePath,
        promptVersion: row.variant,
        seed: row.seed,
        temperature: row.temperature
      },
      rules: [
        "优先选择 BLOCKER=0 的版本",
        "优先选择标题无页码、无版本词的版本",
        "优先选择总体质量分高且自动评分高的版本"
      ]
    });
  }
  fs.writeFileSync(file, JSON.stringify(list.slice(-120), null, 2), "utf8");
  return rows.length;
}

function summarize(results, topN) {
  const okRows = results.filter((x) => x && x.ok);
  const failRows = results.filter((x) => !x || !x.ok);

  const ranked = okRows
    .slice()
    .sort((a, b) => {
      if (b.autoScore !== a.autoScore) return b.autoScore - a.autoScore;
      if (a.blockerCount !== b.blockerCount) return a.blockerCount - b.blockerCount;
      const qa = Number(a.qualityScore && a.qualityScore.overall || 0);
      const qb = Number(b.qualityScore && b.qualityScore.overall || 0);
      return qb - qa;
    });

  const top = ranked.slice(0, Math.max(1, topN));
  const uncertain = ranked.filter((x) => x.autoScore >= 60 && x.autoScore <= 70);
  const worst = ranked.slice(-Math.min(5, ranked.length));

  return { okRows, failRows, ranked, top, uncertain, worst };
}

async function main() {
  const args = parseArgs(process.argv);
  args.learnedRules = loadLearnedRules(repoRoot, args.learnedRulesFile);
  const templateAbs = getLatestTemplate(args.templatePath);
  const templateName = path.basename(templateAbs);
  const templateB64 = fs.readFileSync(templateAbs).toString("base64");

  const seeds = Array.from({ length: args.count }, (_, i) => i);
  const results = await runWithConcurrency(
    seeds,
    args.concurrency,
    async (seed) => exportOneWithRetry(args, templateName, templateB64, seed)
  );

  const { okRows, failRows, ranked, top, uncertain, worst } = summarize(results, args.topN);

  const dir = path.resolve(repoRoot, "docs", "benchmarks", "results", "variants", `${nowStamp()}-${slugify(args.topic)}`);
  fs.mkdirSync(dir, { recursive: true });

  const summary = {
    topic: args.topic,
    scenario: args.scenario,
    sceneType: args.sceneType,
    total: results.length,
    success: okRows.length,
    failed: failRows.length,
    templateFileName: templateName,
    topCount: top.length,
    uncertainCount: uncertain.length,
    best: top[0] || null,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "top10.json"), JSON.stringify(top, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "uncertain.json"), JSON.stringify(uncertain, null, 2), "utf8");

  if (args.debugScore && top[0]) {
    debugScoreDifference(top[0]);
  }

  const md = [
    `# Variant Batch Report`,
    ``,
    `- Topic: ${args.topic}`,
    `- Total: ${results.length}`,
    `- Success: ${okRows.length}`,
    `- Failed: ${failRows.length}`,
    `- Template: ${templateName}`,
    ``,
    `## Top ${top.length}`,
    ...top.map((x, i) => `${i + 1}. score=${x.autoScore} blocker=${x.blockerCount} requestId=${x.requestId} file=${x.relativePath}`)
  ].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), md, "utf8");

  let appendedBad = 0;
  let appendedGolden = 0;
  if (args.updateTraining) {
    const badRows = worst.map((x) => ({
      slide: 0,
      error: x.blockerCount > 0 ? "variant_batch_low_quality" : "variant_batch_low_score",
      bad: `${x.variant}|score=${x.autoScore}|blockers=${x.blockerCount}`,
      good: "优先选择自动评分更高且BLOCKER更少的版本",
      timestamp: new Date().toISOString(),
      topic: args.topic,
      requestId: x.requestId || "",
      source: "variant_batch"
    }));
    appendedBad = appendBadSamples(args.topic, badRows);

    const goldenRows = top.slice(0, Math.min(2, top.length)).map((x) => ({ ...x, topic: args.topic }));
    appendedGolden = updateGoldenSamples(goldenRows);
  }

  const output = {
    ok: true,
    reportDir: path.relative(repoRoot, dir).replace(/\\/g, "/"),
    summary,
    top,
    appendedBad,
    appendedGolden
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
