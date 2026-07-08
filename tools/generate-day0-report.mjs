import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const standard = {
  avgScore: 95,
  passRate: 90,
  lazymanCount: 18
};

const current = {
  avgScore: 94,
  successRate: 100,
  unstableRate: 'unknown'
};

const report = `# Day 0 完成报告

生成时间: ${new Date().toISOString()}

## 已完成的工作

1. learned_rules.json: 5条规则（当前版本）
   - 页码污染检测（strength: 0.8）
   - 重复文本检测（strength: 0.5）
   - 半填充检测（strength: 0.0094）

2. trends.json: 记录了94分突破
   - 3个主题达到94分
   - 时间: 2026-07-08 10:24

3. 系统能力验证
   - API稳定性: 待最新稳定性脚本确认
   - 生成质量: 94分（距目标95分差1分）

## 关键问题

### 问题1: 质量不稳定
- 最好成绩: 94分（用户增长策略等3个主题）
- 最近存在: 0分批次（酸碱中和反应等主题）
- 需要确认: 是API问题还是topic不生效？

### 问题2: Day0质检工具
- lazyman_standard.json: 已创建
- lazyman-quality-gate.mjs: 已创建
- current_baseline.json: 待生成

## 与LazyMan标准的差距

| 指标 | LazyMan标准 | 当前最好 | 差距 |
|------|-------------|----------|------|
| avgScore | ${standard.avgScore} | ${current.avgScore} | -1 |
| 通过率 | ${standard.passRate}% | ? | 需验证 |
| 稳定性 | 高 | 低 | 关键问题 |

## 明天（Day 1）的任务

### P0: 稳定在94分
1. 运行稳定性测试（test-stability.mjs）
2. 如果失败，修复API或topic生效问题
3. 确保5个不同主题都能达到90+分

### P1: 冲击95分
1. 分析94分样本的failedChecks
2. 修复Top 2失败原因
3. 重新生成验证

### 验证标准
- 5个主题的成功率 >= 80%
- 5个主题的平均分 >= 92
- 至少2个主题达到95+

## 下一步操作

\`\`\`bash
node tools/test-stability.mjs

node tools/lazyman-quality-gate.mjs \\
  docs/benchmarks/results/variants/20260708-181546-用户增长策略/summary.json
\`\`\`
`;

const targetDir = path.resolve(repoRoot, 'docs/benchmarks/training');
fs.mkdirSync(targetDir, { recursive: true });

const outPath = path.resolve(targetDir, 'day0_report.md');
fs.writeFileSync(outPath, report, 'utf8');

console.log('Day 0报告已生成: docs/benchmarks/training/day0_report.md');
