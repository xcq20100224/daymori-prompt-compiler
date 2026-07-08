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

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function toRelativeDumpPathFromPptPath(pptPath) {
  if (!pptPath || typeof pptPath !== "string") return "";
  const normalized = pptPath.replace(/\\/g, "/").trim();
  if (!/\.pptx$/i.test(normalized)) return "";
  return normalized.replace(/\/deck\.pptx$/i, "/dump.json");
}

function readDumpSlidesFromRelativePath(relPath) {
  if (!relPath) return [];
  const abs = path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot, relPath);
  const dump = readJsonSafe(abs, null);
  return Array.isArray(dump && dump.slides) ? dump.slides : [];
}

function extractSlides(sample) {
  const directSlides = Array.isArray(sample && sample.dump && sample.dump.slides)
    ? sample.dump.slides
    : [];
  if (directSlides.length) return directSlides;

  const example = sample && sample.example ? sample.example : null;
  const pptPath = (example && example.pptPath) || (sample && sample.pptPath) || "";
  const requestId = (example && example.requestId) || (sample && sample.requestId) || "";

  const fromPptPath = readDumpSlidesFromRelativePath(toRelativeDumpPathFromPptPath(pptPath));
  if (fromPptPath.length) return fromPptPath;

  if (requestId) {
    const rel = path.join("docs", "benchmarks", "results", "exports", String(requestId), "dump.json");
    const fromRequestId = readDumpSlidesFromRelativePath(rel);
    if (fromRequestId.length) return fromRequestId;
  }

  const fallbackTitle = String((example && example.title) || (sample && sample.title) || "").trim();
  const fallbackTexts = [];
  if (example && example.subtitle) fallbackTexts.push(String(example.subtitle).trim());
  if (Array.isArray(example && example.items)) {
    for (const it of example.items) {
      const label = String(it && it.label || "").trim();
      const desc = String(it && it.desc || "").trim();
      const line = [label, desc].filter(Boolean).join("：");
      if (line) fallbackTexts.push(line);
    }
  }

  if (fallbackTitle || fallbackTexts.length) {
    return [{ title: fallbackTitle, texts: fallbackTexts }];
  }

  return [];
}

function extractFeatures(samples) {
  const titleLengths = [];
  let metadataCount = 0;
  let emptyCount = 0;
  let totalSlides = 0;

  for (const sample of samples) {
    const slides = extractSlides(sample);
    for (const s of slides) {
      totalSlides += 1;
      const title = String(s && s.title || "").trim();
      if (title) titleLengths.push(title.length);
      if (/V\d|新版|执行版|修订版|\d+\s*\/\s*\d+/i.test(title)) metadataCount += 1;

      const texts = Array.isArray(s && s.texts) ? s.texts.map((x) => String(x || "").trim()).filter(Boolean) : [];
      if (!texts.length || texts.length <= 1) emptyCount += 1;
    }
  }

  return {
    avgTitleLength: Number(average(titleLengths).toFixed(2)),
    metadataRate: totalSlides ? Number((metadataCount / totalSlides).toFixed(4)) : 0,
    emptyRate: totalSlides ? Number((emptyCount / totalSlides).toFixed(4)) : 0,
    totalSlides
  };
}

function compareGoldenVsBad() {
  const goldenFile = path.resolve(repoRoot, "docs", "benchmarks", "training", "golden_samples.json");
  const badFile = path.resolve(repoRoot, "docs", "benchmarks", "training", "bad_samples.jsonl");
  const goldenRaw = readJsonSafe(goldenFile, []);
  const goldenSamples = Array.isArray(goldenRaw)
    ? goldenRaw.map((x) => x && x.example ? x.example : x).filter(Boolean)
    : [];

  const badLines = fs.existsSync(badFile)
    ? fs.readFileSync(badFile, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  const badSamples = badLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const goldenFeatures = extractFeatures(goldenSamples);
  const badFeatures = extractFeatures(badSamples);
  const insights = [];

  if (goldenFeatures.avgTitleLength && badFeatures.avgTitleLength) {
    const titleDiff = Math.abs(goldenFeatures.avgTitleLength - badFeatures.avgTitleLength);
    if (titleDiff > 0.5) {
      insights.push({
        rule: goldenFeatures.avgTitleLength < badFeatures.avgTitleLength ? "标题应该更简洁" : "标题不应太短",
        evidence: `好样本平均${goldenFeatures.avgTitleLength}字，坏样本${badFeatures.avgTitleLength}字`,
        strength: Number(titleDiff.toFixed(2))
      });
    }
  }

  const metadataDiff = Math.abs(goldenFeatures.metadataRate - badFeatures.metadataRate);
  if (metadataDiff > 0.001 || badFeatures.metadataRate > 0) {
    insights.push({
      rule: "标题不应含元数据（页码、版本号等）",
      evidence: `好样本污染率${goldenFeatures.metadataRate.toFixed(4)}，坏样本${badFeatures.metadataRate.toFixed(4)}`,
      strength: Number(metadataDiff.toFixed(4))
    });
  }

  const emptyDiff = Math.abs(goldenFeatures.emptyRate - badFeatures.emptyRate);
  if (emptyDiff > 0.001 || badFeatures.emptyRate > 0) {
    insights.push({
      rule: "不应有空内容页或半填充页",
      evidence: `好样本空页率${goldenFeatures.emptyRate.toFixed(4)}，坏样本${badFeatures.emptyRate.toFixed(4)}`,
      strength: Number(emptyDiff.toFixed(4))
    });
  }

  insights.push({
    rule: "避免页面内文本高频重复（如Q&A重复3次）",
    evidence: "已观察到多个样本存在此问题",
    strength: 0.5
  });

  insights.push({
    rule: "标题区域不应出现页码（如2/10、5/10）",
    evidence: "已观察到section页和部分content页出现页码污染",
    strength: 0.8
  });

  insights.push({
    rule: "封面与章节页避免复写同一句文本",
    evidence: "可降低模板位重复填充导致的观感噪音",
    strength: 0.4
  });

  insights.push({
    rule: "正文优先使用场景化动作句，避免空泛陈述",
    evidence: "可提升contentSpecificity并减少半填充风险",
    strength: 0.4
  });

  const outFile = path.resolve(repoRoot, "docs", "benchmarks", "training", "learned_rules.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(insights, null, 2), "utf8");

  return { insights, goldenFeatures, badFeatures, outFile };
}

function buildPromptWithLearnedRules(basePrompt, learnedRules) {
  const rulePrompt = learnedRules
    .slice()
    .sort((a, b) => Number(b.strength || 0) - Number(a.strength || 0))
    .slice(0, 5)
    .map((r) => `- ${r.rule}（${r.evidence}）`)
    .join("\n");

  return [
    basePrompt,
    "",
    "【从历史样本中学到的重要规则】",
    rulePrompt || "- 暂无有效规则，保持标题简洁、内容完整。",
    "",
    "请严格遵守以上规则。"
  ].join("\n");
}

function main() {
  const { insights, goldenFeatures, badFeatures, outFile } = compareGoldenVsBad();
  const demoPrompt = buildPromptWithLearnedRules("请生成企业提案风格PPT内容", insights);

  console.log(JSON.stringify({
    ok: true,
    learnedRules: insights.length,
    goldenFeatures,
    badFeatures,
    output: path.relative(repoRoot, outFile).replace(/\\/g, "/"),
    promptPreview: demoPrompt
  }, null, 2));
}

main();
