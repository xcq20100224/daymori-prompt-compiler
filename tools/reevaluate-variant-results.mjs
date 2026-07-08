import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readJsonSafe(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function detectRepetition(text) {
  const tokens = String(text || "").toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]+/g) || [];
  const map = new Map();
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1);
  let maxCount = 0;
  for (const [, n] of map) maxCount = Math.max(maxCount, n);
  return { maxCount, tokenCount: tokens.length };
}

function autoScoreDeckV2(result) {
  if (!result || !result.ok) return { score: 0, blockerCount: 99, notes: ["request_failed"] };

  const baseScore = Number(result.qualityScore && result.qualityScore.overall || 65);
  let score = baseScore;
  const notes = [];

  const validationErrors = Array.isArray(result.validation && result.validation.errors)
    ? result.validation.errors
    : [];
  const blockerCount = validationErrors.length;

  for (const e of validationErrors) {
    const t = String(e && e.type || "");
    if (/blank|missing|incomplete|slideCountMismatch/.test(t)) {
      score -= 12;
      notes.push(`BLOCKER:${t}`);
    } else if (/forbiddenText|duplicate/.test(t)) {
      score -= 8;
      notes.push(`MAJOR:${t}`);
    } else {
      score -= 3;
      notes.push(`MINOR:${t}`);
    }
  }

  const slides = Array.isArray(result.dump && result.dump.slides) ? result.dump.slides : [];
  for (const slide of slides) {
    const title = String(slide && slide.title || "").trim();
    if (/\d+\s*\/\s*\d+/.test(title)) {
      score -= 8;
      notes.push("title_has_page_number");
    }
    if (/V\d|新版|执行版/i.test(title)) {
      score -= 5;
      notes.push("title_has_version_word");
    }

    const texts = Array.isArray(slide && slide.texts)
      ? slide.texts.map((x) => String(x || "").trim()).filter(Boolean)
      : [];

    if (!texts.length) {
      score -= 20;
      notes.push("empty_slide");
      continue;
    }

    if (texts.length <= 1) {
      score -= 10;
      notes.push("half_filled_slide");
    }

    const rep = detectRepetition(texts.join(" "));
    if (rep.maxCount > 3) {
      score -= rep.maxCount * 2;
      notes.push("high_repetition");
    }
  }

  score = clamp(Math.round(score), 0, 100);
  return { score, blockerCount, notes: Array.from(new Set(notes)) };
}

function parseArgs(argv) {
  const out = { reportDir: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "reportDir" && v) out.reportDir = v;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.reportDir) {
    throw new Error("missing --reportDir=<docs/benchmarks/results/variants/...>");
  }

  const absDir = path.isAbsolute(args.reportDir)
    ? args.reportDir
    : path.resolve(repoRoot, args.reportDir);

  const resultsPath = path.join(absDir, "results.json");
  const results = readJsonSafe(resultsPath, []);
  if (!Array.isArray(results) || !results.length) {
    throw new Error(`no results found: ${resultsPath}`);
  }

  const table = results.map((r) => {
    const newAuto = autoScoreDeckV2(r);
    return {
      seed: Number(r && r.seed || -1),
      systemScore: Number(r && r.qualityScore && r.qualityScore.overall || 0),
      oldAutoScore: Number(r && r.autoScore || 0),
      newAutoScore: Number(newAuto.score || 0),
      diff: Number((newAuto.score || 0) - Number(r && r.autoScore || 0))
    };
  });

  const outPath = path.join(absDir, "reevaluated_scores.json");
  fs.writeFileSync(outPath, JSON.stringify(table, null, 2), "utf8");
  console.table(table);
  console.log(`saved: ${path.relative(repoRoot, outPath).replace(/\\/g, "/")}`);
}

main();
