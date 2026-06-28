import fs from "fs";
import path from "path";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function logCheck(label, ok, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  const suffix = detail ? ` | ${detail}` : "";
  console.log(`[${tag}] ${label}${suffix}`);
}

async function main() {
  const root = process.cwd();
  const envPath = path.join(root, ".env");
  const localEnv = parseEnvFile(envPath);

  const llmProvider = process.env.LLM_PROVIDER || localEnv.LLM_PROVIDER || "";
  const deepseekKey = process.env.DEEPSEEK_API_KEY || localEnv.DEEPSEEK_API_KEY || "";

  logCheck("LLM_PROVIDER is deepseek", llmProvider.toLowerCase() === "deepseek", `value=${llmProvider || "(empty)"}`);
  logCheck("DEEPSEEK_API_KEY configured", Boolean(deepseekKey), `length=${deepseekKey.length}`);

  const payload = {
    contract: {
      contractVersion: "aippt.v1",
      engineType: "generic-aippt",
      sceneType: "business-demo",
      templateId: "template-enterprise-001",
      pageCount: 1,
      visualStyle: "minimal",
      tone: "clear",
      topic: "deepseek-selfcheck",
      slides: [
        {
          index: 1,
          title: "Cover",
          goal: "Verify export path",
          keyPoints: ["deepseek", "local-pptx"],
          assetPlaceholders: ["logo"],
          speakerNotes: "self-check"
        }
      ]
    }
  };

  let response;
  try {
    response = await fetch("http://localhost:3000/api/ppt/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    logCheck("POST /api/ppt/export reachable", false, String(error.message || error));
    console.error("Hint: start server first with npm start");
    process.exit(1);
  }

  const resultDir = path.join(root, "docs", "benchmarks", "results");
  fs.mkdirSync(resultDir, { recursive: true });

  const engine = response.headers.get("x-ppt-engine") || "(missing)";
  const contentType = response.headers.get("content-type") || "(missing)";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const errorPath = path.join(resultDir, "deepseek-selfcheck-error.json");
    fs.writeFileSync(errorPath, buffer);
    logCheck("Export response status", false, `status=${response.status}`);
    logCheck("x-ppt-engine present", Boolean(engine && engine !== "(missing)"), `value=${engine}`);
    console.error(`Error body saved to ${errorPath}`);
    process.exit(1);
  }

  const filePath = path.join(resultDir, "deepseek-selfcheck-export.pptx");
  fs.writeFileSync(filePath, buffer);

  logCheck("Export response status", true, `status=${response.status}`);
  logCheck("x-ppt-engine present", Boolean(engine && engine !== "(missing)"), `value=${engine}`);
  logCheck("PPTX bytes > 1000", buffer.length > 1000, `bytes=${buffer.length}`);
  logCheck("Content-Type looks pptx", /presentationml\.presentation/i.test(contentType), `value=${contentType}`);

  console.log(`Output: ${filePath}`);

  const success = buffer.length > 1000;
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
