import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

const samples = [
    {
        name: '用户增长策略',
        summaryPath: 'docs/benchmarks/results/variants/20260708-181546-用户增长策略/summary.json'
    },
    {
        name: '新产品上市计划',
        summaryPath: 'docs/benchmarks/results/variants/20260708-181632-新产品上市计划/summary.json'
    },
    {
        name: '客户留存提升方案',
        summaryPath: 'docs/benchmarks/results/variants/20260708-181717-客户留存提升方案/summary.json'
    }
];

function readJsonSafe(relPath) {
    try {
        const abs = path.resolve(repoRoot, relPath);
        return JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
        console.error(`读取失败: ${relPath}`, err.message);
        return null;
    }
}

console.log('=== 主题多样性验证 ===\n');

const results = [];

for (const sample of samples) {
    const summary = readJsonSafe(sample.summaryPath);
    if (!summary) {
        continue;
    }

    const best = summary.best || {};
    const dump = best.dump || {};
    const slides = dump.slides || [];

    const titles = slides.slice(0, 3).map((s) => s.title || '').filter(Boolean);
    const allText = slides
        .flatMap((s) => s.texts || [])
        .join(' ')
        .slice(0, 100);

    results.push({
        topic: sample.name,
        expectTopic: summary.topic || sample.name,
        titleCount: titles.length,
        firstTitle: titles[0] || '',
        textPreview: allText || ''
    });

    console.log(`主题: ${sample.name}`);
    console.log(`  封面标题: ${titles[0] || 'N/A'}`);
    console.log(`  内容预览: ${allText.slice(0, 50)}...`);
    console.log('');
}

const uniqueTitles = new Set(results.map((r) => r.firstTitle));
const uniqueTexts = new Set(results.map((r) => r.textPreview));

const diversity = {
    totalSamples: results.length,
    uniqueTitles: uniqueTitles.size,
    uniqueTextPreviews: uniqueTexts.size,
    topicEffective: uniqueTitles.size === results.length,
    warning:
        uniqueTitles.size < results.length
            ? '⚠️  检测到重复标题，topic参数可能未生效'
            : '✅ 所有主题标题不同，topic参数生效'
};

console.log('=== 多样性分析 ===');
console.log(JSON.stringify(diversity, null, 2));

const outPath = path.resolve(repoRoot, 'docs/benchmarks/training/topic_diversity_check.json');
fs.writeFileSync(outPath, JSON.stringify({ diversity, samples: results }, null, 2), 'utf8');
console.log(`\n✅ 已保存到: ${path.relative(repoRoot, outPath)}`);

if (!diversity.topicEffective) {
    console.log('\n⚠️  警告：需要在Day 1修复topic生效问题');
    process.exit(1);
}
