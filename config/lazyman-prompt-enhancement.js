const prohibitedWords = [
    "内容由AI生成",
    "由AI生成",
    "AI生成",
    "OfficePLUS",
    "LOGO",
    "CONTENT",
    "请在此输入",
    "输入标题",
    "placeholder",
    "添加标题",
    "单击此处",
    "20XX",
    "202X"
];

const systemPromptEnhancement = `
【LazyMan级质量标准 - 必须遵守】

1. 内容密度要求：
   - 每页必须有3-5条完整要点
    - 每条要点15-80字，包含结论+证据+行动三段逻辑
    - 最终输出文本中不要出现"结论：""证据：""行动："前缀标签
   - 禁止出现"待补充""具体内容""详见附件"等占位符

2. 标题多样性要求：
   - 禁止在每页标题重复主题名称
   - 用动词开头（如：分析、构建、实施、评估）
   - 每个标题必须传达独特信息

3. 绝对禁止的内容（一旦出现直接不合格）：
   ${prohibitedWords.map((w) => `- "${w}"`).join("\n   ")}

4. 数据验证：
   - 所有数据必须具体（不能写"显著提升"，要写"提升30%"）
   - 所有案例必须真实或合理虚构（避免"某公司""XX企业"）

【违反任一条款将导致生成失败，必须重新生成】
`;

const lazymanPromptRules = {
    prohibitedWords,
    contentRules: {
        minKeyPointsPerSlide: 3,
        maxKeyPointsPerSlide: 5,
        minCharsPerKeyPoint: 15,
        maxCharsPerKeyPoint: 80,
        keyPointFormat: [
            "核心观点（15-30字）",
            "数据或案例支撑（20-40字）",
            "可执行建议（15-30字）"
        ]
    },
    titleRules: {
        prohibitRepeatMainTopic: true,
        useActionVerbs: true,
        maxSimilarTitles: 2,
        titlePatterns: [
            "问题：XXX",
            "方案：XXX",
            "成效：XXX",
            "XXX的3大要素",
            "如何实现XXX",
            "XXX vs XXX对比"
        ]
    },
    systemPromptEnhancement
};

module.exports = { lazymanPromptRules };
