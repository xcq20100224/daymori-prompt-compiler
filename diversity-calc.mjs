import fs from "node:fs";
import path from "node:path";

function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function usage() {
    console.error("Usage: node diversity-calc.mjs <results.json> [out.json]");
    process.exit(1);
}

const inputPath = process.argv[2];
const outPath = process.argv[3] || "";
if (!inputPath) usage();

const absInput = path.resolve(process.cwd(), inputPath);
if (!fs.existsSync(absInput)) {
    console.error(`results file not found: ${absInput}`);
    process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(absInput, "utf8"));
const list = Array.isArray(rows) ? rows : [];

const signature = (row) => {
    const slides = Array.isArray(row && row.dump && row.dump.slides) ? row.dump.slides : [];
    return JSON.stringify(
        slides.map((slide) => ({
            title: compact(slide && slide.title),
            texts: (Array.isArray(slide && slide.texts) ? slide.texts : []).map(compact).slice(0, 3)
        }))
    );
};

const unique = new Set(list.map(signature)).size;
const result = {
    total: list.length,
    unique,
    diversityRatePct: list.length ? Math.round((unique * 100) / list.length) : 0
};

if (outPath) {
    const absOut = path.resolve(process.cwd(), outPath);
    fs.writeFileSync(absOut, JSON.stringify(result, null, 2), "utf8");
}

console.log(JSON.stringify(result, null, 2));
