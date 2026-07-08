import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function runNodeScript(fileName, env = {}) {
  const scriptPath = path.join(__dirname, fileName);
  const child = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    encoding: "utf8"
  });

  return {
    fileName,
    status: typeof child.status === "number" ? child.status : 1,
    stdout: String(child.stdout || ""),
    stderr: String(child.stderr || ""),
    ok: !child.error && child.status === 0
  };
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { ctrl, timer };
}

async function isApiCompatible(apiBase) {
  const { ctrl, timer } = withTimeout(3000);
  try {
    const base = String(apiBase || "").replace(/\/$/, "");
    const resp = await fetch(`${base}/api/llm/runtime`, {
      method: "GET",
      signal: ctrl.signal
    });
    if (!resp.ok) return false;
    const text = await resp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return !!(parsed && (parsed.provider || parsed.model));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForApiReachable(apiBase, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isApiCompatible(apiBase)) return true;
    await new Promise((r) => setTimeout(r, 1000));
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

async function ensureApiBase() {
  const preferred = String(process.env.BENCH_API_BASE || "").trim();
  const defaultBase = "http://localhost:3000";
  const preferredPort = Number(process.env.BENCH_SERVER_PORT || 3301);
  const envPortBase = `http://localhost:${preferredPort}`;

  if (preferred) {
    const ok = await isApiCompatible(preferred);
    if (ok) return { apiBase: preferred, managedServer: null };
  }

  if (await isApiCompatible(defaultBase)) {
    return { apiBase: defaultBase, managedServer: null };
  }

  if (await isApiCompatible(envPortBase)) {
    return { apiBase: envPortBase, managedServer: null };
  }

  const fallbackPort = await chooseFallbackPort(preferredPort);
  const fallbackBase = `http://localhost:${fallbackPort}`;

  const serverEntry = path.join(repoRoot, "server.js");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(fallbackPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderrBuf = "";
  if (child.stderr) {
    child.stderr.on("data", (d) => {
      stderrBuf += String(d || "");
      if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-2000);
    });
  }

  const up = await waitForApiReachable(fallbackBase, 25000);
  if (!up) {
    try { child.kill(); } catch {}
    throw new Error(`daily_cycle_server_boot_failed:${stderrBuf.trim() || "unknown"}`);
  }

  return {
    apiBase: fallbackBase,
    managedServer: child
  };
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function ensureArray(input) {
  return Array.isArray(input) ? input : [];
}

function buildTop2FixesFromDashboard(dashboardJson) {
  const sides = ensureArray(dashboardJson && dashboardJson.sides);
  const ours = sides.find((x) => String(x && x.label || "").toLowerCase() === "daymori") || { runs: [] };
  const runs = ensureArray(ours.runs);
  const counter = new Map();

  for (const r of runs) {
    for (const reason of ensureArray(r.reasons)) {
      counter.set(String(reason), (counter.get(String(reason)) || 0) + 1);
    }
  }

  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, count]) => ({ reason, count }));
}

async function writeTop2Reports(payload) {
  const reportsDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  const mdLines = [];
  mdLines.push(`# Daily Top2 Fix Plan (${payload.runDate})`);
  mdLines.push("");
  mdLines.push(`- Run At: ${payload.runAt}`);
  mdLines.push(`- Daymori Production: ${payload.daymori.ok ? "OK" : "FAILED"}`);
  mdLines.push(`- Lazyman Production: ${payload.lazyman.ok ? "OK" : "FAILED"}`);
  mdLines.push(`- Dashboard: ${payload.dashboard.ok ? "OK" : "FAILED"}`);
  mdLines.push("");
  mdLines.push("## Top2 Failure Types");
  mdLines.push("");
  if (payload.top2.length === 0) {
    mdLines.push("- none");
  } else {
    for (const x of payload.top2) {
      mdLines.push(`- ${x.reason} (${x.count})`);
    }
  }
  mdLines.push("");
  mdLines.push("## Execution Logs");
  mdLines.push("");
  mdLines.push(`- daymori status=${payload.daymori.status}`);
  mdLines.push(`- lazyman status=${payload.lazyman.status}`);
  mdLines.push(`- dashboard status=${payload.dashboard.status}`);

  const latestMd = path.join(reportsDir, "top2-fix-latest.md");
  const datedMd = path.join(reportsDir, `top2-fix-${payload.runDate}.md`);
  const latestJson = path.join(resultsDir, "top2-fix-latest.json");
  const datedJson = path.join(resultsDir, `top2-fix-${payload.runDate}.json`);

  await fs.writeFile(latestMd, mdLines.join("\n"));
  await fs.writeFile(datedMd, mdLines.join("\n"));
  await fs.writeFile(latestJson, JSON.stringify(payload, null, 2));
  await fs.writeFile(datedJson, JSON.stringify(payload, null, 2));
}

async function run() {
  const api = await ensureApiBase();
  try {
    const commonEnv = { BENCH_API_BASE: api.apiBase };

    const daymori = runNodeScript("run-production-sla-benchmark.mjs", {
      ...commonEnv,
      BENCH_OUTPUT_PREFIX: "daymori-production-sla",
      BENCH_PROVIDER_LABEL: "daymori"
    });

    const lazyman = runNodeScript("run-lazyman-production-sla-benchmark.mjs", {
      ...commonEnv
    });
    const dashboard = runNodeScript("run-vs-lazyman-dashboard.mjs", {
      ...commonEnv,
      DAYMORI_SLA_JSON: path.join(repoRoot, "docs", "benchmarks", "results", "daymori-production-sla-latest.json"),
      LAZYMAN_SLA_JSON: path.join(repoRoot, "docs", "benchmarks", "results", "lazyman-production-sla-latest.json")
    });

    const dashJsonPath = path.join(repoRoot, "docs", "benchmarks", "results", "vs-lazyman-latest.json");
    const dashJson = await readJsonSafe(dashJsonPath);
    const top2 = buildTop2FixesFromDashboard(dashJson || {});

    const payload = {
      runAt: nowIso(),
      runDate: todayDate(),
      daymori: { ok: daymori.ok, status: daymori.status },
      lazyman: { ok: lazyman.ok, status: lazyman.status },
      dashboard: { ok: dashboard.ok, status: dashboard.status },
      top2
    };

    await writeTop2Reports(payload);

    console.log(`Daily cycle done. daymori=${daymori.status}, lazyman=${lazyman.status}, dashboard=${dashboard.status}`);
    console.log(`API base: ${api.apiBase}`);
    console.log(`Top2: ${top2.map((x) => `${x.reason}(${x.count})`).join(", ") || "none"}`);
    console.log("Report: docs/benchmarks/reports/top2-fix-latest.md");
    console.log("Result: docs/benchmarks/results/top2-fix-latest.json");

    if (!daymori.ok || !dashboard.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (api.managedServer) {
      try { api.managedServer.kill(); } catch {}
    }
  }
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
