import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const variantScript = path.resolve(repoRoot, "tools", "run-variant-batch.mjs");
const learnScript = path.resolve(repoRoot, "tools", "learn-rules-from-samples.mjs");

const TRAINING_TOPICS = [
  { topic: "AI客服降本增效方案", scenario: "proposal", sceneType: "企业" },
  { topic: "供应链数字化转型方案", scenario: "proposal", sceneType: "企业" },
  { topic: "用户增长策略", scenario: "proposal", sceneType: "企业" },
  { topic: "新产品上市计划", scenario: "proposal", sceneType: "企业" },
  { topic: "客户留存提升方案", scenario: "proposal", sceneType: "企业" },
  { topic: "RAG系统性能优化", scenario: "report", sceneType: "企业" },
  { topic: "服务稳定性SLO升级", scenario: "report", sceneType: "企业" },
  { topic: "多租户权限模型重构", scenario: "report", sceneType: "企业" },
  { topic: "Q3增长复盘", scenario: "report", sceneType: "企业" },
  { topic: "渠道投放ROI优化", scenario: "report", sceneType: "企业" },
  { topic: "牛顿第二定律", scenario: "teaching", sceneType: "教务" },
  { topic: "压强与浮力", scenario: "teaching", sceneType: "教务" },
  { topic: "酸碱中和反应", scenario: "teaching", sceneType: "教务" },
  { topic: "光合作用", scenario: "teaching", sceneType: "教务" },
  { topic: "一次函数", scenario: "teaching", sceneType: "教务" },
  { topic: "暑期活动转化复盘", scenario: "analysis", sceneType: "企业" },
  { topic: "私域留资漏斗优化", scenario: "analysis", sceneType: "企业" },
  { topic: "内容营销效果分析", scenario: "analysis", sceneType: "企业" },
  { topic: "用户画像洞察", scenario: "analysis", sceneType: "企业" },
  { topic: "竞品对比分析", scenario: "analysis", sceneType: "企业" }
];

function parseArgs(argv) {
  const out = {
    iterations: 10,
    batchSize: 20,
    topicsPerIteration: 5,
    concurrency: 1,
    topN: 2
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "iterations" && v) out.iterations = Math.max(1, Math.min(20, Number(v) || out.iterations));
    if (k === "batchSize" && v) out.batchSize = Math.max(5, Math.min(100, Number(v) || out.batchSize));
    if (k === "topicsPerIteration" && v) out.topicsPerIteration = Math.max(1, Math.min(10, Number(v) || out.topicsPerIteration));
    if (k === "concurrency" && v) out.concurrency = Math.max(1, Math.min(3, Number(v) || out.concurrency));
    if (k === "top" && v) out.topN = Math.max(1, Math.min(5, Number(v) || out.topN));
  }

  return out;
}

function readJsonSafe(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function sampleRandom(arr, n) {
  const copied = arr.slice();
  for (let i = copied.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = copied[i];
    copied[i] = copied[j];
    copied[j] = t;
  }
  return copied.slice(0, Math.min(n, copied.length));
}

function slugify(input) {
  return String(input || "topic")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "topic";
}

function getLatestTopicReport(topic, startedAtMs) {
  const variantsDir = path.resolve(repoRoot, "docs", "benchmarks", "results", "variants");
  if (!fs.existsSync(variantsDir)) return null;

  const topicSlug = slugify(topic);
  const entries = fs.readdirSync(variantsDir)
    .filter((name) => name.endsWith(`-${topicSlug}`))
    .map((name) => {
      const absPath = path.join(variantsDir, name);
      const st = fs.statSync(absPath);
      return { name, absPath, mtimeMs: Number(st.mtimeMs || 0) };
    })
    .filter((x) => x.mtimeMs >= startedAtMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!entries.length) return null;
  const latest = entries[0];
  const summaryPath = path.join(latest.absPath, "summary.json");
  const topPath = path.join(latest.absPath, "top10.json");
  const summary = readJsonSafe(summaryPath, null);
  const top = readJsonSafe(topPath, []);
  if (!summary) return null;

  return {
    reportDir: path.relative(repoRoot, latest.absPath).replace(/\\/g, "/"),
    summary,
    top: Array.isArray(top) ? top : []
  };
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const t = String(chunk || "");
      stdout += t;
      process.stdout.write(t);
    });
    child.stderr.on("data", (chunk) => {
      const t = String(chunk || "");
      stderr += t;
      process.stderr.write(t);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child_exit_${code}`));
    });
  });
}

function recordTrend(iteration, score, perTopic) {
  const trendFile = path.resolve(repoRoot, "docs", "benchmarks", "training", "trends.json");
  const current = readJsonSafe(trendFile, []);
  const list = Array.isArray(current) ? current : [];
  list.push({
    iteration,
    score: Number(score.toFixed(2)),
    perTopic,
    at: new Date().toISOString()
  });
  fs.mkdirSync(path.dirname(trendFile), { recursive: true });
  fs.writeFileSync(trendFile, JSON.stringify(list, null, 2), "utf8");
  return list;
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

async function runIterationLoop() {
  const args = parseArgs(process.argv);

  for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
    console.log(`\n========== 第${iteration}轮迭代 ==========`);

    const topics = sampleRandom(TRAINING_TOPICS, args.topicsPerIteration);
    const countPerTopic = Math.max(1, Math.floor(args.batchSize / Math.max(1, args.topicsPerIteration)));
    const topicSummaries = [];

    for (const t of topics) {
      const startedAtMs = Date.now();
      const ret = await runNode(variantScript, [
        `--topic=${t.topic}`,
        `--scenario=${t.scenario}`,
        `--sceneType=${t.sceneType}`,
        `--count=${countPerTopic}`,
        `--concurrency=${args.concurrency}`,
        `--top=${args.topN}`
      ]);

      const parsed = getLatestTopicReport(t.topic, startedAtMs);
      if (!parsed || !parsed.summary) {
        topicSummaries.push({ topic: t.topic, success: 0, total: countPerTopic, avgScore: 0 });
        continue;
      }
      const top = Array.isArray(parsed.top) ? parsed.top : [];
      const avgScore = top.length
        ? top.reduce((acc, x) => acc + Number(x && x.autoScore || 0), 0) / top.length
        : 0;

      topicSummaries.push({
        topic: t.topic,
        success: Number(parsed.summary && parsed.summary.success || 0),
        total: Number(parsed.summary && parsed.summary.total || countPerTopic),
        avgScore
      });
    }

    await runNode(learnScript, []);

    const roundAvg = topicSummaries.length
      ? topicSummaries.reduce((acc, x) => acc + Number(x.avgScore || 0), 0) / topicSummaries.length
      : 0;

    const trends = recordTrend(iteration, roundAvg, topicSummaries);
    console.log(`本轮平均质量分：${roundAvg.toFixed(2)}`);

    if (iteration === args.iterations) {
      const md = generateMarkdownReport(trends);
      const reportPath = path.resolve(repoRoot, "docs", "benchmarks", "training", "final_report.md");
      fs.writeFileSync(reportPath, md, "utf8");
      console.log(`最终报告: ${path.relative(repoRoot, reportPath).replace(/\\/g, "/")}`);
    }
  }
}

runIterationLoop().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exitCode = 1;
});
