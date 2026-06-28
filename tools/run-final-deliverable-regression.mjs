import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function parseArgs(argv) {
  const args = { target: 0.8, headed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--headed") args.headed = true;
    if (a === "--target" && argv[i + 1]) {
      const t = Number(argv[i + 1]);
      if (Number.isFinite(t) && t > 0 && t <= 1) args.target = t;
      i += 1;
    }
  }
  return args;
}

async function readCases() {
  const p = path.join(repoRoot, "docs", "benchmarks", "final-deliverable-prompts.json");
  const raw = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("final-deliverable-prompts.json is empty or invalid");
  }
  return parsed;
}

function finalPromptTail(text) {
  const s = String(text || "");
  const idx = s.lastIndexOf("终版提示词");
  if (idx < 0) return "";
  return s.slice(idx + "终版提示词".length).trim();
}

function evaluateCase(caseItem, latestDeliverableText) {
  const forbidden = /课堂|教学|教师|学生|作业分层/;
  const requiredBlocks = ["目标", "约束", "执行步骤", "校验与追问", "交付清单", "终版提示词"];

  const text = String(latestDeliverableText || "");
  const leak = forbidden.test(text);
  const hit = (caseItem.expect || []).filter((k) => text.includes(k)).length;
  const hasBlocks = requiredBlocks.every((k) => text.includes(k));
  const finalPrompt = finalPromptTail(text);
  const finalPromptLen = finalPrompt.length;
  const executable = /(必须先输出|再输出|步骤|检查清单|回退策略)/.test(`${finalPrompt}\n${text}`);
  const strong = /(A\/B\/C三版|自评分表|最终推荐版)/.test(`${finalPrompt}\n${text}`);
  const pass = !leak && hit >= 1 && hasBlocks && finalPromptLen >= 140 && executable && strong;

  const reason = pass
    ? "pass"
    : [
        leak ? "leak" : "",
        hit < 1 ? "keyword-miss" : "",
        !hasBlocks ? "block-miss" : "",
        finalPromptLen < 140 ? "short-prompt" : "",
        !executable ? "not-actionable" : "",
        !strong ? "no-advantage-layer" : ""
      ]
        .filter(Boolean)
        .join("|");

  return {
    id: caseItem.id,
    pass,
    leak,
    hit,
    hasBlocks,
    finalPromptLen,
    executable,
    strong,
    reason
  };
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push(`# Final Deliverable Regression Report (${payload.runDate})`);
  lines.push("");
  lines.push(`- Run At: ${payload.runAt}`);
  lines.push(`- Total: ${payload.total}`);
  lines.push(`- Passed: ${payload.passed}`);
  lines.push(`- Strict Rate: ${(payload.strictRate * 100).toFixed(1)}%`);
  lines.push(`- Target: ${(payload.targetRate * 100).toFixed(1)}%`);
  lines.push(`- Pass Target: ${payload.passTarget ? "YES" : "NO"}`);
  lines.push("");
  lines.push("## Failure Stats");
  lines.push("");
  lines.push(`- leak: ${payload.stats.leak}`);
  lines.push(`- keywordMiss: ${payload.stats.keywordMiss}`);
  lines.push(`- blockMiss: ${payload.stats.blockMiss}`);
  lines.push(`- shortPrompt: ${payload.stats.shortPrompt}`);
  lines.push(`- notActionable: ${payload.stats.notActionable}`);
  lines.push(`- noAdvantageLayer: ${payload.stats.noAdvantageLayer}`);
  lines.push("");
  lines.push("## Failed Cases");
  lines.push("");
  if (!payload.failures.length) {
    lines.push("- None");
  } else {
    for (const f of payload.failures) {
      lines.push(`- ${f.id}: ${f.reason}`);
    }
  }
  return lines.join("\n");
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Missing dependency: playwright. Run: npm install -D playwright");
  }

  const cases = await readCases();
  const browser = await playwright.chromium.launch({ headless: !args.headed });
  const page = await browser.newPage();

  const pageUrl = pathToFileURL(path.join(repoRoot, "docs", "index.html")).href;
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  const submit = async (text) => {
    await page.locator("#input").fill(text);
    await page.locator("#input").press("Enter");
  };

  const waitForSettledDeliverable = async (maxWaitMs = 22000, quietMs = 2500) => {
    const start = Date.now();
    let lastCount = await page.locator(".deliverable").count();
    let lastChange = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const count = await page.locator(".deliverable").count();
      if (count !== lastCount) {
        lastCount = count;
        lastChange = Date.now();
      }

      const sendDisabled = await page.locator("#send").isDisabled();
      const quietEnough = Date.now() - lastChange >= quietMs;
      if (!sendDisabled && lastCount > 0 && quietEnough) break;
      await page.waitForTimeout(250);
    }

    const finalCount = await page.locator(".deliverable").count();
    if (!finalCount) return { ok: false, text: "", timedOut: true };
    const text = await page.locator(".deliverable").nth(finalCount - 1).innerText();
    return { ok: true, text, timedOut: false };
  };

  await submit("/test reset");
  await page.waitForTimeout(200);
  await submit("/test on");
  await page.waitForTimeout(500);

  const results = [];
  for (const c of cases) {
    await submit(c.prompt);
    const settled = await waitForSettledDeliverable();
    if (!settled.ok) {
      results.push({ id: c.id, pass: false, reason: "no-deliverable-timeout" });
      continue;
    }
    results.push(evaluateCase(c, settled.text));
  }

  await browser.close();

  const passed = results.filter((r) => r.pass).length;
  const strictRate = ratio(passed, results.length);
  const payload = {
    runAt: nowIso(),
    runDate: todayDate(),
    mode: "final-deliverable-state",
    total: results.length,
    passed,
    strictRate,
    targetRate: args.target,
    passTarget: strictRate >= args.target,
    stats: {
      leak: results.filter((r) => r.leak).length,
      keywordMiss: results.filter((r) => typeof r.hit === "number" && r.hit < 1).length,
      blockMiss: results.filter((r) => r.hasBlocks === false).length,
      shortPrompt: results.filter((r) => typeof r.finalPromptLen === "number" && r.finalPromptLen < 140).length,
      notActionable: results.filter((r) => r.executable === false).length,
      noAdvantageLayer: results.filter((r) => r.strong === false).length
    },
    failures: results.filter((r) => !r.pass),
    results
  };

  const resultsDir = path.join(repoRoot, "docs", "benchmarks", "results");
  const reportsDir = path.join(repoRoot, "docs", "benchmarks", "reports");
  await ensureDir(resultsDir);
  await ensureDir(reportsDir);

  const latestJsonPath = path.join(resultsDir, "final-deliverable-latest.json");
  const datedJsonPath = path.join(resultsDir, `final-deliverable-${payload.runDate}.json`);
  const latestMdPath = path.join(reportsDir, "final-deliverable-latest.md");
  const datedMdPath = path.join(reportsDir, `final-deliverable-${payload.runDate}.md`);

  const reportMd = buildMarkdownReport(payload);

  await fs.writeFile(latestJsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(datedJsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(latestMdPath, reportMd);
  await fs.writeFile(datedMdPath, reportMd);

  console.log(`Final deliverable strict rate: ${(strictRate * 100).toFixed(1)}% (${passed}/${results.length})`);
  console.log(`Target: ${(args.target * 100).toFixed(1)}% => ${payload.passTarget ? "PASS" : "FAIL"}`);
  console.log(`Report: docs/benchmarks/reports/final-deliverable-latest.md`);
  console.log(`Result: docs/benchmarks/results/final-deliverable-latest.json`);

  if (!payload.passTarget) process.exitCode = 1;
}

run().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
