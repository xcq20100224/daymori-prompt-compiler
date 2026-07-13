import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_RE =
  /(输入|添加标题|点击此处|lorem|your\s*title|内容打在这里|this\s*is\s*your\s*title|enter\s*your\s*title|click\s*to\s*add|标题文字添加|副标题内容)/i;
const META_RE = /^(logo|content)$/i;
const FOOTER_RE =
  /officeplus|^时间[:：]|^part\s*\d+|^\d+([/\-]\d+)?$|内容由ai生成/i;
const PAGE_NUMBER_RE = /^\s*\d+\s*\/\s*\d+\s*$/;
const VERSION_WORD_RE = /(V\d|新版|修订版|执行版)/i;

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractTextRunsFromSlideXml(xml) {
  const src = String(xml || "");
  const shapeRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  const out = [];
  let sm;
  while ((sm = shapeRegex.exec(src)) !== null) {
    const part = sm[0];
    const textMatches = [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
    for (const tm of textMatches) {
      const t = decodeXmlText(tm[1]);
      if (t) out.push(t);
    }
  }
  return out;
}

function classifyText(text) {
  const t = String(text || "").trim();
  if (!t) return "empty";
  if (META_RE.test(t) || FOOTER_RE.test(t)) return "meta";
  if (PLACEHOLDER_RE.test(t)) return "placeholder";
  return "content";
}

function isPageNumberLike(text) {
  return PAGE_NUMBER_RE.test(String(text || "").trim());
}

function hasVersionWord(text) {
  return VERSION_WORD_RE.test(String(text || "").trim());
}

export function analyzePptxBuffer(buffer, fileName = "") {
  const zip = new AdmZip(buffer);
  const slideEntries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const ai = Number((a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });

  const slides = [];
  let textRuns = 0;
  let placeholderRuns = 0;
  let contentRuns = 0;
  let pageNumberRuns = 0;
  let metadataRuns = 0;

  for (let i = 0; i < slideEntries.length; i += 1) {
    const xml = slideEntries[i].getData().toString("utf8");
    const texts = extractTextRunsFromSlideXml(xml);
    const classes = texts.map(classifyText);
    const pageNumberCount = texts.filter(isPageNumberLike).length;
    const metadataCount = texts.filter(
      (t) => META_RE.test(String(t || "").trim()) || hasVersionWord(t),
    ).length;

    const placeholderCount = classes.filter((c) => c === "placeholder").length;
    const contentCount = classes.filter((c) => c === "content").length;

    const empty = texts.length === 0;
    const placeholderOnly =
      !empty && contentCount === 0 && placeholderCount > 0;
    const halfFilled = contentCount > 0 && contentCount <= 2;

    slides.push({
      index: i + 1,
      textRuns: texts.length,
      placeholderRuns: placeholderCount,
      contentRuns: contentCount,
      pageNumberRuns: pageNumberCount,
      metadataRuns: metadataCount,
      empty,
      placeholderOnly,
      halfFilled,
    });

    textRuns += texts.length;
    placeholderRuns += placeholderCount;
    contentRuns += contentCount;
    pageNumberRuns += pageNumberCount;
    metadataRuns += metadataCount;
  }

  const emptySlides = slides.filter((s) => s.empty).map((s) => s.index);
  const placeholderOnlySlides = slides
    .filter((s) => s.placeholderOnly)
    .map((s) => s.index);
  const contentSlides = slides
    .filter((s) => s.contentRuns > 0)
    .map((s) => s.index);
  const pageNumberSlides = slides
    .filter((s) => s.pageNumberRuns > 0)
    .map((s) => s.index);
  const metadataSlides = slides
    .filter((s) => s.metadataRuns > 0)
    .map((s) => s.index);
  const halfFilledSlides = slides
    .filter((s) => s.halfFilled)
    .map((s) => s.index);

  const slideCount = slides.length;
  const contentCoverage =
    slideCount > 0 ? contentSlides.length / slideCount : 0;
  const placeholderRatio = textRuns > 0 ? placeholderRuns / textRuns : 1;
  const halfFilledRatio =
    slideCount > 0 ? halfFilledSlides.length / slideCount : 0;

  return {
    fileName,
    slideCount,
    textRuns,
    placeholderRuns,
    contentRuns,
    pageNumberRuns,
    metadataRuns,
    emptySlides,
    placeholderOnlySlides,
    contentSlides,
    pageNumberSlides,
    metadataSlides,
    halfFilledSlides,
    contentCoverage,
    placeholderRatio,
    halfFilledRatio,
    gate: {
      pass:
        emptySlides.length === 0 &&
        placeholderOnlySlides.length === 0 &&
        pageNumberSlides.length === 0 &&
        metadataSlides.length === 0 &&
        halfFilledRatio <= 0.15 &&
        contentCoverage >= 0.98,
      reasons: [
        ...(emptySlides.length > 0
          ? [`blank_slides:${emptySlides.join(",")}`]
          : []),
        ...(placeholderOnlySlides.length > 0
          ? [`placeholder_only_slides:${placeholderOnlySlides.join(",")}`]
          : []),
        ...(pageNumberSlides.length > 0
          ? [`page_number_slides:${pageNumberSlides.join(",")}`]
          : []),
        ...(metadataSlides.length > 0
          ? [`metadata_slides:${metadataSlides.join(",")}`]
          : []),
        ...(halfFilledRatio > 0.15
          ? [`half_filled_ratio_high:${halfFilledRatio.toFixed(3)}`]
          : []),
        ...(contentCoverage < 0.98
          ? [`content_coverage_low:${contentCoverage.toFixed(3)}`]
          : []),
      ],
    },
    slides,
  };
}

export function analyzePptxFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return analyzePptxBuffer(buf, path.basename(filePath));
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error(
      "Usage: node tools/ppt-quality-metrics.mjs <file1.pptx> [file2.pptx ...]",
    );
    process.exit(1);
  }

  const out = [];
  for (const file of files) {
    try {
      out.push({ file, ok: true, metrics: analyzePptxFile(file) });
    } catch (error) {
      out.push({
        file,
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
