import fs from "node:fs";
import path from "node:path";
import { lazymanQualityGate } from "./lazyman-quality-gate.mjs";
import { analyzePptxFile } from "./ppt-quality-metrics.mjs";
import { loadLazymanStandard } from "./lazyman-standard.mjs";

const repoRoot = process.cwd();
const standard = loadLazymanStandard();

function findAllVariantDirs() {
  const variantsRoot = path.resolve(
    repoRoot,
    "docs/benchmarks/results/variants",
  );
  if (!fs.existsSync(variantsRoot)) return [];
  return fs
    .readdirSync(variantsRoot)
    .map((name) => ({
      name,
      abs: path.join(variantsRoot, name),
      mtime: fs.statSync(path.join(variantsRoot, name)).mtimeMs,
    }))
    .filter((x) => fs.existsSync(x.abs) && fs.statSync(x.abs).isDirectory())
    .sort((a, b) => b.mtime - a.mtime);
}

function diagnoseDeckPPTX(variantDir) {
  const summaryPath = path.join(variantDir.abs, "summary.json");
  if (!fs.existsSync(summaryPath)) return null;

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const best = summary.best || null;
  if (!best) return null;
  const bestRel = summary.best?.relativePath;
  if (!bestRel) return null;

  const pptxPath = path.resolve(repoRoot, bestRel);
  if (!fs.existsSync(pptxPath)) return null;

  const pptMetrics = analyzePptxFile(pptxPath);
  const gate = lazymanQualityGate({
    ...best,
    pptMetrics,
  });

  return {
    variantDir: variantDir.name,
    pptxPath: path.relative(repoRoot, pptxPath).replace(/\\/g, "/"),
    score: gate.score,
    level: gate.lazymanLevel,
    pageNumberPages: Array.isArray(pptMetrics.pageNumberSlides)
      ? pptMetrics.pageNumberSlides.length
      : 0,
    halfFilledPages: Array.isArray(pptMetrics.halfFilledSlides)
      ? pptMetrics.halfFilledSlides.length
      : 0,
    totalPages: Number(pptMetrics.slideCount || 0),
    topic: summary.topic || "",
    autoScore: best.autoScore || 0,
    systemScore: best.qualityScore?.overall || 0,
    gatePassed: Boolean(gate.passed),
    failedChecks: gate.failedChecks || [],
  };
}

function pct(part, total) {
  if (!total) return "0.0";
  return ((part / total) * 100).toFixed(1);
}

function main() {
  const args = process.argv.slice(2);
  const limit = args[0] ? parseInt(args[0], 10) : 20;

  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║         批量变体诊断分析                               ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  const dirs = findAllVariantDirs().slice(
    0,
    Number.isFinite(limit) ? limit : 20,
  );
  console.log(
    `找到 ${dirs.length} 个变体目录（最新${Number.isFinite(limit) ? limit : 20}个）\n`,
  );

  const results = [];

  for (let i = 0; i < dirs.length; i += 1) {
    console.log(`[${i + 1}/${dirs.length}] 诊断 ${dirs[i].name}...`);
    const result = diagnoseDeckPPTX(dirs[i]);
    if (result) results.push(result);
  }

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║              诊断结果汇总                              ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  results.sort((a, b) => b.score - a.score);

  console.log("Top 10 高质量样本:\n");
  results.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.variantDir}`);
    console.log(`   分数: ${r.score}/100 (${r.level})`);
    console.log(
      `   页码: ${r.pageNumberPages}页 | 半填充: ${r.halfFilledPages}/${r.totalPages}`,
    );
    console.log(
      `   门禁: ${r.gatePassed ? "通过" : "失败"}${r.failedChecks.length ? ` | 失败项: ${r.failedChecks.join(",")}` : ""}`,
    );
    console.log(`   主题: ${r.topic}\n`);
  });

  console.log("\n低质量样本 (分数<60):\n");
  const lowQuality = results.filter((r) => r.score < 60);
  lowQuality.forEach((r) => {
    console.log(`- ${r.variantDir}: ${r.score}分`);
    console.log(
      `  问题: 页码${r.pageNumberPages} 半填充${r.halfFilledPages}/${r.totalPages} 失败项:${r.failedChecks.join(",")}\n`,
    );
  });

  const sampleCount = results.length;
  const avgScore = sampleCount
    ? results.reduce((sum, r) => sum + r.score, 0) / sampleCount
    : 0;
  const lazymanCount = results.filter((r) => r.score >= 95).length;
  const nearLazymanCount = results.filter(
    (r) => r.score >= 88 && r.score < 95,
  ).length;
  const passCount = results.filter((r) => r.gatePassed).length;

  console.log("\n统计分析:\n");
  console.log(`  总样本数: ${sampleCount}`);
  console.log(`  平均分数: ${avgScore.toFixed(1)}/100`);
  console.log(
    `  LazyMan级(>=95): ${lazymanCount} (${pct(lazymanCount, sampleCount)}%)`,
  );
  console.log(
    `  Near-LazyMan(88-94): ${nearLazymanCount} (${pct(nearLazymanCount, sampleCount)}%)`,
  );
  console.log(`  Gate通过率: ${passCount} (${pct(passCount, sampleCount)}%)`);
  console.log(
    `  低质量(<60): ${lowQuality.length} (${pct(lowQuality.length, sampleCount)}%)\n`,
  );

  const outputPath = path.resolve(
    repoRoot,
    "docs/benchmarks/training/batch_diagnosis_results.json",
  );
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        sampleCount,
        avgScore,
        lazymanRate: sampleCount ? lazymanCount / sampleCount : 0,
        nearLazymanRate: sampleCount ? nearLazymanCount / sampleCount : 0,
        gatePassRate: sampleCount ? passCount / sampleCount : 0,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `✅ 结果已保存: ${path.relative(repoRoot, outputPath).replace(/\\/g, "/")}\n`,
  );

  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║              优化建议                                  ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  const totalPageNum = results.reduce((sum, r) => sum + r.pageNumberPages, 0);
  const validHalfFilled = results.filter((r) => r.totalPages > 0);
  const avgHalfFilledRatio = validHalfFilled.length
    ? validHalfFilled.reduce(
        (sum, r) => sum + r.halfFilledPages / r.totalPages,
        0,
      ) / validHalfFilled.length
    : 0;

  if (totalPageNum > sampleCount * 0.1) {
    console.log("P0: 页码标注问题");
    console.log(`   影响: ${totalPageNum}页次`);
    console.log("   建议: 检查prompt是否明确禁止页码\n");
  }

  const halfFilledThreshold = Number(
    (standard.gate && standard.gate.halfFilledThreshold) || 0.15,
  );
  if (avgHalfFilledRatio > halfFilledThreshold) {
    console.log("P1: 内容密度不足");
    console.log(
      `   平均半填充率: ${(avgHalfFilledRatio * 100).toFixed(1)}% (目标<=${(halfFilledThreshold * 100).toFixed(0)}%)`,
    );
    console.log("   建议: 强化prompt中的内容密度要求\n");
  }

  console.log("下一步:\n");
  console.log("1. 如果LazyMan率<30%: 执行大规模优化循环（生成50+样本）");
  console.log("2. 如果LazyMan率30-70%: 针对性修复topバグ问题");
  console.log("3. 如果LazyMan率>70%: 进入稳定性验证阶段\n");
}

main();
