import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║         Day 0 完成度检查 & Day 1 准备状态             ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

const files = {
    '质量标准': 'docs/benchmarks/training/lazyman_standard.json',
    '学习规则': 'docs/benchmarks/training/learned_rules.json',
    '质检工具': 'tools/lazyman-quality-gate.mjs',
    '稳定性测试': 'tools/test-stability.mjs',
    '共同问题分析': 'docs/benchmarks/training/common_issues_analysis.json',
    'Day 1计划': 'docs/benchmarks/training/day1_plan.md',
    '主题多样性': 'docs/benchmarks/training/topic_diversity_check.json'
};

let missingCount = 0;
console.log('📁 核心文件检查:\n');
for (const [name, relPath] of Object.entries(files)) {
    const abs = path.resolve(repoRoot, relPath);
    const exists = fs.existsSync(abs);
    const icon = exists ? '✅' : '❌';
    console.log(`${icon} ${name}: ${exists ? '已创建' : '缺失'}`);
    if (!exists) {
        missingCount += 1;
    }
}

console.log(`\n${missingCount === 0 ? '✅ 所有文件就绪！' : `⚠️  ${missingCount}个文件缺失`}\n`);

try {
    const analysis = JSON.parse(
        fs.readFileSync(path.resolve(repoRoot, 'docs/benchmarks/training/common_issues_analysis.json'), 'utf8')
    );

    console.log('📊 质量指标:\n');
    console.log(`   当前LazyMan分数: ${analysis.avgLazymanScore}/100`);
    console.log(`   距离目标(95分): -${95 - parseFloat(analysis.avgLazymanScore)}`);
    console.log(
        `   主要问题: ${analysis.commonIssues?.[0]?.check || 'N/A'} (${analysis.commonIssues?.[0]?.percentage || '0%'})`
    );
    console.log(`   半填充率: ${analysis.avgDetails?.halfFilledRatio ?? 'N/A'} (目标≤0.15)\n`);
} catch {
    console.log('⚠️  无法读取质量指标\n');
}

try {
    const diversity = JSON.parse(
        fs.readFileSync(path.resolve(repoRoot, 'docs/benchmarks/training/topic_diversity_check.json'), 'utf8')
    ).diversity;

    console.log('🎯 主题多样性验证:\n');
    console.log(`   ${diversity.warning}`);
    console.log(`   唯一标题数: ${diversity.uniqueTitles}/${diversity.totalSamples}`);

    if (diversity.topicEffective) {
        console.log('\n✅ Day 1任务: 只需修复lowHalfFilled（30分钟）');
    } else {
        console.log('\n⚠️  Day 1任务: 修复topic参数 + lowHalfFilled（60分钟）');
    }
} catch {
    console.log('🎯 主题多样性验证:\n');
    console.log('   ❌ 未运行！请执行: node tools/verify-topic-diversity.mjs\n');
    console.log('⚠️  Day 1任务: 不确定，需先验证topic是否生效');
}

console.log('\n');
console.log('╔════════════════════════════════════════════════════════╗');
console.log('║                   下一步操作                           ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

if (missingCount === 0) {
    console.log('1. 如果还没运行: node tools/verify-topic-diversity.mjs');
    console.log('2. 查看Day 1计划: Get-Content docs/benchmarks/training/day1_plan.md');
    console.log('3. 睡个好觉，明天30-60分钟达到LazyMan水准！');
} else {
    console.log('1. 运行缺失的脚本（见上方❌标记）');
    console.log('2. 重新运行此检查: node tools/day0-status-check.mjs');
}

console.log('');
