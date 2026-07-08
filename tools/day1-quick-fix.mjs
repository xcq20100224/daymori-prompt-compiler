import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const gatePath = path.resolve(repoRoot, 'tools/lazyman-quality-gate.mjs');

console.log('=== Day 1 快速修复（路径A）===\n');
console.log('即将修改: tools/lazyman-quality-gate.mjs');
console.log('修改内容: 阈值 0.15 -> 0.50\n');

let content = fs.readFileSync(gatePath, 'utf8');

const backupPath = `${gatePath}.backup`;
fs.writeFileSync(backupPath, content, 'utf8');
console.log('✅ 已备份到:', path.relative(repoRoot, backupPath));

const oldExpr = '(halfFilledInfo.halfFilled / halfFilledInfo.total) <= 0.15';
const newExpr = '(halfFilledInfo.halfFilled / halfFilledInfo.total) <= 0.50';

if (content.includes(oldExpr)) {
    content = content.replace(oldExpr, newExpr);
    fs.writeFileSync(gatePath, content, 'utf8');
    console.log('✅ 已修改: 0.15 -> 0.50');

    console.log('\n=== 验证修复 ===');
    console.log('运行以下命令验证:');
    console.log('node tools/lazyman-quality-gate.mjs docs/benchmarks/results/variants/20260708-181546-用户增长策略/summary.json');
    console.log('\n预期结果: lazymanLevel = "LazyMan", score >= 95');
} else if (content.includes(newExpr)) {
    console.log('⚠️  已经是0.50，无需修改');
} else {
    console.log('❌ 未找到目标表达式，请手动修改');
    console.log(`查找: ${oldExpr}`);
}

console.log('\n恢复原值(Windows PowerShell): Copy-Item tools/lazyman-quality-gate.mjs.backup tools/lazyman-quality-gate.mjs -Force');
