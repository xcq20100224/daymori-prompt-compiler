import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLazymanStandard } from "./lazyman-standard.mjs";

const repoRoot = process.cwd();

function readJsonSafe(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function hasPageNumbers(dump) {
  const slides = dump?.slides || [];
  return slides.some((s) => /\d+\s*\/\s*\d+/.test(s.title || ""));
}

function hasMetadata(dump) {
  const slides = dump?.slides || [];
  return slides.some((s) => /V\d|新版|修订版|执行版/i.test(s.title || ""));
}

function maxRepetition(dump) {
  const slides = dump?.slides || [];
  let maxCount = 0;

  slides.forEach((s) => {
    const texts = (s.texts || []).join(" ");
    const tokens =
      texts.toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]+/g) || [];
    const freq = {};
    tokens.forEach((t) => {
      freq[t] = (freq[t] || 0) + 1;
    });
    maxCount = Math.max(maxCount, ...Object.values(freq), 0);
  });

  return maxCount;
}

function titleLengthVariance(dump) {
  const slides = dump?.slides || [];
  const lengths = slides
    .map((s) => (s.title || "").trim().length)
    .filter((l) => l > 0);
  if (lengths.length < 2) return 0;

  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance =
    lengths.reduce((acc, len) => acc + Math.pow(len - mean, 2), 0) /
    lengths.length;
  return Math.round(variance);
}

function countHalfFilledSlides(dump) {
  const slides = dump?.slides || [];
  const contentSlides = slides.filter((s) => {
    const type = s.type || "";
    return type !== "cover" && type !== "section" && type !== "qa";
  });

  const halfFilled = contentSlides.filter((s) => {
    const textCount = (s.texts || []).filter(
      (t) => (t || "").trim().length > 0,
    ).length;
    return textCount <= 2;
  }).length;

  return { halfFilled, total: contentSlides.length };
}

export function lazymanQualityGate(result) {
  const standard = loadLazymanStandard();
  const gateRules = standard.gate || {};
  const dump = result.dump || {};
  const pptMetrics = result.pptMetrics || null;
  const halfFilledThreshold = Number(gateRules.halfFilledThreshold || 0.15);
  const autoScoreMin = Number(standard.coreMetrics?.autoScore?.min || 90);
  const systemScoreMin = Number(standard.coreMetrics?.systemScore?.min || 92);
  const maxRepetitionAllowed = Number(gateRules.maxRepetition || 3);
  const maxTitleVarianceAllowed = Number(gateRules.maxTitleVariance || 50);
  const minContentCoverage = Number(gateRules.minContentCoverage || 0.98);

  const pageNumbersFound = pptMetrics
    ? Array.isArray(pptMetrics.pageNumberSlides) &&
      pptMetrics.pageNumberSlides.length > 0
    : hasPageNumbers(dump);
  const metadataFound = pptMetrics
    ? Array.isArray(pptMetrics.metadataSlides) &&
      pptMetrics.metadataSlides.length > 0
    : hasMetadata(dump);

  const computedMaxRepetition = maxRepetition(dump);
  const computedTitleVariance = titleLengthVariance(dump);
  const halfFilledInfo = countHalfFilledSlides(dump);
  const dumpHalfFilledRatio =
    halfFilledInfo.total > 0
      ? halfFilledInfo.halfFilled / halfFilledInfo.total
      : 0;
  const halfFilledRatio =
    pptMetrics && Number.isFinite(Number(pptMetrics.halfFilledRatio))
      ? Number(pptMetrics.halfFilledRatio)
      : dumpHalfFilledRatio;
  const contentCoverage =
    pptMetrics && Number.isFinite(Number(pptMetrics.contentCoverage))
      ? Number(pptMetrics.contentCoverage)
      : 1;

  const checks = {
    autoScore: (result.autoScore || 0) >= autoScoreMin,
    systemScore: (result.qualityScore?.overall || 0) >= systemScoreMin,
    noBlockers: (result.blockerCount || 0) === 0,
    noPageNumbers: !pageNumbersFound,
    noMetadata: !metadataFound,
    lowRepetition: computedMaxRepetition <= maxRepetitionAllowed,
    titleVarianceOK: computedTitleVariance <= maxTitleVarianceAllowed,
    contentCoverageOK: contentCoverage >= minContentCoverage,
  };
  checks.lowHalfFilled = halfFilledRatio <= halfFilledThreshold;

  const passedCount = Object.values(checks).filter((v) => v === true).length;
  const totalCount = Object.keys(checks).length;
  const score = Math.round((passedCount / totalCount) * 100);

  let level = "Needs-Work";
  if (score >= Number(gateRules.lazyManScore || 95)) level = "LazyMan";
  else if (score >= Number(gateRules.nearLazyManScore || 88))
    level = "Near-LazyMan";
  else if (score >= 75) level = "Good";

  const failedChecks = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return {
    passed: score >= Number(gateRules.passScore || 88),
    score,
    lazymanLevel: level,
    checks,
    failedChecks,
    details: {
      autoScore: result.autoScore || 0,
      systemScore: result.qualityScore?.overall || 0,
      blockerCount: result.blockerCount || 0,
      pageNumbersFound,
      metadataFound,
      maxRepetition: computedMaxRepetition,
      titleVariance: computedTitleVariance,
      contentCoverage: contentCoverage.toFixed(3),
      halfFilledRatio: halfFilledRatio.toFixed(2),
      threshold: {
        autoScoreMin,
        systemScoreMin,
        passScore: Number(gateRules.passScore || 88),
        halfFilledThreshold,
        minContentCoverage,
      },
    },
  };
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log("用法: node tools/lazyman-quality-gate.mjs <summary.json路径>");
    process.exit(1);
  }

  const summaryPath = path.resolve(repoRoot, args[0]);
  const summary = readJsonSafe(summaryPath, null);
  if (!summary) {
    console.error("无法读取:", summaryPath);
    process.exit(1);
  }

  const gate = lazymanQualityGate(summary.best || summary);
  console.log(JSON.stringify(gate, null, 2));
}
