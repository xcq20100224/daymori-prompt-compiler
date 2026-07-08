const apiBase = process.env.BENCH_API_BASE || "http://localhost:3402";

const CASES = [
  { topic: "AI客服降本增效方案", sceneType: "企业", scenario: "proposal", pageCount: 10 },
  { topic: "牛顿第二定律课堂讲解", sceneType: "教务", scenario: "teaching", pageCount: 10 },
  { topic: "新能源汽车市场分析报告", sceneType: "企业", scenario: "business_report", pageCount: 10 },
  { topic: "新员工安全培训", sceneType: "培训", scenario: "training", pageCount: 10 }
];

function buildContract(item) {
  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: item.sceneType,
    scenario: item.scenario,
    templateId: "default-business-template",
    templateSource: "internal",
    pageCount: item.pageCount,
    visualStyle: "结构清晰、信息密度均衡",
    tone: "自然表达、可直接讲解",
    fontTheme: "business-cn",
    chartStyle: "calm",
    narrativeMode: "standard",
    topic: item.topic,
    lockToTemplate: true,
    layoutPolicy: {
      mode: "strict-layout",
      minScore: 80,
      mappingVersion: "semantic-slot-v1"
    },
    slides: []
  };
}

async function exportOne(item) {
  const contract = buildContract(item);
  const resp = await fetch(`${apiBase}/api/ppt/export-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contract })
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    return {
      ok: false,
      topic: item.topic,
      status: resp.status,
      error: data.error,
      detail: data.detail,
      validation: data.validation || null
    };
  }
  const quality = data.qualityScore || {};
  if (
    Number(quality.overall || 0) < 85
    || Number(quality.templateUsage || 0) < 80
    || Number(quality.visualCleanliness || 0) < 85
    || Number(quality.contentSpecificity || 0) < 85
    || Number(quality.exportIntegrity || 0) < 100
  ) {
    return {
      ok: false,
      topic: item.topic,
      status: resp.status,
      error: "quality_score_failed",
      detail: JSON.stringify(quality),
      validation: null
    };
  }
  if (!data.relativePath || !data.dumpRelativePath || !data.validationRelativePath || !data.renderLogRelativePath) {
    return {
      ok: false,
      topic: item.topic,
      status: resp.status,
      error: "artifact_missing",
      detail: JSON.stringify({
        relativePath: data.relativePath || "",
        dumpRelativePath: data.dumpRelativePath || "",
        validationRelativePath: data.validationRelativePath || "",
        renderLogRelativePath: data.renderLogRelativePath || ""
      }),
      validation: null
    };
  }
  return {
    ok: true,
    topic: item.topic,
    status: resp.status,
    requestId: data.requestId || "",
    engine: data.engine,
    pptPath: data.relativePath,
    dumpPath: data.dumpRelativePath || "",
    diagnosticsPath: data.diagnosticsRelativePath || "",
    validationPath: data.validationRelativePath || "",
    renderLogPath: data.renderLogRelativePath || "",
    qualityScore: data.qualityScore || null
  };
}

async function main() {
  const results = [];
  for (const item of CASES) {
    // Run sequentially to avoid COM collisions on Windows PowerPoint.
    const row = await exportOne(item);
    results.push(row);
    if (!row.ok) {
      console.log(JSON.stringify({ ok: false, failTopic: item.topic, results }, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  console.log(JSON.stringify({ ok: true, total: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
