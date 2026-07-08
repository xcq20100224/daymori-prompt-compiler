import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const out = {
    topic: "AI客服降本增效方案",
    count: 30,
    variantA: "v4_strict",
    variantB: "v4_creative",
    template: ""
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "topic" && v) out.topic = v;
    if (k === "count" && v) out.count = Math.max(5, Math.min(100, Number(v) || 30));
    if (k === "a" && v) out.variantA = v;
    if (k === "b" && v) out.variantB = v;
    if (k === "template" && v) out.template = v;
  }
  return out;
}

function runBatchOnce(params) {
  const args = [
    "tools/run-variant-batch.mjs",
    `--topic=${params.topic}`,
    `--count=${params.count}`,
    "--concurrency=5",
    "--top=10",
    `--variants=${params.variant}`,
    "--no-training"
  ];
  if (params.template) args.push(`--template=${params.template}`);

  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 1000 * 60 * 30
  });

  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "batch_failed").trim());
  }

  const text = String(r.stdout || "").trim();
  const start = text.lastIndexOf("{");
  const parsed = JSON.parse(start >= 0 ? text.slice(start) : text);
  return parsed;
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pairedDiffStats(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return { n: 0, meanDiff: 0, tApprox: 0 };
  const diffs = [];
  for (let i = 0; i < n; i += 1) diffs.push(Number(b[i] || 0) - Number(a[i] || 0));
  const mean = average(diffs);
  const varDiff = average(diffs.map((x) => (x - mean) ** 2));
  const sd = Math.sqrt(varDiff || 0);
  const tApprox = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { n, meanDiff: Number(mean.toFixed(3)), tApprox: Number(tApprox.toFixed(3)) };
}

function main() {
  const args = parseArgs(process.argv);

  const runA = runBatchOnce({
    topic: args.topic,
    count: args.count,
    variant: args.variantA,
    template: args.template
  });
  const runB = runBatchOnce({
    topic: args.topic,
    count: args.count,
    variant: args.variantB,
    template: args.template
  });

  const scoresA = Array.isArray(runA.top) ? runA.top.map((x) => Number(x.autoScore || 0)) : [];
  const scoresB = Array.isArray(runB.top) ? runB.top.map((x) => Number(x.autoScore || 0)) : [];
  const avgA = average(scoresA);
  const avgB = average(scoresB);
  const improvePct = avgA > 0 ? ((avgB - avgA) / avgA) * 100 : 0;
  const stats = pairedDiffStats(scoresA, scoresB);

  const result = {
    ok: true,
    topic: args.topic,
    count: args.count,
    variantA: args.variantA,
    variantB: args.variantB,
    avgA: Number(avgA.toFixed(3)),
    avgB: Number(avgB.toFixed(3)),
    improvementPct: Number(improvePct.toFixed(2)),
    pairedStats: stats,
    significantApprox: Math.abs(stats.tApprox) >= 2,
    reportA: runA.reportDir,
    reportB: runB.reportDir
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
