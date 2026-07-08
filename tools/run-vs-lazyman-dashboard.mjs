import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRuns(payload) {
  const balanced = payload && Array.isArray(payload.balanced) ? payload.balanced : [];
  return balanced.map((x) => ({
    id: String(x.id || ""),
    topic: String(x.topic || ""),
    score: Number(x.score || 0),
    hasQualityGate: !!(x && x.qualityGate),
    coverage: x && x.qualityGate ? Number(x.qualityGate.contentCoverage || 0) : null,
    blankCount: Array.isArray(x.qualityGate && x.qualityGate.emptySlides) ? x.qualityGate.emptySlides.length : 0,
    placeholderOnlyCount: Array.isArray(x.qualityGate && x.qualityGate.placeholderOnlySlides) ? x.qualityGate.placeholderOnlySlides.length : 0,
    reasons: Array.isArray(x.qualityGate && x.qualityGate.reasons) ? x.qualityGate.reasons.map(String) : []
  }));
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function summarizeSide(payload, label) {
  const runs = normalizeRuns(payload);
  const topics = runs.length;
  const coverageRuns = runs.filter((r) => Number.isFinite(r.coverage));
  const avgCoverage = coverageRuns.length ? avg(coverageRuns.map((r) => Number(r.coverage))) : null;
  const blankTotal = runs.reduce((acc, r) => acc + r.blankCount, 0);
  const placeholderOnlyTotal = runs.reduce((acc, r) => acc + r.placeholderOnlyCount, 0);
  const avgLayoutScore = avg(runs.map((r) => r.score));

  const failureCounter = new Map();
  for (const r of runs) {
    for (const reason of r.reasons) {
      failureCounter.set(reason, (failureCounter.get(reason) || 0) + 1);
    }
  }
  const top2FailureTypes = Array.from(failureCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, count]) => ({ reason, count }));

  return {
    label,
    available: topics > 0,
    topics,
    metrics: {
      avgContentCoverage: avgCoverage,
      blankSlidesTotal: blankTotal,
      placeholderOnlySlidesTotal: placeholderOnlyTotal,
      avgLayoutScore
    },
    top2FailureTypes,
    runs
  };
}

async function summarizeTrainingPairs() {
  const dir = path.join(repoRoot, "docs", "benchmarks", "results", "training-pairs");
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const today = new Date();
    const files = items
      .filter((x) => x.isFile() && /\.jsonl$/i.test(x.name))
      .map((x) => x.name)
      .sort();

    const rows = [];
    for (const f of files) {
      const datePart = f.replace(/\.jsonl$/i, "");
      const dateObj = new Date(`${datePart}T00:00:00Z`);
      const days = Math.floor((today - dateObj) / (24 * 3600 * 1000));
      if (!Number.isFinite(days) || days < 0 || days > 7) continue;
      const abs = path.join(dir, f);
      const raw = await fs.readFile(abs, "utf8");
      const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line));
        } catch {
        }
      }
    }

    return {
      available: rows.length > 0,
      pairCount7d: rows.length,
      sample: rows.slice(-5)
    };
  } catch {
    return {
      available: false,
      pairCount7d: 0,
      sample: []
    };
  }
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push(`# Daymori vs Lazyman Dashboard (${payload.runDate})`);
  lines.push("");
  lines.push(`- Run At: ${payload.runAt}`);
  lines.push(`- Daily Fixed Topics Target: 20`);
  lines.push("");

  for (const side of payload.sides) {
    lines.push(`## ${side.label}`);
    lines.push("");
    lines.push(`- Available: ${side.available ? "YES" : "NO"}`);
    lines.push(`- Topics: ${side.topics}`);
    lines.push(`- Avg Content Coverage: ${side.metrics.avgContentCoverage == null ? "N/A" : `${(side.metrics.avgContentCoverage * 100).toFixed(1)}%`}`);
    lines.push(`- Blank Slides Total: ${side.metrics.blankSlidesTotal}`);
    lines.push(`- Placeholder-only Slides Total: ${side.metrics.placeholderOnlySlidesTotal}`);
    lines.push(`- Avg Layout Score: ${side.metrics.avgLayoutScore.toFixed(1)}`);
    lines.push(`- Top2 Failure Types: ${side.top2FailureTypes.map((x) => `${x.reason}(${x.count})`).join(", ") || "none"}`);
    lines.push("");
  }

  lines.push("## Training Pairs (7d)");
  lines.push("");
  lines.push(`- Available: ${payload.trainingPairs.available ? "YES" : "NO"}`);
  lines.push(`- Pair Count (7d): ${payload.trainingPairs.pairCount7d}`);
  lines.push("");

  return lines.join("\n");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function run() {
  const oursPath = String(process.env.DAYMORI_SLA_JSON || "").trim()
    || path.join(repoRoot, "docs", "benchmarks", "results", "production-sla-latest.json");
  const lazymanPath = String(process.env.LAZYMAN_SLA_JSON || "").trim()
    || path.join(repoRoot, "docs", "benchmarks", "results", "lazyman-production-sla-latest.json");

  const ours = await readJsonSafe(oursPath);
  const lazyman = await readJsonSafe(lazymanPath);

  const payload = {
    runAt: nowIso(),
    runDate: todayDate(),
    sides: [
      summarizeSide(ours || {}, "Daymori"),
      summarizeSide(lazyman || {}, "Lazyman")
    ],
    trainingPairs: await summarizeTrainingPairs(),
    sources: {
      ours: path.relative(repoRoot, oursPath).replace(/\\/g, "/"),
      lazyman: path.isAbsolute(lazymanPath) ? path.relative(repoRoot, lazymanPath).replace(/\\/g, "/") : lazymanPath
    }
  };

  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  const reportsDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  await ensureDir(resultsDir);
  await ensureDir(reportsDir);

  const latestJson = path.join(resultsDir, "vs-lazyman-latest.json");
  const datedJson = path.join(resultsDir, `vs-lazyman-${payload.runDate}.json`);
  const latestMd = path.join(reportsDir, "vs-lazyman-latest.md");
  const datedMd = path.join(reportsDir, `vs-lazyman-${payload.runDate}.md`);

  const md = buildMarkdown(payload);
  await fs.writeFile(latestJson, JSON.stringify(payload, null, 2));
  await fs.writeFile(datedJson, JSON.stringify(payload, null, 2));
  await fs.writeFile(latestMd, md);
  await fs.writeFile(datedMd, md);

  const oursTopics = payload.sides[0].topics;
  const lazyTopics = payload.sides[1].topics;
  console.log(`Dashboard generated. Daymori topics=${oursTopics}, Lazyman topics=${lazyTopics}`);
  console.log(`Daymori top2 failures: ${payload.sides[0].top2FailureTypes.map((x) => `${x.reason}(${x.count})`).join(", ") || "none"}`);
  console.log(`Training pairs (7d): ${payload.trainingPairs.pairCount7d}`);
  console.log("Report: docs/benchmarks/reports/vs-lazyman-latest.md");
  console.log("Result: docs/benchmarks/results/vs-lazyman-latest.json");

  if (oursTopics < 20) process.exitCode = 1;
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
