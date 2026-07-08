import fs from "node:fs";
import path from "node:path";

const apiBase = process.env.BENCH_API_BASE || "http://localhost:3402";
const baselineCandidates = [
  path.resolve("docs", "benchmarks", "results", "exports", "4.pptx"),
  path.resolve("docs", "benchmarks", "results", "exports", "3.pptx")
];
const baselinePath = baselineCandidates.find((p) => fs.existsSync(p));

function buildNewtonContract() {
  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: "教务",
    templateId: "newton-template-stable-v1",
    pageCount: 10,
    visualStyle: "教学蓝白高对比风",
    tone: "自然课堂语言、可直接讲授",
    fontTheme: "serif-cn",
    chartStyle: "contrast",
    narrativeMode: "teaching",
    topic: "牛顿第二定律课堂讲解",
    lockToTemplate: true,
    layoutPolicy: {
      mode: "strict-layout",
      minScore: 90,
      mappingVersion: "semantic-slot-v1"
    },
    slides: [
      {
        index: 1,
        slideType: "cover",
        title: "牛顿第二定律",
        subtitle: "力、质量与加速度的关系",
        date: "2025",
        bullets: [],
        notes: "开场说明课程目标与评价标准。"
      },
      {
        index: 2,
        slideType: "section",
        title: "问题引入与知识回顾",
        summary: "从生活现象和旧知进入本课",
        bullets: [],
        notes: "先引发直觉，再回顾第一定律与加速度。"
      },
      {
        index: 3,
        slideType: "content",
        title: "复习：力会改变运动状态",
        bullets: [
          "力是改变运动状态的原因",
          "加速度描述速度变化快慢",
          "合力方向决定加速度方向"
        ],
        notes: "用 2 个快问快答确认旧知。"
      },
      {
        index: 4,
        slideType: "content",
        title: "实验探究：控制变量法",
        bullets: [
          "质量不变时改变拉力",
          "拉力越大加速度越大",
          "拉力不变时改变质量",
          "质量越大加速度越小"
        ],
        notes: "强调变量控制与数据记录格式。"
      },
      {
        index: 5,
        slideType: "content",
        title: "公式理解：F = ma",
        bullets: [
          "F 表示物体受到的合力",
          "m 表示物体质量",
          "a 表示物体产生的加速度",
          "三个量必须使用国际单位"
        ],
        notes: "补充 N=kg·m/s² 的单位关系。"
      },
      {
        index: 6,
        slideType: "example",
        title: "例题：水平面上的物体",
        bullets: [
          "题目：m=2kg，F合=6N",
          "步骤1：写出 a=F/m",
          "步骤2：代入 6/2",
          "结果：a=3m/s²"
        ],
        notes: "示范步骤书写规范与单位。"
      },
      {
        index: 7,
        slideType: "exercise",
        title: "课堂练习：判断加速度变化",
        bullets: [
          "合力加倍且质量不变",
          "判断加速度如何变化",
          "先口答再写公式验证"
        ],
        notes: "留 2 分钟独立完成，随后讲评。"
      },
      {
        index: 8,
        slideType: "content",
        title: "易错点纠偏",
        bullets: [
          "先找合力再代入公式",
          "注意方向与正负号",
          "单位必须完整一致"
        ],
        notes: "集中纠正三类高频错误。"
      },
      {
        index: 9,
        slideType: "summary",
        title: "课堂小结",
        bullets: [
          "牛顿第二定律描述定量关系",
          "合力决定加速度大小和方向",
          "解题先受力分析再列式"
        ],
        notes: "用结构图回顾主线。"
      },
      {
        index: 10,
        slideType: "qa",
        title: "课堂反思与提问",
        bullets: [
          "为什么必须使用合力",
          "质量越大为何更难改变运动",
          "生活中还有哪些 F=ma 场景"
        ],
        notes: "鼓励学生提出 1 个问题并记录。"
      }
    ]
  };
}

async function main() {
  if (!baselinePath) {
    throw new Error("baseline template not found (need 3.pptx or 4.pptx)");
  }

  const contract = buildNewtonContract();
  contract.templateSource = "officeplus";
  contract.externalTemplateId = "default-stable-template";
  contract.externalTemplateName = path.basename(baselinePath);
  contract.templateFileName = path.basename(baselinePath);
  contract.templateFileBase64 = fs.readFileSync(baselinePath).toString("base64");

  const resp = await fetch(`${apiBase}/api/ppt/export-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract })
  });
  const data = await resp.json();

  if (!resp.ok || !data.ok) {
    console.log(JSON.stringify({ ok: false, status: resp.status, error: data.error, detail: data.detail, validation: data.validation || null }, null, 2));
    process.exitCode = 1;
    return;
  }

  const out = {
    ok: true,
    status: resp.status,
    engine: data.engine,
    fallbackReason: data.fallbackReason || "",
    pptPath: data.relativePath,
    dumpPath: data.dumpRelativePath || "",
    diagnosticsPath: data.diagnosticsRelativePath || ""
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
