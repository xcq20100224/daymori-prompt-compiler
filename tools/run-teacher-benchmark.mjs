import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const FALLBACK_KEY = "sk-5ba1c769ac7d4708" + "88963788d1a7eaab";
const API_KEY = process.env.DEEPSEEK_API_KEY || FALLBACK_KEY;

function firstJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toReadable(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n").trim();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function parseStructuredResponse(rawText) {
  const candidate = firstJsonObject(rawText);
  if (candidate) {
    const parsed = safeJsonParse(candidate);
    if (parsed && typeof parsed === "object") {
      return {
        goals: toReadable(parsed.goals),
        pagePlan: toReadable(parsed.pagePlan),
        pageDetails: toReadable(parsed.pageDetails),
        interaction: toReadable(parsed.interaction),
        homework: toReadable(parsed.homework),
        finalPrompt: toReadable(parsed.finalPrompt)
      };
    }
  }
  return {
    goals: "",
    pagePlan: "",
    pageDetails: "",
    interaction: "",
    homework: "",
    finalPrompt: String(rawText || "").trim()
  };
}

function estimateGeneratedPageCount(structured) {
  const text = [structured.pagePlan, structured.pageDetails, structured.finalPrompt].join("\n");
  const pageNums = [];
  const r = /第\s*(\d{1,2})\s*页/g;
  let m;
  while ((m = r.exec(text)) !== null) pageNums.push(Number(m[1]));
  if (pageNums.length >= 2) return Math.max(...pageNums);
  const totalMatch = text.match(/(\d{1,2})\s*页(?:课堂|PPT|课件|演示|提示词)?/);
  return totalMatch ? Number(totalMatch[1]) : null;
}

function evaluateCase(item, structured) {
  const blocks = ["goals", "pagePlan", "pageDetails", "interaction", "homework", "finalPrompt"];
  const complete = blocks.every((k) => structured[k] && String(structured[k]).trim());

  const gotPage = estimateGeneratedPageCount(structured);
  const pageOk = item.pageCount ? gotPage === item.pageCount : true;

  let homeworkOk = true;
  if (item.requireHomeworkLevels) {
    const hw = String(structured.homework || "");
    homeworkOk = /(基础|基础层)/.test(hw) && /(提高|进阶|提高层)/.test(hw) && /(挑战|拓展|挑战层|拓展层)/.test(hw);
  }

  const pass = complete && pageOk && homeworkOk;
  return { pass, complete, pageOk, gotPage, homeworkOk };
}

async function requestStructured(prompt, pageCount) {
  const system = [
    "你是课堂PPT提示词专家。",
    "请严格输出 JSON，字段必须包含：goals,pagePlan,pageDetails,interaction,homework,finalPrompt。",
    "六个字段都必须为字符串，不允许数组或对象。",
    pageCount
      ? `硬约束：必须输出${pageCount}页，pagePlan/pageDetails/finalPrompt都要体现第1页到第${pageCount}页。`
      : ""
  ].join(" ");

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 850,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    })
  });

  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("API returned non-JSON: " + raw.slice(0, 180));
  }

  if (!resp.ok) {
    const detail = data.detail || data.error || (data.error && data.error.message) || raw.slice(0, 200);
    throw new Error(`API request failed (${resp.status}): ${detail}`);
  }

  return data?.choices?.[0]?.message?.content || "";
}

async function run() {
  const benchmarkPath = path.join(repoRoot, "docs", "benchmarks", "teacher-prompts.json");
  const text = await fs.readFile(benchmarkPath, "utf8");
  const datasetRaw = JSON.parse(text);
  const limit = Number(process.env.BENCH_LIMIT || 0);
  const dataset = Number.isFinite(limit) && limit > 0 ? datasetRaw.slice(0, limit) : datasetRaw;

  console.log(`Loaded ${dataset.length} benchmark cases.`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("Warning: DEEPSEEK_API_KEY not set, using repository fallback key.");
  }

  const results = [];
  for (const item of dataset) {
    const payload = [
      "[用户需求]",
      item.prompt,
      "",
      "[输出要求]",
      "请输出课堂PPT结构化结果，供教师直接出稿。"
    ].join("\n");

    try {
      const raw = await requestStructured(payload, item.pageCount);
      const structured = parseStructuredResponse(raw);
      const evalResult = evaluateCase(item, structured);
      results.push({ id: item.id, ...evalResult });
      console.log(
        `${item.id} | ${evalResult.pass ? "PASS" : "FAIL"} | page=${evalResult.gotPage || "?"}/${item.pageCount} | complete=${evalResult.complete}`
      );
    } catch (error) {
      results.push({ id: item.id, pass: false, complete: false, pageOk: false, gotPage: null, homeworkOk: false, error: error.message });
      console.log(`${item.id} | ERROR | ${error.message}`);
    }
  }

  const total = results.length;
  const pageAccuracy = results.filter((r) => r.pageOk).length / total;
  const completeRate = results.filter((r) => r.complete).length / total;
  const passRate = results.filter((r) => r.pass).length / total;

  console.log("\n=== Benchmark Summary ===");
  console.log(`Page Accuracy: ${(pageAccuracy * 100).toFixed(1)}%`);
  console.log(`Block Completeness: ${(completeRate * 100).toFixed(1)}%`);
  console.log(`Overall Pass Rate: ${(passRate * 100).toFixed(1)}%`);

  const minPage = Number(process.env.BENCH_PAGE_THRESHOLD || 0.95);
  const minComplete = Number(process.env.BENCH_COMPLETE_THRESHOLD || 0.95);

  if (pageAccuracy < minPage || completeRate < minComplete) {
    console.error("Benchmark thresholds not met.");
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
