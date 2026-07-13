import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const repoRoot = process.cwd();
const constraintsPath = path.resolve(repoRoot, 'config/lazyman-constraints.json');
const constraints = JSON.parse(fs.readFileSync(constraintsPath, 'utf8'));

function compilePattern(pattern, fallbackFlags = 'gi') {
    if (pattern instanceof RegExp) return pattern;
    if (typeof pattern !== 'string') return new RegExp(String(pattern), fallbackFlags);

    const regexLiteral = pattern.match(/^\/(.*)\/([a-z]*)$/i);
    if (regexLiteral) {
        const body = regexLiteral[1];
        const flags = regexLiteral[2] || fallbackFlags;
        return new RegExp(body, flags);
    }

    return new RegExp(pattern, fallbackFlags);
}

function collectSlides(zip) {
    return zip
        .getEntries()
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName));
}

function extractTextNodes(xml) {
    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/gi) || [];
    return matches
        .map((raw) => raw.replace(/^<a:t[^>]*>/i, '').replace(/<\/a:t>$/i, ''))
        .map((s) => s.trim())
        .filter(Boolean);
}

function toRepoRelative(p) {
    return path.relative(repoRoot, p).replace(/\\/g, '/');
}

function validatePPTX(pptxPath) {
    const violations = [];
    const zip = new AdmZip(pptxPath);
    const slides = collectSlides(zip);
    const relPath = toRepoRelative(path.resolve(repoRoot, pptxPath));
    const allowedTemplates = constraints.template?.allowedTemplates || [];
    const isAllowedTemplate = allowedTemplates.some((t) => toRepoRelative(path.resolve(repoRoot, t)) === relPath);

    const watermarkPatterns = constraints.qualityGate.blockers.watermark.patterns;
    for (const entry of slides) {
        const content = entry.getData().toString('utf8');

        for (const pattern of watermarkPatterns) {
            const regex = compilePattern(pattern, 'gi');
            const matches = content.match(regex);
            if (matches && matches.length > constraints.qualityGate.blockers.watermark.maxOccurrences) {
                violations.push({
                    type: 'watermark',
                    severity: constraints.qualityGate.blockers.watermark.severity,
                    slide: entry.entryName,
                    pattern,
                    count: matches.length
                });
            }
        }
    }

    const pageNumberPatterns = constraints.qualityGate.blockers.pageNumber.patterns;
    for (const entry of slides) {
        const content = entry.getData().toString('utf8');
        const textOnly = extractTextNodes(content).join(' ');

        for (const pattern of pageNumberPatterns) {
            const regex = compilePattern(pattern, 'gi');
            const matches = textOnly.match(regex);
            if (matches && matches.length > constraints.qualityGate.blockers.pageNumber.maxOccurrences) {
                violations.push({
                    type: 'pageNumber',
                    severity: constraints.qualityGate.blockers.pageNumber.severity,
                    slide: entry.entryName,
                    pattern,
                    count: matches.length
                });
            }
        }
    }

    if (!isAllowedTemplate) {
        let halfFilledCount = 0;
        for (const entry of slides) {
            const content = entry.getData().toString('utf8');
            const texts = extractTextNodes(content);
            const totalText = texts.join('').length;

            if (totalText < constraints.qualityGate.blockers.halfFilled.minTextPerSlide) {
                halfFilledCount += 1;
                violations.push({
                    type: 'halfFilled',
                    severity: constraints.qualityGate.blockers.halfFilled.severity,
                    slide: entry.entryName,
                    textLength: totalText
                });
            }
        }

        const halfFilledRatio = slides.length ? halfFilledCount / slides.length : 0;
        if (halfFilledRatio > constraints.qualityGate.blockers.halfFilled.maxEmptyRatio) {
            violations.push({
                type: 'halfFilledRatio',
                severity: constraints.qualityGate.blockers.halfFilled.severity,
                ratio: halfFilledRatio,
                threshold: constraints.qualityGate.blockers.halfFilled.maxEmptyRatio
            });
        }
    }

    const criticalCount = violations.filter((v) => v.severity === 'CRITICAL').length;
    const highCount = violations.filter((v) => v.severity === 'HIGH').length;

    let score = 100;
    score -= criticalCount * 20;
    score -= highCount * 10;
    score = Math.max(0, score);

    const passed = score >= constraints.qualityGate.minScore;

    return {
        passed,
        score,
        violations,
        summary: {
            critical: criticalCount,
            high: highCount,
            total: violations.length
        }
    };
}

const pptxArg = process.argv[2];
if (!pptxArg) {
    console.error('用法: node tools/validate-lazyman-constraints.mjs <pptx文件路径>');
    process.exit(1);
}

const pptxPath = path.resolve(repoRoot, pptxArg);
if (!fs.existsSync(pptxPath)) {
    console.error(`文件不存在: ${pptxPath}`);
    process.exit(1);
}

const result = validatePPTX(pptxPath);

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║         LazyMan约束验证                                ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

console.log(`文件: ${path.basename(pptxPath)}`);
console.log(`分数: ${result.score}/100`);
console.log(`状态: ${result.passed ? '✅ 通过' : '❌ 未通过'}\n`);

if (result.violations.length > 0) {
    console.log('违规项:\n');
    result.violations.slice(0, 10).forEach((v, i) => {
        console.log(`${i + 1}. [${v.severity}] ${v.type}`);
        if (v.slide) console.log(`   页面: ${v.slide}`);
        if (v.pattern) console.log(`   模式: ${v.pattern}`);
        if (typeof v.count === 'number') console.log(`   次数: ${v.count}`);
        if (typeof v.textLength === 'number') console.log(`   文本长度: ${v.textLength}`);
    });
}

console.log(`\n汇总: 严重${result.summary.critical} | 高${result.summary.high} | 总计${result.summary.total}\n`);

process.exit(result.passed ? 0 : 1);
