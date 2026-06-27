import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const USE_MOCK =
  String(process.env.BENCH_MOCK || "").toLowerCase() === "true" || process.argv.includes("--mock");

const FAILURE_TYPES = {
  MISSING_BLOCKS: "missing_blocks",
  PAGE_MISMATCH: "page_mismatch",
  HOMEWORK_LEVELS: "homework_levels",
  API_ERROR: "api_error",
  INVALID_JSON: "invalid_json"
};

const STRATEGIES = {
  SCHEMA_REWRITE: "schema_rewrite",
  PAGE_RECONCILE: "page_reconcile",
  HOMEWORK_LAYER: "homework_layer"
};

function firstJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toReadable(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n").trim();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function parseStructuredResponse(rawText) {
  const candidate = firstJsonObject(rawText);
  if (candidate) {
    const parsed = safeJsonParse(candidate);
    if (parsed && typeof parsed === "object") {
      return {
        goals: toReadable(parsed.goals),
        pagePlan: toReadable(parsed.pagePlan),
        pageDetails: toReadable(parsed.pageDetails),
        interaction: toReadable(parsed.interaction),
        homework: toReadable(parsed.homework),
        finalPrompt: toReadable(parsed.finalPrompt)
      };
    }
  }

  return {
    goals: "",
    pagePlan: "",
    pageDetails: "",
    interaction: "",
    homework: "",
    finalPrompt: String(rawText || "").trim()
  };
}

function estimateGeneratedPageCount(structured) {
  const text = [structured.pagePlan, structured.pageDetails, structured.finalPrompt].join("\n");
  const pageNums = [];
  const r = /第\s*(\d{1,2})\s*页/g;
  let m;
  while ((m = r.exec(text)) !== null) pageNums.push(Number(m[1]));
  if (pageNums.length >= 2) return Math.max(...pageNums);

  const totalMatch = text.match(/(\d{1,2})\s*页(?:课堂|PPT|课件|演示|提示词)?/);
  return totalMatch ? Number(totalMatch[1]) : null;
}

function evaluateCase(item, structured) {
  const blocks = ["goals", "pagePlan", "pageDetails", "interaction", "homework", "finalPrompt"];
  const missingBlocks = blocks.filter((k) => !structured[k] || !String(structured[k]).trim());
  const complete = missingBlocks.length === 0;

  const gotPage = estimateGeneratedPageCount(structured);
  const pageOk = item.pageCount ? gotPage === item.pageCount : true;

  let homeworkOk = true;
  if (item.requireHomeworkLevels) {
    const hw = String(structured.homework || "");
    homeworkOk = /(基础|基础层)/.test(hw) && /(提高|进阶|提高层)/.test(hw) && /(挑战|拓展|挑战层|拓展层)/.test(hw);
  }

  const pass = complete && pageOk && homeworkOk;
  return { pass, complete, pageOk, gotPage, homeworkOk, missingBlocks };
}

function classifyFailures(evalResult, hasApiError = false, hasInvalidJson = false) {
  const reasons = [];
  if (hasApiError) reasons.push(FAILURE_TYPES.API_ERROR);
  if (hasInvalidJson) reasons.push(FAILURE_TYPES.INVALID_JSON);
  if (!evalResult.complete) reasons.push(FAILURE_TYPES.MISSING_BLOCKS);
  if (!evalResult.pageOk) reasons.push(FAILURE_TYPES.PAGE_MISMATCH);
  if (!evalResult.homeworkOk) reasons.push(FAILURE_TYPES.HOMEWORK_LEVELS);
  return reasons;
}

function buildStrategyPlan(failureTypes) {
  const plan = [];
  if (failureTypes.includes(FAILURE_TYPES.INVALID_JSON) || failureTypes.includes(FAILURE_TYPES.MISSING_BLOCKS)) {
    plan.push(STRATEGIES.SCHEMA_REWRITE);
  }
  if (failureTypes.includes(FAILURE_TYPES.PAGE_MISMATCH)) {
    plan.push(STRATEGIES.PAGE_RECONCILE);
  }
  if (failureTypes.includes(FAILURE_TYPES.HOMEWORK_LEVELS)) {
    plan.push(STRATEGIES.HOMEWORK_LAYER);
  }
  return [...new Set(plan)];
}

function countBy(items) {
  const m = new Map();
  for (const item of items) {
    m.set(item, (m.get(item) || 0) + 1);
  }
  return Object.fromEntries(Array.from(m.entries()).sort((a, b) => b[1] - a[1]));
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function extractCaseId(prompt) {
  const m = String(prompt || "").match(/\[CASE_ID\]\s*(T\d+)/i);
  return m ? m[1].toUpperCase() : "T00";
}

function buildMockResponse(prompt, pageCount) {
  const caseId = extractCaseId(prompt);
  const idNum = Number(caseId.replace("T", "")) || 0;
  const isRepair = /\[REPAIR_MODE\]/.test(prompt);

  const actualPageCount = isRepair ? pageCount : idNum % 5 === 0 ? Math.max(3, pageCount - 1) : pageCount;
  const missingInteraction = !isRepair && idNum % 4 === 0;
  const weakHomework = !isRepair && idNum % 3 === 0;

  const payload = {
    goals: `围绕课题建立清晰认知并达成课堂目标（${caseId}）。`,
    pagePlan: `第1页导入；第2页目标；第3页概念；第4页例题；第5页互动；第6页练习；第7页小结；第8页作业；共${actualPageCount}页。`,
    pageDetails: Array.from({ length: actualPageCount }, (_, i) => `第${i + 1}页：核心内容与讲授动作。`).join("\n"),
    interaction: missingInteraction ? "" : "设置3轮提问与同伴讨论，形成即时反馈。",
    homework: weakHomework ? "布置作业并复盘。" : "基础层：概念巩固；提高层：综合应用；挑战层：迁移创新。",
    finalPrompt: `请按第1页到第${actualPageCount}页生成课堂PPT，包含导入、讲解、互动、练习、小结与作业。`
  };

  return JSON.stringify(payload, null, 2);
}

async function requestStructured(prompt, pageCount) {
  if (USE_MOCK) {
    return buildMockResponse(prompt, pageCount);
  }

  const system = [
    "你是课堂PPT提示词专家。",
    "请严格输出 JSON，字段必须包含：goals,pagePlan,pageDetails,interaction,homework,finalPrompt。",
    "六个字段都必须为字符串，不允许数组或对象。",
    pageCount
      ? `硬约束：必须输出${pageCount}页，pagePlan/pageDetails/finalPrompt都要体现第1页到第${pageCount}页。`
      : ""
  ].join(" ");

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 850,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });

  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("API returned non-JSON: " + raw.slice(0, 180));
  }

  if (!resp.ok) {
    const detail = data.detail || data.error || (data.error && data.error.message) || raw.slice(0, 200);
    throw new Error(`API request failed (${resp.status}): ${detail}`);
  }

  return data?.choices?.[0]?.message?.content || "";
}

function buildCasePayload(item) {
  return [
    "[CASE_ID]",
    item.id,
    "",
    "[用户需求]",
    item.prompt,
    "",
    "[输出要求]",
    "请输出课堂PPT结构化结果，供教师直接出稿。"
  ].join("\n");
}

async function applyStrategy(strategy, item, currentStructured, rawPayload) {
  if (strategy === STRATEGIES.SCHEMA_REWRITE) {
    const prompt = [
      "[REPAIR_MODE]",
      "schema_rewrite",
      "",
      "请修复为完整结构。只输出JSON，字段必须包含goals,pagePlan,pageDetails,interaction,homework,finalPrompt，且全部为字符串。",
      "",
      "[用户需求]",
      item.prompt,
      "",
      "[当前输出]",
      JSON.stringify(currentStructured)
    ].join("\n");
    const text = await requestStructured(prompt, item.pageCount);
    return parseStructuredResponse(text);
  }

  if (strategy === STRATEGIES.PAGE_RECONCILE) {
    const prompt = [
      "[REPAIR_MODE]",
      "page_reconcile",
      "",
      `硬约束：必须严格${item.pageCount}页，pagePlan/pageDetails/finalPrompt都体现第1页到第${item.pageCount}页。`,
      "只输出JSON，字段必须完整。",
      "",
      "[用户需求]",
      item.prompt,
      "",
      "[当前输出]",
      JSON.stringify(currentStructured)
    ].join("\n");
    const text = await requestStructured(prompt, item.pageCount);
    return parseStructuredResponse(text);
  }

  if (strategy === STRATEGIES.HOMEWORK_LAYER) {
    const prompt = [
      "[REPAIR_MODE]",
      "homework_layer",
      "",
      "请只修复作业分层：homework必须包含基础/提高/挑战三层；其余内容保持一致风格。",
      "只输出JSON，字段必须完整。",
      "",
      "[用户需求]",
      item.prompt,
      "",
      "[当前输出]",
      JSON.stringify(currentStructured)
    ].join("\n");
    const text = await requestStructured(prompt, item.pageCount);
    return parseStructuredResponse(text);
  }

  return parseStructuredResponse(rawPayload);
}

function summarizeMetrics(results, stage = "final") {
  const total = results.length;
  const pageAccuracy = ratio(results.filter((r) => r[stage].pageOk).length, total);
  const completeRate = ratio(results.filter((r) => r[stage].complete).length, total);
  const passRate = ratio(results.filter((r) => r[stage].pass).length, total);
  return { pageAccuracy, completeRate, passRate };
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push(`# Teacher Benchmark Daily Report (${payload.runDate})`);
  lines.push("");
  lines.push(`- Run At: ${payload.runAt}`);
  lines.push(`- Model: ${payload.model}`);
  lines.push(`- Cases: ${payload.total}`);
  lines.push(`- Mock Mode: ${payload.mockMode ? "ON" : "OFF"}`);
  lines.push("");
  lines.push("## KPI");
  lines.push("");
  lines.push(`- Initial Pass Rate: ${(payload.metrics.initial.passRate * 100).toFixed(1)}%`);
  lines.push(`- Final Pass Rate: ${(payload.metrics.final.passRate * 100).toFixed(1)}%`);
  lines.push(`- Initial Page Accuracy: ${(payload.metrics.initial.pageAccuracy * 100).toFixed(1)}%`);
  lines.push(`- Final Page Accuracy: ${(payload.metrics.final.pageAccuracy * 100).toFixed(1)}%`);
  lines.push(`- Initial Completeness: ${(payload.metrics.initial.completeRate * 100).toFixed(1)}%`);
  lines.push(`- Final Completeness: ${(payload.metrics.final.completeRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("## Failure Attribution (Before Repair)");
  lines.push("");

  const initialFailureRows = Object.entries(payload.failureAttribution.initial);
  if (initialFailureRows.length === 0) {
    lines.push("- None");
  } else {
    for (const [name, count] of initialFailureRows) {
      lines.push(`- ${name}: ${count}`);
    }
  }

  lines.push("");
  lines.push("## Failure Attribution (After Repair)");
  lines.push("");
  const finalFailureRows = Object.entries(payload.failureAttribution.final);
  if (finalFailureRows.length === 0) {
    lines.push("- None");
  } else {
    for (const [name, count] of finalFailureRows) {
      lines.push(`- ${name}: ${count}`);
    }
  }

  lines.push("");
  lines.push("## Strategy Effectiveness");
  lines.push("");
  const strategyRows = Object.entries(payload.strategyStats);
  if (strategyRows.length === 0) {
    lines.push("- No strategy executed.");
  } else {
    for (const [name, stat] of strategyRows) {
      lines.push(`- ${name}: applied=${stat.applied}, resolved=${stat.resolved}, winRate=${(stat.winRate * 100).toFixed(1)}%`);
    }
  }

  lines.push("");
  lines.push("## Remaining Failed Cases");
  lines.push("");
  const remain = payload.results.filter((r) => !r.final.pass);
  if (!remain.length) {
    lines.push("- None");
  } else {
    for (const r of remain) {
      lines.push(`- ${r.id}: ${r.finalFailureTypes.join(", ")}`);
    }
  }

  return lines.join("\n");
}

async function writeArtifacts(payload) {
  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  const reportDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });

  const latestJsonPath = path.join(resultsDir, "latest.json");
  const latestSummaryPath = path.join(resultsDir, "latest-summary.json");
  const dateStampedJsonPath = path.join(resultsDir, `${payload.runDate}.json`);

  const reportText = buildMarkdownReport(payload);
  const latestReportPath = path.join(reportDir, "latest.md");
  const dateStampedReportPath = path.join(reportDir, `${payload.runDate}.md`);

  const summaryPayload = {
    runDate: payload.runDate,
    runAt: payload.runAt,
    model: payload.model,
    total: payload.total,
    metrics: payload.metrics,
    failureAttribution: payload.failureAttribution,
    strategyStats: payload.strategyStats,
    remainingFailed: payload.results.filter((r) => !r.final.pass).map((r) => ({ id: r.id, failures: r.finalFailureTypes }))
  };

  await fs.writeFile(latestJsonPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(dateStampedJsonPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(latestSummaryPath, JSON.stringify(summaryPayload, null, 2), "utf8");
  await fs.writeFile(latestReportPath, reportText, "utf8");
  await fs.writeFile(dateStampedReportPath, reportText, "utf8");

  return {
    latestJsonPath,
    dateStampedJsonPath,
    latestSummaryPath,
    latestReportPath,
    dateStampedReportPath
  };
}

async function run() {
  const benchmarkPath = path.join(repoRoot, "docs", "benchmarks", "teacher-prompts.json");
  const text = await fs.readFile(benchmarkPath, "utf8");
  const datasetRaw = JSON.parse(text);
  const limit = Number(process.env.BENCH_LIMIT || 0);
  const dataset = Number.isFinite(limit) && limit > 0 ? datasetRaw.slice(0, limit) : datasetRaw;

  console.log(`Loaded ${dataset.length} benchmark cases.`);
  if (!API_KEY && !USE_MOCK) {
    throw new Error("DEEPSEEK_API_KEY is required for benchmark run. Or set BENCH_MOCK=true.");
  }

  const strategyStatsRaw = new Map();
  const results = [];

  for (const item of dataset) {
    const payload = buildCasePayload(item);
    const perCaseStrategyHistory = [];

    try {
      const initialRaw = await requestStructured(payload, item.pageCount);
      let structured = parseStructuredResponse(initialRaw);
      const initialEval = evaluateCase(item, structured);
      const initialFailureTypes = classifyFailures(initialEval, false, !firstJsonObject(initialRaw));

      let finalEval = initialEval;
      let finalFailureTypes = initialFailureTypes;

      const strategyPlan = buildStrategyPlan(initialFailureTypes);
      for (const strategy of strategyPlan) {
        if (finalEval.pass) break;

        const beforePass = finalEval.pass;
        structured = await applyStrategy(strategy, item, structured, payload);
        finalEval = evaluateCase(item, structured);
        finalFailureTypes = classifyFailures(finalEval, false, false);

        perCaseStrategyHistory.push({
          strategy,
          beforePass,
          afterPass: finalEval.pass,
          remainingFailures: finalFailureTypes
        });

        const prev = strategyStatsRaw.get(strategy) || { applied: 0, resolved: 0 };
        prev.applied += 1;
        if (!beforePass && finalEval.pass) {
          prev.resolved += 1;
        }
        strategyStatsRaw.set(strategy, prev);
      }

      results.push({
        id: item.id,
        initial: initialEval,
        final: finalEval,
        initialFailureTypes,
        finalFailureTypes,
        strategyHistory: perCaseStrategyHistory
      });

      console.log(
        `${item.id} | ${initialEval.pass ? "PASS" : "FAIL"} -> ${finalEval.pass ? "PASS" : "FAIL"} | page=${finalEval.gotPage || "?"}/${item.pageCount} | strategy=${perCaseStrategyHistory.map((s) => s.strategy).join(",") || "none"}`
      );
    } catch (error) {
      const fallbackEval = {
        pass: false,
        complete: false,
        pageOk: false,
        gotPage: null,
        homeworkOk: false,
        missingBlocks: ["all"]
      };

      results.push({
        id: item.id,
        initial: fallbackEval,
        final: fallbackEval,
        initialFailureTypes: [FAILURE_TYPES.API_ERROR],
        finalFailureTypes: [FAILURE_TYPES.API_ERROR],
        strategyHistory: [],
        error: error.message
      });

      console.log(`${item.id} | ERROR | ${error.message}`);
    }
  }

  const metrics = {
    initial: summarizeMetrics(results, "initial"),
    final: summarizeMetrics(results, "final")
  };

  const failureAttribution = {
    initial: countBy(results.flatMap((r) => (r.initial.pass ? [] : r.initialFailureTypes))),
    final: countBy(results.flatMap((r) => (r.final.pass ? [] : r.finalFailureTypes)))
  };

  const strategyStats = Object.fromEntries(
    Array.from(strategyStatsRaw.entries()).map(([name, stat]) => {
      const winRate = ratio(stat.resolved, stat.applied);
      return [name, { ...stat, winRate }];
    })
  );

  const runPayload = {
    runAt: nowIso(),
    runDate: todayDate(),
    model: USE_MOCK ? "mock-teacher-benchmark" : MODEL,
    mockMode: USE_MOCK,
    total: results.length,
    metrics,
    failureAttribution,
    strategyStats,
    results
  };

  const paths = await writeArtifacts(runPayload);

  console.log("\n=== Benchmark Summary ===");
  console.log(`Initial Pass Rate: ${(metrics.initial.passRate * 100).toFixed(1)}%`);
  console.log(`Final Pass Rate: ${(metrics.final.passRate * 100).toFixed(1)}%`);
  console.log(`Artifacts: ${paths.latestSummaryPath}`);

  const minPage = Number(process.env.BENCH_PAGE_THRESHOLD || 0.95);
  const minComplete = Number(process.env.BENCH_COMPLETE_THRESHOLD || 0.95);
  if (metrics.final.pageAccuracy < minPage || metrics.final.completeRate < minComplete) {
    console.error("Benchmark thresholds not met.");
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
