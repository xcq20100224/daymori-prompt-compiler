import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const gateFiles = [
  'docs/benchmarks/training/sample1_gate.json',
  'docs/benchmarks/training/sample2_gate.json',
  'docs/benchmarks/training/sample3_gate.json'
];

function readJsonAutoEncoding(absPath) {
  const buf = fs.readFileSync(absPath);
  let text;

  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.slice(2).toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }

  // Remove potential UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return JSON.parse(text);
}

const allGates = gateFiles
  .map((f) => {
    const abs = path.resolve(repoRoot, f);
    return fs.existsSync(abs) ? readJsonAutoEncoding(abs) : null;
  })
  .filter(Boolean);

if (allGates.length === 0) {
  console.error('No gate files found.');
  process.exit(1);
}

const failedCount = {};
allGates.forEach((g) => {
  (g.failedChecks || []).forEach((check) => {
    failedCount[check] = (failedCount[check] || 0) + 1;
  });
});

const sorted = Object.entries(failedCount)
  .sort((a, b) => b[1] - a[1])
  .map(([check, count]) => ({
    check,
    frequency: count,
    percentage: `${((count / allGates.length) * 100).toFixed(0)}%`
  }));

const avgDetails = {
  autoScore: (
    allGates.reduce((sum, g) => sum + (g.details?.autoScore || 0), 0) / allGates.length
  ).toFixed(1),
  systemScore: (
    allGates.reduce((sum, g) => sum + (g.details?.systemScore || 0), 0) / allGates.length
  ).toFixed(1),
  maxRepetition: (
    allGates.reduce((sum, g) => sum + (g.details?.maxRepetition || 0), 0) / allGates.length
  ).toFixed(1),
  titleVariance: (
    allGates.reduce((sum, g) => sum + (g.details?.titleVariance || 0), 0) / allGates.length
  ).toFixed(1),
  halfFilledRatio: (
    allGates.reduce((sum, g) => sum + parseFloat(g.details?.halfFilledRatio || 0), 0) /
    allGates.length
  ).toFixed(2)
};

const report = {
  sampleCount: allGates.length,
  avgLazymanScore: (
    allGates.reduce((sum, g) => sum + (g.score || 0), 0) / allGates.length
  ).toFixed(0),
  commonIssues: sorted,
  avgDetails,
  recommendation:
    sorted.length > 0
      ? `修复Top 1问题\"${sorted[0].check}\"可让${sorted[0].percentage}的样本提升到LazyMan级`
      : '所有样本已达LazyMan标准'
};

const outPath = path.resolve(repoRoot, 'docs/benchmarks/training/common_issues_analysis.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify(report, null, 2));
console.log(`\n✅ 已保存到: ${path.relative(repoRoot, outPath)}`);
