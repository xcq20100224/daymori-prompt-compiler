import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run() {
  const script = path.join(__dirname, "run-production-sla-benchmark.mjs");
  const env = {
    ...process.env,
    BENCH_OUTPUT_PREFIX: "lazyman-production-sla",
    BENCH_PROVIDER_LABEL: "lazyman"
  };

  const child = spawnSync(process.execPath, [script], {
    env,
    stdio: "inherit"
  });

  if (child.error) {
    throw child.error;
  }
  if (typeof child.status === "number" && child.status !== 0) {
    process.exitCode = child.status;
  }
}

run();
