import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const summaryPaths = [
  "docs/benchmarks/results/variants/20260708-181546-用户增长策略/summary.json",
  "docs/benchmarks/results/variants/20260708-181632-新产品上市计划/summary.json",
  "docs/benchmarks/results/variants/20260708-181717-客户留存提升方案/summary.json"
].map((p) => path.resolve(repoRoot, p));

function readJson(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function generateMarkdownReport(trends) {
  const lines = [
    "# 10轮迭代质量趋势报告",
    "",
    "| Iteration | Avg Score | Trend |",
    "|---|---:|:---:|"
  ];

  trends.forEach((t, i) => {
    const prev = i > 0 ? Number(trends[i - 1].score || 0) : null;
    const trend = prev === null ? "-" : (Number(t.score || 0) > prev ? "↑" : "↓");
    lines.push(`| ${t.iteration} | ${Number(t.score || 0).toFixed(2)} | ${trend} |`);
  });

  const first = trends.length ? Number(trends[0].score || 0) : 0;
  const last = trends.length ? Number(trends[trends.length - 1].score || 0) : 0;
  lines.push("");
  lines.push(`总提升: ${(last - first).toFixed(2)} 分`);
  return lines.join("\n");
}

const summaries = summaryPaths.map((p) => readJson(p, null)).filter(Boolean);
if (summaries.length !== 3) {
  throw new Error("phase4_fallback_missing_summaries");
}

const perTopic = summaries.map((s) => ({
  topic: String(s.topic || ""),
  success: Number(s.success || 0),
  total: Number(s.total || 0),
  avgScore: Number((s.best && (s.best.autoScore || (s.best.qualityScore && s.best.qualityScore.overall) || 0)) || 0)
}));

const score = perTopic.length
  ? perTopic.reduce((acc, x) => acc + Number(x.avgScore || 0), 0) / perTopic.length
  : 0;

const trendsPath = path.resolve(repoRoot, "docs", "benchmarks", "training", "trends.json");
const trends = readJson(trendsPath, []);
const list = Array.isArray(trends) ? trends : [];

list.push({
  iteration: 1,
  score: Number(score.toFixed(2)),
  perTopic,
  at: new Date().toISOString(),
  source: "phase4-fallback"
});

fs.writeFileSync(trendsPath, JSON.stringify(list, null, 2), "utf8");

const reportPath = path.resolve(repoRoot, "docs", "benchmarks", "training", "final_report.md");
fs.writeFileSync(reportPath, generateMarkdownReport(list), "utf8");

console.log(JSON.stringify({
  ok: true,
  score: Number(score.toFixed(2)),
  perTopic,
  trendsPath: path.relative(repoRoot, trendsPath).replace(/\\/g, "/"),
  reportPath: path.relative(repoRoot, reportPath).replace(/\\/g, "/")
}, null, 2));
