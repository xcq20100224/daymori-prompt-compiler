import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const repoRoot = process.cwd();
const scriptPath = path.resolve(repoRoot, "tools", "run-variant-batch.mjs");

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
    countPerTopic: 5,
    concurrency: 1,
    top: 2,
    topicsLimit: 20
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "count" && v) out.countPerTopic = Math.max(1, Math.min(20, Number(v) || out.countPerTopic));
    if (k === "concurrency" && v) out.concurrency = Math.max(1, Math.min(4, Number(v) || out.concurrency));
    if (k === "top" && v) out.top = Math.max(1, Math.min(5, Number(v) || out.top));
    if (k === "topics" && v) out.topicsLimit = Math.max(1, Math.min(TRAINING_TOPICS.length, Number(v) || out.topicsLimit));
  }

  return out;
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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
  if (!fs.existsSync(summaryPath)) return null;

  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch {
    return null;
  }

  return {
    reportDir: path.relative(repoRoot, latest.absPath).replace(/\\/g, "/"),
    summary
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = TRAINING_TOPICS.slice(0, args.topicsLimit);
  const runSummary = [];

  for (const t of targets) {
    console.log(`\n=== topic: ${t.topic} (${t.scenario}/${t.sceneType}) ===`);
    const startedAtMs = Date.now();
    const callArgs = [
      scriptPath,
      `--topic=${t.topic}`,
      `--scenario=${t.scenario}`,
      `--sceneType=${t.sceneType}`,
      `--count=${args.countPerTopic}`,
      `--concurrency=${args.concurrency}`,
      `--top=${args.top}`
    ];

    try {
      await runNode(callArgs, {});
      const runInfo = getLatestTopicReport(t.topic, startedAtMs);
      if (!runInfo || !runInfo.summary) {
        runSummary.push({ topic: t.topic, ok: false, error: "no_json_output" });
        continue;
      }
      const parsed = runInfo.summary;
      runSummary.push({
        topic: t.topic,
        ok: true,
        reportDir: runInfo.reportDir,
        total: Number(parsed && parsed.total || 0),
        success: Number(parsed && parsed.success || 0),
        failed: Number(parsed && parsed.failed || 0)
      });
    } catch (err) {
      runSummary.push({ topic: t.topic, ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  const outDir = path.resolve(repoRoot, "docs", "benchmarks", "training");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "multi-topic-run-summary.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), runSummary }, null, 2), "utf8");

  console.log("\n=== multi topic summary ===");
  console.table(runSummary.map((x) => ({
    topic: x.topic,
    ok: x.ok,
    total: x.total || 0,
    success: x.success || 0,
    failed: x.failed || 0,
    reportDir: x.reportDir || "",
    error: x.error || ""
  })));
  console.log(`saved: ${path.relative(repoRoot, outPath).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(String(err && err.message ? err.message : err));
  process.exitCode = 1;
});
