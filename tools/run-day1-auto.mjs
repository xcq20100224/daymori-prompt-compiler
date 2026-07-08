import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

function run(cmd, desc) {
    console.log(`\n[执行] ${desc}...`);
    try {
        execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
        return true;
    } catch {
        console.error(`❌ ${desc} 失败`);
        return false;
    }
}

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║              Day 1 自动化执行流程                      ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

if (!run('node tools/day0-status-check.mjs', '状态检查')) {
    process.exit(1);
}

console.log('\n是否需要修复topic? (检查上面的输出)');
console.log('如果看到 "⚠️  检测到重复标题"，请先手动修复 run-variant-batch.mjs\n');

if (!run('node tools/day1-quick-fix.mjs', '快速修复')) {
    process.exit(1);
}

const samples = [
    'docs/benchmarks/results/variants/20260708-181546-用户增长策略/summary.json',
    'docs/benchmarks/results/variants/20260708-181632-新产品上市计划/summary.json',
    'docs/benchmarks/results/variants/20260708-181717-客户留存提升方案/summary.json'
];

for (const sample of samples) {
    if (fs.existsSync(path.resolve(repoRoot, sample))) {
        run(`node tools/lazyman-quality-gate.mjs ${sample}`, `验证 ${path.basename(path.dirname(sample))}`);
    }
}

run('node tools/analyze-common-issues.mjs', '最终质检');
run('node tools/generate-day1-complete-report.mjs', '生成完成报告');

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║              Day 1 自动化流程完成！                    ║');
console.log('╚════════════════════════════════════════════════════════╝\n');
console.log('查看报告: Get-Content docs/benchmarks/training/day1_complete_report.md\n');
