import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePptxFile } from "./ppt-quality-metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const OUTPUT_PREFIX = String(process.env.BENCH_OUTPUT_PREFIX || "production-sla").trim() || "production-sla";
const PROVIDER_LABEL = String(process.env.BENCH_PROVIDER_LABEL || "daymori").trim() || "daymori";
const API_BASE = String(process.env.BENCH_API_BASE || "http://localhost:3000").trim() || "http://localhost:3000";

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function readTopics() {
  const p = path.join(repoRoot, "docs", "benchmarks", "real-topics-20.json");
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 20) {
    throw new Error("real-topics-20.json invalid or less than 20 topics");
  }
  return parsed.slice(0, 20);
}

function buildSlides(topic) {
  const t = String(topic || "教学主题");
  return [
    { index: 1, title: `导入：${t}为什么重要`, goal: `建立${t}学习动机`, layoutType: "summary-hero", keyPoints: ["结论：先明确问题场景再进入知识点", "证据：课前抽测常见错误率在30%-45%", "行动：本节前5分钟完成情境提问与口头反馈"], assetPlaceholders: ["导入图"], speakerNotes: "导入要快" },
    { index: 2, title: "学习目标与标准", goal: "明确可验收结果", layoutType: "decision-board", keyPoints: ["结论：本节目标是会说会算会应用", "证据：课堂达标线为3题中至少2题正确", "行动：中段进行板演，课后完成A/B分层任务"], assetPlaceholders: ["目标卡"], speakerNotes: "目标量化" },
    { index: 3, title: "核心概念", goal: "统一术语和单位", layoutType: "strategy-compare", keyPoints: ["结论：先统一定义再做推理", "证据：定义清晰时解题正确率通常提升20%", "行动：第15分钟组织同桌互查概念表"], assetPlaceholders: ["概念图"], speakerNotes: "概念先行" },
    { index: 4, title: "关键规律", goal: "形成可复用模型", layoutType: "evidence-chart", keyPoints: ["结论：规律要通过数据和反例双验证", "证据：示例数据两组以上且单位完整", "行动：第22分钟做一轮口算或判断练习"], assetPlaceholders: ["规律图"], speakerNotes: "规律证据化" },
    { index: 5, title: "方法步骤", goal: "稳定解题流程", layoutType: "diagnosis-matrix", keyPoints: ["结论：按步骤执行可减少漏项", "证据：流程化作答正确率高于自由作答约18%", "行动：第28分钟板演标准步骤模板"], assetPlaceholders: ["流程图"], speakerNotes: "步骤固定" },
    { index: 6, title: "例题精讲", goal: "打通已知到结论", layoutType: "roadmap-timeline", keyPoints: ["结论：已知-求-解结构最稳", "证据：例题数值与单位完整可复算", "行动：第35分钟学生独立完成同构题并互评"], assetPlaceholders: ["例题卡"], speakerNotes: "例题拆解" },
    { index: 7, title: "实验或应用", goal: "连接真实场景", layoutType: "risk-heatmap", keyPoints: ["结论：知识点必须落到可观察现象", "证据：至少给出3条观察数据并计算均值", "行动：末段小组复盘并记录1条改进"], assetPlaceholders: ["实验图"], speakerNotes: "场景连接" },
    { index: 8, title: "总结与作业", goal: "完成课堂闭环", layoutType: "summary-hero", keyPoints: ["结论：回收核心结论和高频错因", "证据：快测目标正确率>=80%", "行动：课后A组基础3题，B组综合2题，下节开场讲错题"], assetPlaceholders: ["作业卡"], speakerNotes: "闭环收束" }
  ];
}

async function loadTemplatePack() {
  const envPath = String(process.env.LAYOUT_TEMPLATE_PATH || "").trim();
  const defaultPath = "C:/Users/J1896/Desktop/演示文稿4.pptx";
  const targetPath = envPath || defaultPath;
  const bin = await fs.readFile(targetPath);
  return {
    fileName: path.basename(targetPath),
    fileBase64: Buffer.from(bin).toString("base64")
  };
}

function buildContract(topicItem, templatePack, mode) {
  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: String(topicItem.sceneType || "通用"),
    templateId: "officeplus-sla",
    templateSource: "officeplus",
    templateFileName: templatePack.fileName,
    templateFileBase64: templatePack.fileBase64,
    pageCount: 8,
    visualStyle: "高对比清晰",
    tone: "清晰、可执行",
    fontTheme: "business-cn",
    chartStyle: "contrast",
    narrativeMode: "standard",
    topic: String(topicItem.topic || "真实主题"),
    layoutPolicy: {
      mode,
      minScore: mode === "strict-layout" ? 88 : 82,
      mappingVersion: "semantic-slot-v1"
    },
    slides: buildSlides(topicItem.topic)
  };
}

async function postExportSave(contract) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000);
  try {
    const resp = await fetch(`${API_BASE.replace(/\/$/, "")}/api/ppt/export-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract }),
      signal: ctrl.signal
    });
    const elapsedMs = Date.now() - started;
    const text = await resp.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { ok: resp.ok, status: resp.status, data, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    return {
      ok: false,
      status: 0,
      elapsedMs,
      data: {
        error: error && error.name === "AbortError" ? "request_timeout" : String(error && error.message ? error.message : error)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

function inferGateDefaultReason(run) {
  if (!run) return "missing_export_file";
  if (run.ok) {
    const raw = String(run.data && (run.data.raw || run.data.error) || "").toLowerCase();
    if (raw.includes("<html") || raw.includes("<!doctype")) return "api_invalid_response_html";
    return "api_missing_relative_path";
  }
  if (Number(run.status || 0) === 0) {
    const err = String(run.data && run.data.error || "").toLowerCase();
    if (err.includes("econnrefused") || err.includes("fetch failed") || err.includes("network")) return "api_unreachable";
    if (err.includes("abort") || err.includes("timeout")) return "api_timeout";
    return `api_error:${err || "unknown"}`;
  }
  return `export_status_${Number(run.status || 0)}`;
}

function passBalanced(run) {
  const q = run.data && run.data.layoutQuality ? run.data.layoutQuality : null;
  const g = run.qualityGate || null;
  if (!run.ok || !q) return false;
  return q.pass
    && Number(q.score || 0) >= 82
    && Number(run.elapsedMs || 999999) <= 60000
    && !!(g && g.pass);
}

function strictLeakEscaped(run) {
  if (!run.ok) return false;
  const q = run.data && run.data.layoutQuality ? run.data.layoutQuality : null;
  if (!q) return true;
  return !q.strictLeakSafe;
}

function adjustCount(run) {
  const q = run.data && run.data.layoutQuality ? run.data.layoutQuality : null;
  if (!q) return 999;
  return Number(q.estimatedManualFixes || 999);
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function buildMd(payload) {
  const lines = [];
  lines.push(`# Production SLA Benchmark (${payload.runDate})`);
  lines.push("");
  lines.push(`- Run At: ${payload.runAt}`);
  lines.push(`- Topics: ${payload.totalTopics}`);
  lines.push(`- One-pass rate: ${(payload.onePassRate * 100).toFixed(1)}%`);
  lines.push(`- Strict leak escaped: ${payload.strictLeakEscaped}`);
  lines.push(`- Avg export ms: ${payload.avgExportMs.toFixed(0)}`);
  lines.push(`- Manual adjust sample avg: ${payload.manualAdjustAvg.toFixed(2)}`);
  lines.push(`- Blank slides total: ${payload.blankSlidesTotal}`);
  lines.push(`- Placeholder-only slides total: ${payload.placeholderOnlyTotal}`);
  lines.push(`- Avg content coverage: ${(payload.avgContentCoverage * 100).toFixed(1)}%`);
  lines.push(`- Target pass: ${payload.targetPass ? "YES" : "NO"}`);
  lines.push("");
  lines.push("## Balanced Runs");
  lines.push("");
  for (const r of payload.balanced) {
    lines.push(`- ${r.id} ${r.topic} | ok=${r.ok} | score=${r.score} | ms=${r.elapsedMs} | manual=${r.manualAdjustments} | gate=${r.qualityGate && r.qualityGate.pass ? "pass" : "fail"} | coverage=${((r.qualityGate && r.qualityGate.contentCoverage) || 0).toFixed(2)} | reasons=${(r.qualityGate && r.qualityGate.reasons || []).join(",")}`);
  }
  lines.push("");
  lines.push("## Strict Runs");
  lines.push("");
  for (const r of payload.strict) {
    lines.push(`- ${r.id} ${r.topic} | ok=${r.ok} | score=${r.score} | leakSafe=${r.strictLeakSafe}`);
  }
  return lines.join("\n");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function run() {
  const topics = await readTopics();
  const tpl = await loadTemplatePack();

  const balanced = [];
  const strict = [];

  for (const item of topics) {
    console.log(`[balanced] ${item.id} ${item.topic}`);
    const bc = buildContract(item, tpl, "balanced");
    const br = await postExportSave(bc);
    const bq = br.data && br.data.layoutQuality ? br.data.layoutQuality : null;
    let qualityGate = {
      pass: false,
      reasons: [inferGateDefaultReason(br)],
      emptySlides: [],
      placeholderOnlySlides: [],
      contentCoverage: 0
    };
    const rel = br && br.data ? String(br.data.relativePath || "") : "";
    if (rel) {
      try {
        const abs = path.join(repoRoot, rel);
        const m = analyzePptxFile(abs);
        qualityGate = {
          pass: !!(m && m.gate && m.gate.pass),
          reasons: m && m.gate ? m.gate.reasons : ["gate_eval_failed"],
          emptySlides: m.emptySlides || [],
          placeholderOnlySlides: m.placeholderOnlySlides || [],
          contentCoverage: Number(m.contentCoverage || 0)
        };
      } catch {
        qualityGate = {
          pass: false,
          reasons: ["quality_eval_failed"],
          emptySlides: [],
          placeholderOnlySlides: [],
          contentCoverage: 0
        };
      }
    }
    balanced.push({
      id: item.id,
      topic: item.topic,
      ok: br.ok,
      elapsedMs: br.elapsedMs,
      score: bq ? Number(bq.score || 0) : 0,
      strictLeakSafe: bq ? !!bq.strictLeakSafe : false,
      manualAdjustments: adjustCount(br),
      qualityGate,
      passed: passBalanced({ ...br, qualityGate })
    });

  console.log(`[strict] ${item.id} ${item.topic}`);
    const sc = buildContract(item, tpl, "strict-layout");
    const sr = await postExportSave(sc);
    const sq = sr.data && sr.data.layoutQuality ? sr.data.layoutQuality : null;
    strict.push({
      id: item.id,
      topic: item.topic,
      ok: sr.ok,
      score: sq ? Number(sq.score || 0) : 0,
      strictLeakSafe: sq ? !!sq.strictLeakSafe : !sr.ok,
      leakEscaped: strictLeakEscaped(sr)
    });
  }

  const onePassCount = balanced.filter((x) => x.passed).length;
  const onePassRate = onePassCount / balanced.length;
  const strictLeakEscapedCount = strict.filter((x) => x.leakEscaped).length;
  const avgExportMs = avg(balanced.map((x) => Number(x.elapsedMs || 0)));
  const manualSample = balanced.slice(0, 10);
  const manualAdjustAvg = avg(manualSample.map((x) => Number(x.manualAdjustments || 0)));
  const blankSlidesTotal = balanced.reduce((acc, x) => acc + Number(x.qualityGate && x.qualityGate.emptySlides ? x.qualityGate.emptySlides.length : 0), 0);
  const placeholderOnlyTotal = balanced.reduce((acc, x) => acc + Number(x.qualityGate && x.qualityGate.placeholderOnlySlides ? x.qualityGate.placeholderOnlySlides.length : 0), 0);
  const avgContentCoverage = balanced.length
    ? balanced.reduce((acc, x) => acc + Number((x.qualityGate && x.qualityGate.contentCoverage) || 0), 0) / balanced.length
    : 0;

  const targetPass = onePassRate >= 0.95
    && strictLeakEscapedCount === 0
    && avgExportMs <= 60000
    && manualAdjustAvg <= 1
    && blankSlidesTotal === 0
    && placeholderOnlyTotal === 0
    && avgContentCoverage >= 0.98;

  const payload = {
    runAt: nowIso(),
    runDate: todayDate(),
    providerLabel: PROVIDER_LABEL,
    totalTopics: topics.length,
    onePassRate,
    strictLeakEscaped: strictLeakEscapedCount,
    avgExportMs,
    manualAdjustAvg,
    blankSlidesTotal,
    placeholderOnlyTotal,
    avgContentCoverage,
    targetPass,
    balanced,
    strict
  };

  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  const reportsDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  await ensureDir(resultsDir);
  await ensureDir(reportsDir);

  const latestJson = path.join(resultsDir, `${OUTPUT_PREFIX}-latest.json`);
  const datedJson = path.join(resultsDir, `${OUTPUT_PREFIX}-${payload.runDate}.json`);
  const latestMd = path.join(reportsDir, `${OUTPUT_PREFIX}-latest.md`);
  const datedMd = path.join(reportsDir, `${OUTPUT_PREFIX}-${payload.runDate}.md`);

  const md = buildMd(payload);
  await fs.writeFile(latestJson, JSON.stringify(payload, null, 2));
  await fs.writeFile(datedJson, JSON.stringify(payload, null, 2));
  await fs.writeFile(latestMd, md);
  await fs.writeFile(datedMd, md);

  console.log(`One-pass rate: ${(onePassRate * 100).toFixed(1)}% (${onePassCount}/${balanced.length})`);
  console.log(`Strict leak escaped: ${strictLeakEscapedCount}`);
  console.log(`Avg export ms: ${avgExportMs.toFixed(0)}`);
  console.log(`Manual adjust avg (sample10): ${manualAdjustAvg.toFixed(2)}`);
  console.log(`Blank slides total: ${blankSlidesTotal}`);
  console.log(`Placeholder-only slides total: ${placeholderOnlyTotal}`);
  console.log(`Avg content coverage: ${(avgContentCoverage * 100).toFixed(1)}%`);
  console.log(`Target pass: ${targetPass ? "YES" : "NO"}`);
  console.log(`Provider label: ${PROVIDER_LABEL}`);
  console.log(`Report: docs/benchmarks/reports/${OUTPUT_PREFIX}-latest.md`);
  console.log(`Result: docs/benchmarks/results/${OUTPUT_PREFIX}-latest.json`);

  if (!targetPass) process.exitCode = 1;
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
