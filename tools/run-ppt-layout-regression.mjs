import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePptxFile } from "./ppt-quality-metrics.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function readCases() {
  const p = path.join(repoRoot, "docs", "benchmarks", "layout-regression-cases.json");
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("layout-regression-cases.json is empty or invalid");
  }
  return parsed;
}

function baseContract(topic, slides, mode) {
  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: "通用",
    templateId: "template-default",
    templateSource: "internal",
    pageCount: slides.length,
    visualStyle: "简洁商务风",
    tone: "清晰、可执行",
    fontTheme: "business-cn",
    chartStyle: "calm",
    narrativeMode: "standard",
    topic,
    layoutPolicy: {
      mode,
      mappingVersion: "semantic-slot-v1"
    },
    slides
  };
}

function applyTemplatePack(contract, templatePack) {
  if (!templatePack || !templatePack.fileBase64) return contract;
  return {
    ...contract,
    templateId: "officeplus-regression",
    templateSource: "officeplus",
    templateFileName: templatePack.fileName,
    templateFileBase64: templatePack.fileBase64
  };
}

function toContract(caseItem, mode, templatePack) {
  const slides = (caseItem.slides || []).map((s, i) => ({
    index: i + 1,
    title: String(s.title || `第${i + 1}页`),
    goal: String(s.goal || ""),
    layoutType: String(s.layoutType || "summary-hero"),
    keyPoints: Array.isArray(s.keyPoints) ? s.keyPoints.slice(0, 3) : [],
    assetPlaceholders: Array.isArray(s.assetPlaceholders) ? s.assetPlaceholders.slice(0, 2) : [],
    speakerNotes: String(s.speakerNotes || "")
  }));
  const contract = baseContract(String(caseItem.topic || "layout-regression"), slides, mode);
  return applyTemplatePack(contract, templatePack);
}

async function loadTemplatePack() {
  const envPath = String(process.env.LAYOUT_TEMPLATE_PATH || "").trim();
  const defaultPath = "C:/Users/J1896/Desktop/演示文稿4.pptx";
  const targetPath = envPath || defaultPath;
  try {
    const bin = await fs.readFile(targetPath);
    return {
      fileName: path.basename(targetPath),
      fileBase64: Buffer.from(bin).toString("base64")
    };
  } catch {
    return null;
  }
}

async function postExportSave(contract) {
  const resp = await fetch("http://localhost:3000/api/ppt/export-save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract })
  });
  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: resp.status, ok: resp.ok, data };
}

function summarizeOne(caseId, mode, result) {
  const q = result && result.data && result.data.layoutQuality ? result.data.layoutQuality : null;
  const rel = result && result.data ? String(result.data.relativePath || "") : "";
  let qualityGate = {
    pass: false,
    reasons: ["missing_export_file"],
    emptySlides: [],
    placeholderOnlySlides: [],
    contentCoverage: 0
  };
  if (rel) {
    try {
      const abs = path.join(repoRoot, rel);
      const metrics = analyzePptxFile(abs);
      qualityGate = {
        pass: !!(metrics && metrics.gate && metrics.gate.pass),
        reasons: metrics && metrics.gate ? metrics.gate.reasons : ["gate_eval_failed"],
        emptySlides: metrics.emptySlides || [],
        placeholderOnlySlides: metrics.placeholderOnlySlides || [],
        contentCoverage: Number(metrics.contentCoverage || 0)
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
  return {
    caseId,
    mode,
    ok: !!(result && result.ok),
    status: result ? result.status : 0,
    score: q ? Number(q.score || 0) : 0,
    minScore: q ? Number(q.minScore || 0) : 0,
    pass: q ? !!q.pass : false,
    engine: result && result.data ? String(result.data.engine || "") : "",
    file: rel,
    error: result && result.data && result.data.detail ? String(result.data.detail) : "",
    qualityGate
  };
}

function buildReport(payload) {
  const lines = [];
  lines.push(`# PPT Layout Regression (${payload.runDate})`);
  lines.push("");
  lines.push(`- Run At: ${payload.runAt}`);
  lines.push(`- Template Applied: ${payload.templateApplied ? "YES" : "NO"}`);
  lines.push(`- Total Runs: ${payload.totalRuns}`);
  lines.push(`- Passed Quality Gate: ${payload.passed}`);
  lines.push(`- Passed Content Gate: ${payload.gatePassed}`);
  lines.push(`- Avg Score: ${payload.avgScore.toFixed(1)}`);
  lines.push(`- Blank Slides Total: ${payload.blankSlidesTotal}`);
  lines.push(`- Placeholder-only Slides Total: ${payload.placeholderOnlyTotal}`);
  lines.push(`- Avg Content Coverage: ${(payload.avgContentCoverage * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("## Results");
  lines.push("");
  for (const r of payload.results) {
    lines.push(`- ${r.caseId} | ${r.mode} | ok=${r.ok} | score=${r.score}/${r.minScore} | pass=${r.pass} | gate=${r.qualityGate && r.qualityGate.pass ? "pass" : "fail"} | coverage=${((r.qualityGate && r.qualityGate.contentCoverage) || 0).toFixed(2)} | engine=${r.engine} | file=${r.file || "-"} | ${(r.qualityGate && r.qualityGate.reasons || []).join(",") || ""} | ${r.error || ""}`);
  }
  return lines.join("\n");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function run() {
  const modes = ["strict-layout", "balanced", "strict-content"];
  const cases = await readCases();
  const templatePack = await loadTemplatePack();
  const results = [];

  for (const c of cases) {
    for (const mode of modes) {
      const contract = toContract(c, mode, templatePack);
      const res = await postExportSave(contract);
      results.push(summarizeOne(String(c.id || "case"), mode, res));
    }
  }

  const scored = results.filter((r) => Number.isFinite(r.score));
  const avgScore = scored.length ? scored.reduce((acc, x) => acc + x.score, 0) / scored.length : 0;
  const passed = results.filter((r) => r.pass).length;
  const gatePassed = results.filter((r) => r.qualityGate && r.qualityGate.pass).length;
  const blankSlidesTotal = results.reduce((acc, r) => acc + (r.qualityGate ? r.qualityGate.emptySlides.length : 0), 0);
  const placeholderOnlyTotal = results.reduce((acc, r) => acc + (r.qualityGate ? r.qualityGate.placeholderOnlySlides.length : 0), 0);
  const avgContentCoverage = results.length
    ? results.reduce((acc, r) => acc + Number((r.qualityGate && r.qualityGate.contentCoverage) || 0), 0) / results.length
    : 0;

  const payload = {
    runAt: nowIso(),
    runDate: todayDate(),
    templateApplied: !!templatePack,
    totalRuns: results.length,
    passed,
    gatePassed,
    blankSlidesTotal,
    placeholderOnlyTotal,
    avgContentCoverage,
    avgScore,
    results
  };

  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  const reportsDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  await ensureDir(resultsDir);
  await ensureDir(reportsDir);

  const latestJsonPath = path.join(resultsDir, "layout-regression-latest.json");
  const datedJsonPath = path.join(resultsDir, `layout-regression-${payload.runDate}.json`);
  const latestMdPath = path.join(reportsDir, "layout-regression-latest.md");
  const datedMdPath = path.join(reportsDir, `layout-regression-${payload.runDate}.md`);

  const reportMd = buildReport(payload);
  await fs.writeFile(latestJsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(datedJsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(latestMdPath, reportMd);
  await fs.writeFile(datedMdPath, reportMd);

  console.log(`Layout regression done: ${passed}/${results.length} passed`);
  console.log(`Content gate passed: ${gatePassed}/${results.length}`);
  console.log(`Blank slides total: ${blankSlidesTotal}`);
  console.log(`Avg score: ${avgScore.toFixed(1)}`);
  console.log("Report: docs/benchmarks/reports/layout-regression-latest.md");
  console.log("Result: docs/benchmarks/results/layout-regression-latest.json");

  if (gatePassed !== results.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
