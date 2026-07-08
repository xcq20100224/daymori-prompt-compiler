import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

function decodeXmlText(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function analyzePPTX(pptxPath) {
    const zip = new AdmZip(pptxPath);
    const slides = [];

    for (const entry of zip.getEntries()) {
        if (!/^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName)) continue;

        const xml = entry.getData().toString('utf8');
        const texts = [];
        const textMatches = xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g);
        for (const match of textMatches) {
            texts.push(decodeXmlText(match[1]));
        }

        slides.push({
            name: entry.entryName,
            texts,
            xml
        });
    }

    slides.sort((a, b) => {
        const an = Number((a.name.match(/slide(\d+)\.xml/i) || [])[1] || 0);
        const bn = Number((b.name.match(/slide(\d+)\.xml/i) || [])[1] || 0);
        return an - bn;
    });

    return slides;
}

function diagnose(pptxPath) {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║           LazyMan级质量诊断                            ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    const slides = analyzePPTX(pptxPath);
    console.log(`📄 总页数: ${slides.length}\\n`);

    const watermarks = ['内容由AI生成', '由AI生成', 'AI生成', 'LOGO', 'CONTENT', 'OfficePLUS'];
    const pageNumberPattern = /\b\d+\s*\/\s*\d+\b/;

    let watermarkCount = 0;
    let pageNumberCount = 0;

    slides.forEach((slide, idx) => {
        const allText = slide.texts.join(' ');

        if (watermarks.some((w) => allText.includes(w))) {
            watermarkCount += 1;
            console.log(`❌ 第${idx + 1}页: 发现水印 "${allText.slice(0, 50)}..."`);
        }

        if (pageNumberPattern.test(allText)) {
            pageNumberCount += 1;
            console.log(`❌ 第${idx + 1}页: 发现页码标注`);
        }
    });

    console.log(`\\n📊 水印污染: ${watermarkCount}/${slides.length}页`);
    console.log(`📊 页码污染: ${pageNumberCount}/${slides.length}页\\n`);

    console.log('=== 内容密度分析 ===\\n');

    let emptyPages = 0;
    let halfFilledPages = 0;

    slides.forEach((slide, idx) => {
        const contentTexts = slide.texts.filter((t) => t.trim().length > 5);

        if (contentTexts.length === 0) {
            emptyPages += 1;
            console.log(`❌ 第${idx + 1}页: 空页（无有效内容）`);
        } else if (contentTexts.length <= 2) {
            halfFilledPages += 1;
            console.log(`⚠️  第${idx + 1}页: 半填充（只有${contentTexts.length}条内容）`);
            console.log(`    内容: ${contentTexts.join(' | ').slice(0, 80)}...`);
        } else {
            console.log(`✅ 第${idx + 1}页: 正常（${contentTexts.length}条内容）`);
        }
    });

    console.log(`\\n📊 空页: ${emptyPages}/${slides.length}`);
    console.log(`📊 半填充: ${halfFilledPages}/${slides.length} (LazyMan标准<=15%)\\n`);

    console.log('=== 标题重复检查 ===\\n');

    const titleFreq = {};
    slides.forEach((slide) => {
        const firstText = slide.texts[0] || '';
        const words = firstText.match(/[\u4e00-\u9fa5]{3,}|[a-zA-Z]{4,}/g) || [];
        words.forEach((w) => {
            titleFreq[w] = (titleFreq[w] || 0) + 1;
        });
    });

    const repeated = Object.entries(titleFreq)
        .filter(([, c]) => c > 3)
        .sort((a, b) => b[1] - a[1]);

    if (repeated.length > 0) {
        console.log('❌ 发现过度重复的词语:\\n');
        repeated.forEach(([w, c]) => {
            console.log(`   "${w}" 出现 ${c} 次 (LazyMan标准<=3)`);
        });
    } else {
        console.log('✅ 无过度重复\\n');
    }

    console.log('\\n╔════════════════════════════════════════════════════════╗');
    console.log('║              LazyMan评分预估                           ║');
    console.log('╚════════════════════════════════════════════════════════╝\\n');

    const checks = {
        noWatermarks: watermarkCount === 0,
        noPageNumbers: pageNumberCount === 0,
        lowHalfFilled: slides.length > 0 ? (halfFilledPages / slides.length) <= 0.15 : true,
        noEmptyPages: emptyPages === 0,
        lowRepetition: repeated.length === 0
    };

    const passed = Object.values(checks).filter((v) => v).length;
    const total = Object.keys(checks).length;
    const score = Math.round((passed / total) * 100);

    console.log('检查项:\\n');
    Object.entries(checks).forEach(([k, v]) => {
        console.log(`  ${v ? '✅' : '❌'} ${k}`);
    });

    const level = score >= 95 ? 'LazyMan' : score >= 88 ? 'Near-LazyMan' : score >= 75 ? 'Good' : 'Needs-Work';
    console.log(`\\n预估分数: ${score}/100`);
    console.log(`LazyMan级别: ${level}\\n`);

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║              修复建议（优先级排序）                    ║');
    console.log('╚════════════════════════════════════════════════════════╝\\n');

    if (!checks.noWatermarks) {
        console.log('🔴 P0: 清除水印污染');
        console.log('   - 修改模板文件，删除所有"内容由AI生成"等占位符');
        console.log('   - 检查 docs/benchmarks/templates/inbox/*.pptx\\n');
    }

    if (!checks.noPageNumbers) {
        console.log('🔴 P0: 清除页码标注');
        console.log('   - 禁止在生成逻辑中添加"X/Y"格式的页码\\n');
    }

    if (!checks.lowHalfFilled) {
        console.log('🟠 P1: 提升内容密度');
        console.log('   - 修改prompt，要求每页至少3条完整要点');
        console.log('   - 参考Day 2的buildContract修复方案\\n');
    }

    if (!checks.lowRepetition) {
        console.log('🟡 P2: 减少标题重复');
        console.log('   - 在prompt中要求标题多样化');
        console.log('   - 避免在每页都重复主题名称\\n');
    }

    console.log('执行顺序: P0 -> P1 -> P2 -> 重新生成 -> 验证\\n');

    return { score, level, checks, watermarkCount, pageNumberCount, halfFilledPages };
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('用法: node tools/diagnose-ppt-lazyman.mjs <pptx文件路径>');
    console.log('示例: node tools/diagnose-ppt-lazyman.mjs docs/benchmarks/results/exports/17.pptx');
    process.exit(1);
}

const pptxPath = path.resolve(repoRoot, args[0]);
if (!fs.existsSync(pptxPath)) {
    console.error('文件不存在:', pptxPath);
    process.exit(1);
}

diagnose(pptxPath);
