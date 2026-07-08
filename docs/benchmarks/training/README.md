# LazyMan质量训练系统文档

## Day 0 完成产物

### 核心文件
- `lazyman_standard.json` - LazyMan质量标准定义
- `learned_rules.json` - 从历史样本学到的5条规则
- `trends.json` - 质量趋势记录（最高94分）

### 分析报告
- `day0_report.md` - Day 0总结（含实际完成情况）
- `common_issues_analysis.json` - 共同问题统计（100%是lowHalfFilled）
- `day1_plan.md` - Day 1修复计划（+7分路线图）
- `topic_diversity_check.json` - 主题多样性验证

### 质检数据
- `sample1_gate.json` - 用户增长策略（88分）
- `sample2_gate.json` - 新产品上市计划（88分）
- `sample3_gate.json` - 客户留存提升方案（88分）

## 快速启动

### 验证当前状态
```bash
# 一键运行所有检查
npm run day0:check

# 或手动运行
node tools/test-stability.mjs
node tools/analyze-common-issues.mjs
node tools/verify-topic-diversity.mjs
```

### Day 1 修复流程
```bash
# 路径A：调整阈值（5分钟）
# 修改 tools/lazyman-quality-gate.mjs:73
# 0.15 → 0.50

# 路径B：修复生成逻辑（30分钟）
# 修改 tools/run-variant-batch.mjs
# 增强content页的内容密度要求

# 验证修复
node tools/run-variant-batch.mjs --topic="测试修复" --count=3
node tools/lazyman-quality-gate.mjs <新生成的summary.json>
```

## 指标定义

### LazyMan分数（quality-gate评分）
- 95-100分：LazyMan级
- 88-94分：Near-LazyMan级
- 75-87分：Good级
- <75分：Needs-Work级

### 检查项（8项）
1. autoScore ≥ 90
2. systemScore ≥ 92
3. noBlockers = 0
4. noPageNumbers = true
5. noMetadata = true
6. lowRepetition (maxCount ≤ 3)
7. titleVarianceOK (variance ≤ 50)
8. lowHalfFilled (ratio ≤ 0.15)  ← 当前唯一失败项

## 文件依赖关系

```
trends.json (历史记录)
   ↓
sample*_gate.json (质检结果)
   ↓
common_issues_analysis.json (问题汇总)
   ↓
day1_plan.md (修复计划)
```
