import fs from "node:fs";
import path from "node:path";
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
  const m = String(xml || "").match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
  return {
    cx: m && m[1] ? Number(m[1]) : 12192000,
    cy: m && m[2] ? Number(m[2]) : 6858000
  };
}

function extractBoxes(xml) {
  const src = String(xml || "");
  const out = [];
  const shapeRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let sm;
  while ((sm = shapeRegex.exec(src)) !== null) {
    const part = sm[0];
    const textMatches = [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
    if (!textMatches.length) continue;
    const text = textMatches.map((t) => decodeXmlText(t[1] || "")).filter(Boolean).join(" ").trim();
    if (!text) continue;
    const off = part.match(/<a:off[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i);
    const ext = part.match(/<a:ext[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
    out.push({
      text,
      x: off && off[1] ? Number(off[1]) : 0,
      y: off && off[2] ? Number(off[2]) : 0,
      w: ext && ext[1] ? Number(ext[1]) : 0,
      h: ext && ext[2] ? Number(ext[2]) : 0
    });
  }
  return out;
}

function loadPresentation(filePath) {
  const zip = new AdmZip(fs.readFileSync(filePath));
  const presentationEntry = zip.getEntry("ppt/presentation.xml");
  const size = parseSlideSize(presentationEntry ? presentationEntry.getData().toString("utf8") : "");
  const slideEntries = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
    .sort((a, b) => {
      const ai = Number((a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });

  const slides = slideEntries.map((entry, i) => {
    const boxes = extractBoxes(entry.getData().toString("utf8"));
    const topCount = boxes.filter((b) => b.y / Math.max(1, size.cy) < 0.28).length;
    const midCount = boxes.filter((b) => {
      const r = b.y / Math.max(1, size.cy);
      return r >= 0.28 && r <= 0.88;
    }).length;
    return {
      index: i + 1,
      count: boxes.length,
      topCount,
      midCount,
      sample: boxes.slice(0, 6).map((b) => ({
        t: b.text.slice(0, 24),
        top: Number((b.y / Math.max(1, size.cy)).toFixed(3)),
        h: Number((b.h / Math.max(1, size.cy)).toFixed(3))
      }))
    };
  });

  return {
    fileName: path.basename(filePath),
    slideCount: slides.length,
    slides
  };
}

function compare(a, b) {
  const n = Math.min(a.slideCount, b.slideCount);
  const deltas = [];
  for (let i = 0; i < n; i += 1) {
    const sa = a.slides[i];
    const sb = b.slides[i];
    deltas.push({
      index: i + 1,
      boxDelta: sa.count - sb.count,
      topDelta: sa.topCount - sb.topCount,
      midDelta: sa.midCount - sb.midCount
    });
  }
  return deltas;
}

const src = process.argv[2];
const ref = process.argv[3];
if (!src || !ref) {
  console.error("Usage: node tools/compare-ppt-layout.mjs <source.pptx> <reference.pptx>");
  process.exit(1);
}

const source = loadPresentation(src);
const reference = loadPresentation(ref);
const delta = compare(source, reference);
console.log(JSON.stringify({ source, reference, delta }, null, 2));
