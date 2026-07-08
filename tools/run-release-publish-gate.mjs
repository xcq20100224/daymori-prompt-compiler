import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_API_BASE = "http://localhost:3000";

function trimBase(base) {
  return String(base || "").trim().replace(/\/$/, "");
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isApiCompatible(apiBase) {
  const base = trimBase(apiBase);
  if (!base) return false;
  const runtime = await fetchJson(`${base}/api/llm/runtime`, 5000);
  return !!(runtime && (runtime.provider || runtime.model));
}

async function waitForApiReachable(apiBase, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isApiCompatible(apiBase)) return true;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen({ port, host: "::", exclusive: true });
  });
}

async function chooseFallbackPort(preferredPort) {
  const candidates = [preferredPort];
  for (let p = 3301; p <= 3310; p += 1) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const p of candidates) {
    if (await isPortFree(p)) return p;
  }
  return preferredPort;
}

function startManagedServer(port) {
  const child = spawn(process.execPath, [path.join(repoRoot, "server.js")], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  const cap = 5000;
  const collect = (chunk) => {
    const text = String(chunk || "");
    output = (output + text).slice(-cap);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  return { child, getOutput: () => output };
}

async function ensureApiBase() {
  const preferred = trimBase(process.env.BENCH_API_BASE || "");
  const preferredPort = Number(process.env.BENCH_SERVER_PORT || 3301);
  const envPortBase = `http://localhost:${preferredPort}`;

  if (preferred && await isApiCompatible(preferred)) {
    return { apiBase: preferred, managedServer: null };
  }

  if (await isApiCompatible(DEFAULT_API_BASE)) {
    return { apiBase: DEFAULT_API_BASE, managedServer: null };
  }

  if (await isApiCompatible(envPortBase)) {
    return { apiBase: envPortBase, managedServer: null };
  }

  const fallbackPort = await chooseFallbackPort(preferredPort);
  const fallbackBase = `http://localhost:${fallbackPort}`;
  const managed = startManagedServer(fallbackPort);

  const ready = await waitForApiReachable(fallbackBase, 25000);
  if (!ready) {
    const detail = managed.getOutput();
    managed.child.kill();
    throw new Error(`publish_gate_server_boot_failed:${detail || "no_output"}`);
  }

  return { apiBase: fallbackBase, managedServer: managed };
}

function buildSlides(topic) {
  const t = String(topic || "发布门禁");
  return [
    { index: 1, title: `导入：${t}`, goal: "建立上下文", layoutType: "summary-hero", keyPoints: ["目标对齐", "范围明确", "验收标准"], assetPlaceholders: ["导入图"], speakerNotes: "开场" },
    { index: 2, title: "目标定义", goal: "明确输出边界", layoutType: "decision-board", keyPoints: ["布局合规", "内容合规", "可发布"], assetPlaceholders: ["目标卡"], speakerNotes: "指标" },
    { index: 3, title: "核心要点", goal: "确保内容覆盖", layoutType: "strategy-compare", keyPoints: ["标题明确", "正文可读", "结构完整"], assetPlaceholders: ["要点图"], speakerNotes: "要点" },
    { index: 4, title: "证据与指标", goal: "量化质量", layoutType: "evidence-chart", keyPoints: ["覆盖率>=98%", "空白页=0", "占位符页=0"], assetPlaceholders: ["指标图"], speakerNotes: "硬门禁" },
    { index: 5, title: "问题定位", goal: "识别失败页", layoutType: "diagnosis-matrix", keyPoints: ["failedSlides", "原因聚类", "Top2问题"], assetPlaceholders: ["诊断图"], speakerNotes: "定位" },
    { index: 6, title: "修复策略", goal: "最小副作用修复", layoutType: "roadmap-timeline", keyPoints: ["仅修失败页", "保留通过页", "减少漂移"], assetPlaceholders: ["修复图"], speakerNotes: "修复" },
    { index: 7, title: "发布判定", goal: "双门禁通过", layoutType: "risk-heatmap", keyPoints: ["layout pass", "content pass", "发布允许"], assetPlaceholders: ["判定图"], speakerNotes: "判定" },
    { index: 8, title: "结论", goal: "执行发布", layoutType: "summary-hero", keyPoints: ["门禁通过", "输出归档", "进入发布"], assetPlaceholders: ["结论卡"], speakerNotes: "收束" }
  ];
}

async function loadTemplatePack() {
  const envPath = String(process.env.LAYOUT_TEMPLATE_PATH || "").trim();
  const defaultPath = "C:/Users/J1896/Desktop/演示文稿4.pptx";
  const targetPath = envPath || defaultPath;
  const bin = await fs.readFile(targetPath);
  return {
    fileName: path.basename(targetPath),
    fileBase64: Buffer.from(bin).toString("base64")
  };
}

async function postExportSave(apiBase, contract) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000);
  try {
    const resp = await fetch(`${trimBase(apiBase)}/api/ppt/export-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract }),
      signal: ctrl.signal
    });
    const text = await resp.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: {
        error: error && error.name === "AbortError" ? "request_timeout" : String(error && error.message ? error.message : error)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildContract(templatePack) {
  const topic = String(process.env.RELEASE_GATE_TOPIC || "发布门禁验证");
  return {
    contractVersion: "aippt.v1",
    engineType: "generic-aippt",
    sceneType: "发布门禁",
    templateId: "officeplus-release-gate",
    templateSource: "officeplus",
    templateFileName: templatePack.fileName,
    templateFileBase64: templatePack.fileBase64,
    pageCount: 8,
    visualStyle: "高对比清晰",
    tone: "清晰、可执行",
    fontTheme: "business-cn",
    chartStyle: "contrast",
    narrativeMode: "standard",
    topic,
    layoutPolicy: {
      mode: "balanced",
      minScore: 82,
      mappingVersion: "semantic-slot-v1"
    },
    slides: buildSlides(topic)
  };
}

function pickSlaFlags(data) {
  const sla = data && data.sla ? data.sla : {};
  return {
    under60s: !!sla.under60s,
    strictLeakSafe: !!sla.strictLeakSafe,
    manualAdjustmentsLe1: !!sla.manualAdjustmentsLe1,
    contentGatePass: !!sla.contentGatePass,
    blankSlidesZero: !!sla.blankSlidesZero,
    placeholderOnlyZero: !!sla.placeholderOnlyZero
  };
}

async function run() {
  const { apiBase, managedServer } = await ensureApiBase();
  try {
    const templatePack = await loadTemplatePack();
    const contract = buildContract(templatePack);
    const result = await postExportSave(apiBase, contract);

    if (!result.ok) {
      const detail = result && result.data ? JSON.stringify(result.data).slice(0, 800) : "unknown";
      console.error(`Publish gate failed: export-save not ok (status=${result.status}) ${detail}`);
      process.exitCode = 1;
      return;
    }

    const flags = pickSlaFlags(result.data);
    const allPass = Object.values(flags).every(Boolean);
    console.log(`Publish gate flags: ${JSON.stringify(flags)}`);

    if (!allPass) {
      console.error("Publish gate failed: one or more SLA flags are false.");
      process.exitCode = 1;
      return;
    }

    console.log("Publish gate passed.");
  } finally {
    if (managedServer && managedServer.child && !managedServer.child.killed) {
      managedServer.child.kill();
    }
  }
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
