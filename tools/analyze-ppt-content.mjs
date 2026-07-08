import fs from "node:fs";
import AdmZip from "adm-zip";

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseSlideSize(xml) {
  const m = String(xml || "").match(/<p:sldSz[^>]*\bcx=\"(\d+)\"[^>]*\bcy=\"(\d+)\"/i);
  return {
    cx: m && m[1] ? Number(m[1]) : 12192000,
    cy: m && m[2] ? Number(m[2]) : 6858000
  };
}

function getNotesTexts(zip) {
  const notes = zip.getEntries()
    .filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const ai = Number((a.entryName.match(/notesSlide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.entryName.match(/notesSlide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    })
    .map((e) => {
      const xml = e.getData().toString("utf8");
      return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlText(m[1])).filter(Boolean).join(" ");
    });
  return notes;
}

function analyze(filePath) {
  const zip = new AdmZip(fs.readFileSync(filePath));
  const presentationEntry = zip.getEntry("ppt/presentation.xml");
  const size = parseSlideSize(presentationEntry ? presentationEntry.getData().toString("utf8") : "");
  const notes = getNotesTexts(zip);

  const slideEntries = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const ai = Number((a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });

  const stageChecks = [
    /导入|情境|目标/,
    /定律|公式|F\s*=\s*ma|合力|加速度/,
    /受力|受力图|正方向/,
    /实验|变量|数据|图像/,
    /例题|解题|步骤/,
    /易错|误区|纠偏/,
    /练习|作业|总结|小结/
  ];

  let totalChars = 0;
  let numericSlides = 0;
  let formulaSlides = 0;
  let genericHits = 0;
  let noteChars = 0;
  const perSlide = [];
  const allText = [];

  for (let i = 0; i < slideEntries.length; i += 1) {
    const xml = slideEntries[i].getData().toString("utf8");
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
    const texts = [];
    const topTexts = [];

    for (const sp of shapes) {
      const ts = [...sp.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlText(m[1])).filter(Boolean);
      if (!ts.length) continue;
      const txt = ts.join(" ").trim();
      texts.push(txt);
      const off = sp.match(/<a:off[^>]*\by=\"(-?\d+)\"/i);
      const y = off && off[1] ? Number(off[1]) : 0;
      if ((y / Math.max(1, size.cy)) < 0.28) topTexts.push(txt);
    }

    const body = texts.join(" ");
    const chars = body.replace(/\s+/g, "").length;
    totalChars += chars;
    allText.push(body);

    if (/(\d+\.?\d*\s*(N|kg|m\/s2|m\/s²|%))/i.test(body)) numericSlides += 1;
    if (/(F\s*=\s*ma|牛顿第二定律|合力|加速度)/i.test(body)) formulaSlides += 1;
    if (/(当前需求|补充|占位|示例|模板|待完善|后续)/.test(body)) genericHits += 1;

    const note = String(notes[i] || "");
    noteChars += note.replace(/\s+/g, "").length;

    perSlide.push({
      index: i + 1,
      title: String(topTexts[0] || texts[0] || "").slice(0, 36),
      chars,
      hasNumeric: /(\d+\.?\d*\s*(N|kg|m\/s2|m\/s²|%))/i.test(body),
      hasFormula: /(F\s*=\s*ma|牛顿第二定律|合力|加速度)/i.test(body),
      generic: /(当前需求|补充|占位|示例|模板|待完善|后续)/.test(body)
    });
  }

  const merged = allText.join(" ");
  const stageCoverage = stageChecks.filter((re) => re.test(merged)).length / stageChecks.length;

  return {
    file: filePath,
    slideCount: slideEntries.length,
    avgCharsPerSlide: Number((totalChars / Math.max(1, slideEntries.length)).toFixed(1)),
    numericSlideRatio: Number((numericSlides / Math.max(1, slideEntries.length)).toFixed(3)),
    formulaSlideRatio: Number((formulaSlides / Math.max(1, slideEntries.length)).toFixed(3)),
    genericSlideRatio: Number((genericHits / Math.max(1, slideEntries.length)).toFixed(3)),
    stageCoverage: Number(stageCoverage.toFixed(3)),
    avgNotesChars: Number((noteChars / Math.max(1, slideEntries.length)).toFixed(1)),
    perSlide
  };
}

const a = process.argv[2];
const b = process.argv[3];
if (!a) {
  console.error("Usage: node tools/analyze-ppt-content.mjs <a.pptx> [b.pptx]");
  process.exit(1);
}
const A = analyze(a);
if (!b) {
  console.log(JSON.stringify({ A }, null, 2));
  process.exit(0);
}
const B = analyze(b);
console.log(JSON.stringify({ A, B }, null, 2));
