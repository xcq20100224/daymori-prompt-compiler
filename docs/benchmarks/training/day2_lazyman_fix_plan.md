# Day 2 LazyMan级质量修复方案

基于实际生成PPT的诊断结果

## 当前PPT问题诊断（17.pptx）

### P0问题（Blocker级）
1. ❌ 水印污染：多页出现"内容由AI生成"
2. ❌ 页码污染：多页出现"1/10", "5/10"等标注

### P1问题（Critical级）
3. ❌ 内容空洞：大量页面只有1-2句话
4. ❌ 标题重复："AI客服降本增效方案"出现过多

### P2问题（High级）
5. ⚠️ 结构不完整：缺少目录、Q&A
6. ⚠️ 视觉元素少：大部分页面纯文本

## 修复执行顺序

### Phase 1: 清理模板污染（10分钟）
```bash
node tools/clean-template-watermarks.mjs
ls docs/benchmarks/templates/inbox/*.watermark-backup
```

### Phase 2: 增强生成prompt（20分钟）
修改 tools/run-variant-batch.mjs 的 buildContract：

- 添加【禁止事项】
- 添加【内容密度标准】

### Phase 3: 验证修复（30分钟）
```bash
npm run ppt:lazyman -- "测试LazyMan修复"
node tools/diagnose-ppt-lazyman.mjs <新生成的pptx路径>
```

预期诊断结果：
- ✅ noWatermarks
- ✅ noPageNumbers
- ✅ lowHalfFilled (<=15%)
- 预估分数 >=95

## 成功标准

运行诊断工具后应显示：

```text
预估分数: 95/100
LazyMan级别: LazyMan

检查项:
  ✅ noWatermarks
  ✅ noPageNumbers
  ✅ lowHalfFilled
  ✅ noEmptyPages
  ✅ lowRepetition
```

## 快速执行

```text
Ctrl+Shift+P -> Tasks: Run Task -> LazyMan: 完整流程（清理→生成→诊断）
```

## 预期改善效果指标

| 指标 | 当前（17.pptx） | 修复后目标 |
|------|-----------------|------------|
| 水印污染 | ❌ 多页存在 | ✅ 0页 |
| 页码污染 | ❌ 多页存在 | ✅ 0页 |
| 半填充率 | ❌ >50% | ✅ <=15% |
| 标题重复 | ❌ >5次 | ✅ <=3次 |
| LazyMan分数 | ~40 | >=95 |
