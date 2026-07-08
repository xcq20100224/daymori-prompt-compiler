import fs from "node:fs";
import path from "node:path";

const exportsDir = path.resolve("docs", "benchmarks", "results", "exports");

const PLACEHOLDER_PATTERNS = [
  /OfficePLUS/i,
  /20XX/i,
  /202X/i,
  /时间[:：]\s*202X/i,
  /输入标题/i,
  /单击添加标题/i,
  /单击添加副标题/i,
  /请在此输入/i,
  /请您单击此处/i,
  /本章目标/i,
  /click\s*to\s*add/i,
  /placeholder/i,
  /template/i,
  /CONTENT/i,
  /LOGO/i
];

function latestDumpFile() {
  if (!fs.existsSync(exportsDir)) return "";
  const files = [];
  for (const entry of fs.readdirSync(exportsDir)) {
    const abs = path.join(exportsDir, entry);
    const st = fs.statSync(abs);
    if (st.isFile() && entry.endsWith(".dump.json")) files.push(abs);
    if (st.isDirectory()) {
      const dump = path.join(abs, "dump.json");
      if (fs.existsSync(dump)) files.push(dump);
    }
  }
  if (!files.length) return "";
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

function normalizeTitle(x) {
  return String(x || "")
    .replace(/^封面[:：]/, "")
    .replace(/^第[一二三四五六七八九十]+[章节、.：:]\s*/, "")
    .replace(/^PART\s*\d+/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function hasPlaceholder(text) {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(String(text || "")));
}

function validateDump(payload) {
  const errors = [];
  const slides = Array.isArray(payload && payload.slides) ? payload.slides : [];
  const count = Number(payload && payload.slideCount) || slides.length;
  const quality = payload && payload.qualityScore ? payload.qualityScore : null;

  if (count < 8 || count > 12) {
    errors.push({ slideIndex: 0, type: "slideCount", text: `slideCount=${count}` });
  }

  if (!quality || Number(quality.overall || 0) < 85) {
    errors.push({ slideIndex: 0, type: "qualityOverall", text: JSON.stringify(quality || {}) });
  }
  if (!quality || Number(quality.templateUsage || 0) < 80) {
    errors.push({ slideIndex: 0, type: "qualityTemplateUsage", text: JSON.stringify(quality || {}) });
  }
  if (!quality || Number(quality.visualCleanliness || 0) < 85) {
    errors.push({ slideIndex: 0, type: "qualityVisualCleanliness", text: JSON.stringify(quality || {}) });
  }
  if (!quality || Number(quality.contentSpecificity || 0) < 85) {
    errors.push({ slideIndex: 0, type: "qualityContentSpecificity", text: JSON.stringify(quality || {}) });
  }
  if (!quality || Number(quality.exportIntegrity || 0) < 100) {
    errors.push({ slideIndex: 0, type: "qualityExportIntegrity", text: JSON.stringify(quality || {}) });
  }

  for (const s of slides) {
    const idx = Number(s && s.index) || 0;
    const title = String(s && s.title || "");
    const texts = Array.isArray(s && s.texts) ? s.texts : [];
    if (!texts.length) {
      errors.push({ slideIndex: idx, type: "blankSlide", text: "" });
      continue;
    }
    const nonEmpty = texts.map((x) => String(x || "").trim()).filter(Boolean);
    if (!nonEmpty.length) errors.push({ slideIndex: idx, type: "blankSlide", text: "" });

    const matchTitleCount = nonEmpty.filter((x) => {
      const a = normalizeTitle(x);
      const b = normalizeTitle(title);
      return a && b && (a === b || a.includes(b) || b.includes(a));
    }).length;
    const slideType = String(s && s.type || "").toLowerCase();
    if (matchTitleCount > 2 && slideType !== "section") {
      errors.push({ slideIndex: idx, type: "duplicateTitleInSlide", text: title });
    }

    for (const t of nonEmpty) {
      if (hasPlaceholder(t)) errors.push({ slideIndex: idx, type: "forbiddenText", text: t });
      if (/(结论：|证据：|行动：)/.test(t)) errors.push({ slideIndex: idx, type: "mechanicalPhrase", text: t });
    }

    if (nonEmpty.some((t) => String(t).length > 150)) {
      errors.push({ slideIndex: idx, type: "overlongText", text: nonEmpty.find((t) => String(t).length > 150) || "" });
    }
  }

  for (let i = 1; i < slides.length; i += 1) {
    const prev = normalizeTitle(slides[i - 1] && slides[i - 1].title);
    const cur = normalizeTitle(slides[i] && slides[i].title);
    if (prev && cur && prev === cur) {
      errors.push({ slideIndex: Number(slides[i] && slides[i].index) || i + 1, type: "repeatedDeckTitle", text: String(slides[i] && slides[i].title || "") });
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const file = latestDumpFile();
  if (!file) {
    console.error("FAIL: no dump file found");
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = validateDump(payload);
  if (result.ok) {
    console.log(`PASS: ${path.relative(process.cwd(), file).replace(/\\/g, "/")}`);
    return;
  }

  console.error(`FAIL: ${path.relative(process.cwd(), file).replace(/\\/g, "/")}`);
  for (const err of result.errors) {
    console.error(`- slideIndex=${err.slideIndex} type=${err.type} text=${String(err.text || "").slice(0, 120)}`);
  }
  process.exitCode = 1;
}

main();
