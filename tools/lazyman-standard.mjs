import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const STANDARD_PATH = path.resolve(
  repoRoot,
  "docs",
  "benchmarks",
  "training",
  "lazyman_standard.json",
);

const DEFAULT_STANDARD = {
  coreMetrics: {
    autoScore: { min: 90 },
    systemScore: { min: 92 },
  },
  shouldMinimize: [{ rule: "half_filled_slides", threshold: 0.15 }],
  gate: {
    passScore: 88,
    lazyManScore: 95,
    nearLazyManScore: 88,
    maxRepetition: 3,
    maxTitleVariance: 50,
    minContentCoverage: 0.98,
  },
};

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadLazymanStandard() {
  const raw = readJsonSafe(STANDARD_PATH, {});
  const halfFilledRule = Array.isArray(raw.shouldMinimize)
    ? raw.shouldMinimize.find(
        (x) => String((x && x.rule) || "") === "half_filled_slides",
      )
    : null;

  return {
    coreMetrics: {
      autoScore: {
        min:
          Number(raw?.coreMetrics?.autoScore?.min) ||
          DEFAULT_STANDARD.coreMetrics.autoScore.min,
      },
      systemScore: {
        min:
          Number(raw?.coreMetrics?.systemScore?.min) ||
          DEFAULT_STANDARD.coreMetrics.systemScore.min,
      },
    },
    gate: {
      passScore:
        Number(raw?.gate?.passScore) || DEFAULT_STANDARD.gate.passScore,
      lazyManScore:
        Number(raw?.gate?.lazyManScore) || DEFAULT_STANDARD.gate.lazyManScore,
      nearLazyManScore:
        Number(raw?.gate?.nearLazyManScore) ||
        DEFAULT_STANDARD.gate.nearLazyManScore,
      maxRepetition:
        Number(raw?.gate?.maxRepetition) || DEFAULT_STANDARD.gate.maxRepetition,
      maxTitleVariance:
        Number(raw?.gate?.maxTitleVariance) ||
        DEFAULT_STANDARD.gate.maxTitleVariance,
      minContentCoverage:
        Number(raw?.gate?.minContentCoverage) ||
        DEFAULT_STANDARD.gate.minContentCoverage,
      halfFilledThreshold:
        Number(halfFilledRule && halfFilledRule.threshold) ||
        DEFAULT_STANDARD.shouldMinimize[0].threshold,
    },
  };
}
