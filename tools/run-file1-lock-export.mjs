import fs from "node:fs";
import path from "node:path";

const apiBase = process.env.BENCH_API_BASE || "http://localhost:3402";
const defaultBaseline = fs.existsSync(path.resolve("docs", "benchmarks", "results", "exports", "4.pptx"))
  ? path.resolve("docs", "benchmarks", "results", "exports", "4.pptx")
  : path.resolve("docs", "benchmarks", "results", "exports", "3.pptx");
const baselinePath = process.env.BASELINE_PPT || defaultBaseline;

function buildFallbackContract() {
  const rows = [
    ["封面：牛顿第二定律", "本课目标", "结论：掌握 F=ma", "证据：会用受力图", "行动：完成课堂题"],
    ["01", "目录", "结论：五段教学流程", "证据：引入-探究-应用-反馈-总结", "行动：按节奏学习"],
    ["一、问题引入与知识回顾", "引发思考", "结论：只谈速度不够", "证据：同物体受不同力加速度不同", "行动：回答导入问题"],
    ["导入：从生活现象出发", "建立直觉", "结论：合力决定加速", "证据：2N 与 4N 推力效果不同", "行动：解释原因"],
    ["复习：牛顿第一定律与加速度", "连接旧知", "结论：无合力则匀速", "证据：a=Δv/Δt", "行动：写过渡句"],
    ["二、实验探究与定律发现", "实验路径", "结论：控制变量是关键", "证据：分离力与质量影响", "行动：记录数据"],
    ["实验探究：控制变量法", "观察规律", "结论：m定时 a∝F", "证据：力增大时加速度同步增大", "行动：画趋势"],
    ["定律推导：从数据到公式", "归纳关系", "结论：得到 F=ma", "证据：图像近似直线", "行动：口述推导"],
    ["公式详解：F=ma 的深度理解", "掌握变形", "结论：三式等价", "证据：F=12N,m=3kg,a=4m/s²", "行动：做两题"],
    ["三、例题应用：从理论到计算", "解题流程", "结论：先受力后列式", "证据：对象-画图-定向-列合力", "行动：按流程写"],
    ["例题 1 ：水平面受力", "标准代入", "结论：a=F合/m", "证据：9N 与 1.5kg 得 6m/s²", "行动：独立完成"],
    ["例题 2 ：斜面与摩擦力综合", "多力分析", "结论：看合力不是单力", "证据：10N-4N, m=2kg", "行动：标方向"],
    ["四、互动练习与即时反馈", "即时检测", "结论：反馈越快纠错越快", "证据：可快速定位误区", "行动：先做后改"],
    ["选择题：判断对错", "识别误区", "结论：合力不等于任一单力", "证据：漏算摩擦会偏大", "行动：三步自检"],
    ["计算题：灵活应用公式", "规范表达", "结论：步骤完整才稳定", "证据：已知-求解-公式-结果", "行动：同伴互评"],
    ["五、课堂总结与分层作业", "课堂闭环", "结论：会解释才算会", "证据：基础题80%，提升题60%", "行动：分层训练"],
    ["课堂小结：知识结构图", "压缩主线", "结论：受力→合力→F=ma→求解", "证据：三模块贯通", "行动：复述一次"],
    ["分层作业：巩固与拓展", "训练分层", "结论：保下限提上限", "证据：A/B/C 三层任务", "行动：提交订正"],
    ["课堂反思与提问", "自我诊断", "结论：会提问=会思考", "证据：高频错点在方向与单位", "行动：提1问1得"],
    ["课堂收束与下节预告", "课末收束", "结论：下节综合应用", "证据：本节完成概念到计算", "行动：复盘错题"]
  ];

  const layout = [
    "summary-hero",
    "diagnosis-matrix",
    "summary-hero",
    "evidence-chart",
    "diagnosis-matrix",
    "summary-hero",
    "evidence-chart",
    "evidence-chart",
    "strategy-compare",
    "summary-hero",
    "strategy-compare",
    "strategy-compare",
    "summary-hero",
    "risk-heatmap",
    "strategy-compare",
    "summary-hero",
    "decision-board",
    "decision-board",
    "risk-heatmap",
    "summary-hero"
  ];

  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: "教务",
    templateId: "file1-locked-baseline",
    pageCount: 20,
    visualStyle: "教学蓝白高对比风",
    tone: "概念清晰、循序渐进、课堂可执行",
    fontTheme: "serif-cn",
    chartStyle: "contrast",
    narrativeMode: "lazyman",
    topic: "初二牛顿第二定律讲解",
    qualityGate: { minOverall: 0.86 },
    requiredFields: ["index", "title", "goal", "keyPoints"],
    lockToTemplate: true,
    layoutPolicy: {
      mode: "strict-layout",
      minScore: 92,
      mappingVersion: "semantic-slot-v1"
    },
    slides: rows.map((r, i) => ({
      index: i + 1,
      title: r[0],
      goal: r[1],
      layoutType: layout[i] || "evidence-chart",
      keyPoints: [r[2], r[3], r[4]],
      assetPlaceholders: ["受力示意图", "数据图"],
      speakerNotes: "先结论后证据，再布置行动。"
    }))
  };
}

async function main() {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`baseline_not_found: ${baselinePath}`);
  }

  const contract = buildFallbackContract();
  contract.templateSource = "officeplus";
  contract.externalTemplateId = "file1-locked";
  contract.externalTemplateName = "file1骨架锁定";
  contract.templateFileName = path.basename(baselinePath);
  contract.templateFileBase64 = fs.readFileSync(baselinePath).toString("base64");

  const resp = await fetch(`${apiBase}/api/ppt/export-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract })
  });
  const data = await resp.json();

  const out = {
    ok: !!(resp.ok && data && data.ok),
    status: resp.status,
    baselineTemplate: contract.templateFileName,
    saved: data && data.saved ? data.saved : null,
    engine: data && data.engine ? data.engine : null,
    fallbackReason: data && data.fallbackReason ? data.fallbackReason : null,
    teachingQuality: data && data.teachingQuality ? data.teachingQuality : null,
    detail: data && data.detail ? data.detail : null
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
