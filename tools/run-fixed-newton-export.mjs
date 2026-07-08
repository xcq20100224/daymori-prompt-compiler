import fs from "node:fs";
import path from "node:path";

const apiBase = process.env.BENCH_API_BASE || "http://localhost:3402";
const topicPrompt = "请输出初二牛顿第二定律讲解PPT契约JSON，固定20页，结构必须为：封面、目录、5个章节分隔页（标题使用一/二/三/四/五）、12个内容页、总结页、作业页、课堂收束页。仅输出JSON，不要解释。JSON字段必须包含contractVersion,engineType,sceneType,templateId,pageCount,visualStyle,tone,fontTheme,chartStyle,narrativeMode,topic,slides,qualityGate,requiredFields；slides每页包含index,title,goal,layoutType,keyPoints(3条，前缀为结论：证据：行动：),assetPlaceholders,speakerNotes。";

function firstJsonObject(raw) {
  const text = String(raw || "");
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return "";
  return text.slice(s, e + 1);
}

function buildFallbackContract() {
  const rows = [
    ["封面：牛顿第二定律课堂讲解", "建立课堂主题与学习目标", "结论：本课围绕F=ma完成探究与应用", "证据：学习目标包含概念、实验、计算三维", "行动：先看导入问题，再完成分层练习"],
    ["目录与学习路径", "明确5个教学章节和课堂节奏", "结论：按引入-探究-应用-反馈-总结推进", "证据：每章有对应任务与达成标准", "行动：跟随目录完成每一步学习任务"],
    ["一、问题引入与知识回顾", "引发学生对力和运动关系的思考", "结论：仅有速度概念不足以解释受力变化", "证据：生活场景中同物体受不同推力加速度不同", "行动：先回答导入问题再进入新知"],
    ["导入：从生活现象出发", "用案例建立合力与加速度关系", "结论：物体加速源于合力不为零", "证据：同质量车受推力2N与4N时a约成倍变化", "行动：用一句话解释为何推力越大加速越快"],
    ["复习：牛顿第一定律与加速度", "连接旧知并过渡到第二定律", "结论：第一定律说明无合力时匀速或静止", "证据：加速度定义a=Δv/Δt并与方向相关", "行动：写出第一定律与本课关系"],
    ["二、实验探究与定律发现", "建立实验驱动的定律发现路径", "结论：实验是验证F与a关系的关键", "证据：控制变量可排除质量或力的干扰", "行动：按步骤完成实验记录"],
    ["实验探究：控制变量法", "理解加速度与力、质量的定量关系", "结论：质量定时a与F成正比", "证据：F从1N到3N时a由0.5增至1.5m/s²", "行动：按表格记录3组数据并画趋势"],
    ["定律推导：从数据到公式", "从图像与数据归纳数学关系", "结论：实验支持F=ma的线性关系", "证据：力-加速度图近似过原点直线", "行动：根据数据写出比例关系并口头说明"],
    ["公式详解：F=ma的深度理解", "掌握公式变形与单位意义", "结论：F=ma、a=F/m、m=F/a三式等价", "证据：当F=12N,m=3kg时a=4m/s²", "行动：完成2道变形式计算题"],
    ["三、例题应用：从理论到计算", "进入标准解题流程与建模", "结论：先受力分析后列式是核心流程", "证据：流程为选对象-画图-定正向-列合力", "行动：每题先写受力图再计算"],
    ["例题1：水平面受力", "掌握标准代入与单位检查", "结论：求a时先算合力再除以质量", "证据：F合=9N,m=1.5kg得a=6m/s²", "行动：独立完成同型题并核对单位"],
    ["例题2：斜面与摩擦力综合", "能在多力情境下正确列方程", "结论：加速度由合力决定而非单个拉力", "证据：F拉10N,f=4N,m=2kg时a=3m/s²", "行动：写出完整步骤并标注方向"],
    ["四、互动练习与即时反馈", "用练习及时检验理解深度", "结论：反馈越即时，纠错效率越高", "证据：课堂即时测可定位公式与受力误区", "行动：先做题后对照讲解完成修正"],
    ["选择题：判断对错", "识别常见概念误区", "结论：最大误区是把合力等同于任一单力", "证据：错例中漏减摩擦力导致a偏大33%", "行动：用三步自检法复核每道题"],
    ["计算题：灵活应用公式", "提升多步骤计算与表达能力", "结论：解题必须写清已知、求解、公式、结果", "证据：完整步骤题得分率显著高于跳步题", "行动：规范书写并与同伴互评"],
    ["五、课堂总结与分层作业", "完成课堂闭环并布置迁移任务", "结论：会做题的标志是能解释物理意义", "证据：基础题目标正确率80%，提升题60%", "行动：按分层作业巩固并拓展"],
    ["课堂小结：知识结构图", "压缩核心概念与方法链路", "结论：主线是受力分析→合力→F=ma→求解", "证据：结构图串联概念、实验、例题三模块", "行动：用思维导图复述本课内容"],
    ["分层作业：巩固与拓展", "匹配不同水平学生的训练需求", "结论：分层训练能同步保证下限与上限", "证据：A/B/C三层任务覆盖概念到综合应用", "行动：课后提交错因并二次订正"],
    ["课堂反思与提问", "鼓励学生提出问题并自我诊断", "结论：会提问是深度理解的信号", "证据：常见问题集中在合力方向与单位换算", "行动：每人提交1个疑问和1个收获"],
    ["课堂收束与下节预告", "结束课堂并提示后续学习", "结论：下一节将进入牛顿定律综合应用", "证据：本节已完成概念、实验、计算闭环", "行动：复盘错题并预习下节内容"]
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
    templateId: "edu-lazyman-fusion-02",
    pageCount: 20,
    visualStyle: "教学蓝白高对比风",
    tone: "概念清晰、循序渐进、课堂可执行",
    fontTheme: "serif-cn",
    chartStyle: "contrast",
    narrativeMode: "lazyman",
    topic: "初二牛顿第二定律讲解",
    qualityGate: { minOverall: 0.82 },
    requiredFields: ["index", "title", "goal", "keyPoints"],
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

async function callModel(model) {
  const resp = await fetch(`${apiBase}/api/llm-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: "你是Lazyman级教学PPT总监，只输出有效JSON。",
      userText: topicPrompt,
      maxTokens: 5200,
      model
    })
  });
  const raw = await resp.text();
  return { ok: resp.ok, status: resp.status, raw, model };
}

async function pickTemplate() {
  const inboxFile = path.resolve("docs", "benchmarks", "templates", "inbox", "演示文稿4.pptx");
  if (fs.existsSync(inboxFile)) {
    const b64 = fs.readFileSync(inboxFile).toString("base64");
    return { fileName: "演示文稿4.pptx", fileBase64: b64, source: "explicit-inbox" };
  }
  const resp = await fetch(`${apiBase}/api/ppt/template-inbox/latest`, { method: "GET" });
  const data = await resp.json();
  if (!resp.ok || !data || !data.fileBase64) {
    throw new Error(`template_unavailable: ${JSON.stringify(data || {})}`);
  }
  return { fileName: data.fileName || "officeplus-template.pptx", fileBase64: data.fileBase64, source: "inbox-latest" };
}

async function main() {
  const reasoner = await callModel("deepseek-reasoner").catch((e) => ({ ok: false, status: 0, raw: String(e), model: "deepseek-reasoner" }));
  const modelResp = reasoner.ok
    ? reasoner
    : await callModel("deepseek-chat").catch((e) => ({ ok: false, status: 0, raw: String(e), model: "deepseek-chat" }));

  let contract = null;
  let modelUsed = "fallback-local";
  if (modelResp && modelResp.ok) {
    const envelope = (() => {
      try { return JSON.parse(modelResp.raw); } catch { return {}; }
    })();
    const modelText = String(envelope.text || envelope.output_text || modelResp.raw || "");
    const json = firstJsonObject(modelText);
    if (json) {
      try {
        contract = JSON.parse(json);
        modelUsed = modelResp.model;
      } catch {
      }
    }
  }

  if (!contract) {
    contract = buildFallbackContract();
  }

  const tpl = await pickTemplate();
  contract.templateSource = "officeplus";
  contract.externalTemplateId = "user-upload-template";
  contract.externalTemplateName = "演示文稿4模板";
  contract.templateFileName = tpl.fileName;
  contract.templateFileBase64 = tpl.fileBase64;

  const saveResp = await fetch(`${apiBase}/api/ppt/export-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract })
  });
  const save = await saveResp.json();

  const out = {
    ok: !!(saveResp.ok && save && save.ok),
    modelUsed,
    llmReasonerStatus: reasoner ? reasoner.status : -1,
    topic: contract.topic,
    pageCount: contract.pageCount,
    templateFileName: contract.templateFileName,
    saved: save && save.saved ? save.saved : null,
    engine: save && save.engine ? save.engine : null,
    fallbackReason: save && save.fallbackReason ? save.fallbackReason : null
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
