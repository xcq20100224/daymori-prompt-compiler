import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

function listExportDecks(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const dirs = fs.readdirSync(rootDir)
    .map((name) => {
      const abs = path.join(rootDir, name);
      const stat = fs.statSync(abs);
      return { name, abs, stat };
    })
    .filter((x) => x.stat.isDirectory());

  const rows = [];
  for (const d of dirs) {
    const deck = path.join(d.abs, "deck.pptx");
    if (!fs.existsSync(deck)) continue;
    const stat = fs.statSync(deck);
    rows.push({ deck, mtimeMs: Number(stat.mtimeMs || 0) });
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function isMetaText(text) {
  return /^(logo|content)$/i.test(text) || /officeplus|^时间[:：]|^part\s*\d+|^\d+([\/\-]\d+)?$/i.test(text);
}

function readSlideInfo(zip, entryName, index) {
  const xml = zip.getEntry(entryName)?.getData().toString("utf8") || "";
  const isHidden = /<p:sld\b[^>]*\bshow="0"/i.test(xml);
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
    .map((m) => String(m[0] || ""))
    .map((part) => {
      const off = part.match(/<a:off[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i);
      const x = off && off[1] ? Number(off[1]) : 0;
      const y = off && off[2] ? Number(off[2]) : 0;
      const text = [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m2) => decodeXmlText(m2[1] || ""))
        .map((v) => v.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      return { x, y, text };
    })
    .filter((r) => !!r.text)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const texts = shapes.map((s) => s.text).filter(Boolean);
  const visibleTexts = texts.filter((t) => !isMetaText(t));
  const titleCandidate = visibleTexts.find((t) => t.length >= 3) || "";

  return {
    index,
    relationshipId: "",
    isHidden,
    textCount: visibleTexts.length,
    texts: visibleTexts,
    titleCandidate
  };
}

function parseSlideRelationshipMap(zip) {
  const presentationXml = zip.getEntry("ppt/presentation.xml")?.getData().toString("utf8") || "";
  const relsXml = zip.getEntry("ppt/_rels/presentation.xml.rels")?.getData().toString("utf8") || "";

  const slideRids = [...presentationXml.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)].map((m) => String(m[1] || ""));
  const ridToTarget = new Map();
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    ridToTarget.set(String(m[1] || ""), String(m[2] || ""));
  }

  const out = new Map();
  slideRids.forEach((rid, idx) => {
    out.set(idx + 1, {
      relationshipId: rid,
      target: ridToTarget.get(rid) || ""
    });
  });
  return out;
}

function main() {
  const exportsDir = path.resolve("docs", "benchmarks", "results", "exports");
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
  const deckPath = inputPath || (listExportDecks(exportsDir)[0] && listExportDecks(exportsDir)[0].deck) || "";

  if (!deckPath || !fs.existsSync(deckPath)) {
    console.error("inspect_failed:no_ppt_found");
    process.exitCode = 1;
    return;
  }

  const zip = new AdmZip(deckPath);
  const slideEntries = zip.getEntries()
    .map((e) => e.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const ai = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });

  const relMap = parseSlideRelationshipMap(zip);

  const slides = slideEntries.map((name, i) => {
    const row = readSlideInfo(zip, name, i + 1);
    const rel = relMap.get(i + 1) || { relationshipId: "", target: "" };
    row.relationshipId = rel.relationshipId;
    row.relationshipTarget = rel.target;
    return row;
  });
  const physicalSlideCount = slides.length;
  const hiddenSlideCount = slides.filter((s) => s.isHidden).length;
  const visibleSlideCount = physicalSlideCount - hiddenSlideCount;

  const out = {
    deckPath: path.relative(process.cwd(), deckPath).replace(/\\/g, "/"),
    physicalSlideCount,
    visibleSlideCount,
    hiddenSlideCount,
    slides
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
