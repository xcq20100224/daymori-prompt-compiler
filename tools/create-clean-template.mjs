import { execSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const forbiddenPatterns = [
    /内容由AI生成/g,
    /由AI生成/g,
    /OfficePLUS/g,
    /LOGO/g,
    /CONTENT/g,
    /请在此输入/g,
    /输入标题/g,
    /20XX/g,
    /202X/g,
    /\d+\/\d+/g,
    /placeholder/gi,
    /示例|样例|范例/g,
    /此处添加|在此输入/g,
    /默认|default/gi,
    /模板|template/gi,
    /THANK\s*YOU/gi,
    /Lorem ipsum[^<]*/gi,
    /添加标题|Add title/gi,
    /单击此处|Click here/gi,
    /编辑文本|Edit text/gi,
    /副标题|Subtitle/gi,
    /页脚|Footer/gi,
    /\d{4}年\d{1,2}月\d{1,2}日/g,
    /汇报人|Presenter/gi
];

const exampleSlidePatterns = /目录|阶段工作|项目成果|感谢聆听|示例|样例/i;

function stripTextNodes(xml) {
    return xml.replace(/<a:t>[^<]*<\/a:t>/g, '<a:t></a:t>');
}

function stripAllText(xml) {
    return xml.replace(/<a:t>[^<]*<\/a:t>/g, '<a:t></a:t>');
}

function writeZipFromEntries(entriesMap, outputPath) {
    const zip = new AdmZip();
    for (const [entryName, content] of entriesMap.entries()) {
        zip.addFile(entryName, Buffer.from(content));
    }
    zip.writeZip(outputPath);
}

function cleanTemplate(sourceTemplatePath, outputPath) {
    console.log(`清理模板: ${path.basename(sourceTemplatePath)}\n`);

    const zip = new AdmZip(sourceTemplatePath);
    const entries = new Map();
    let cleanedCount = 0;
    let removedSlides = 0;

    for (const entry of zip.getEntries()) {
        const entryName = entry.entryName;
        const isXml = /\.xml$/i.test(entryName);
        const raw = entry.getData();

        if (!isXml) {
            entries.set(entryName, raw);
            continue;
        }

        let content = raw.toString('utf8');
        let modified = false;

        for (const pattern of forbiddenPatterns) {
            const next = content.replace(pattern, '');
            if (next !== content) {
                content = next;
                modified = true;
            }
        }

        if (/^ppt\/slides\/slide\d+\.xml$/i.test(entryName) && exampleSlidePatterns.test(content)) {
            removedSlides += 1;
            continue;
        }

        if (/^ppt\/slides\/slide\d+\.xml$/i.test(entryName)) {
            const next = stripAllText(content);
            if (next !== content) {
                content = next;
                modified = true;
            }
        }

        if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(entryName)) {
            const next = stripAllText(content);
            if (next !== content) {
                content = next;
                modified = true;
            }
        }

        if (modified) cleanedCount += 1;
        entries.set(entryName, Buffer.from(content, 'utf8'));
    }

    writeZipFromEntries(entries, outputPath);

    console.log('✅ 清理完成:');
    console.log(`   - 修改 ${cleanedCount} 个文件`);
    console.log(`   - 移除 ${removedSlides} 个示例页`);
    console.log(`   - 输出: ${path.basename(outputPath)}\n`);
}

function createBlankTemplate(sourceTemplatePath, outputPath) {
    const zip = new AdmZip(sourceTemplatePath);
    const entries = new Map();

    for (const entry of zip.getEntries()) {
        const entryName = entry.entryName;
        const raw = entry.getData();

        if (!/\.xml$/i.test(entryName)) {
            entries.set(entryName, raw);
            continue;
        }

        let content = raw.toString('utf8');

        for (const pattern of forbiddenPatterns) {
            content = content.replace(pattern, '');
        }

        if (/^ppt\/slides\/slide\d+\.xml$/i.test(entryName)) {
            content = stripTextNodes(content);
        }

        entries.set(entryName, Buffer.from(content, 'utf8'));
    }

    writeZipFromEntries(entries, outputPath);
    console.log(`✅ 空白模板输出: ${path.basename(outputPath)}\n`);
}

function main() {
    const sourceTemplate = path.resolve(repoRoot, 'docs/benchmarks/templates/inbox/演示文稿4.pptx');
    const cleanTemplatePath = path.resolve(repoRoot, 'docs/benchmarks/templates/inbox/clean-lazyman.pptx');
    const blankTemplatePath = path.resolve(repoRoot, 'docs/benchmarks/templates/inbox/blank-clean.pptx');

    if (!fs.existsSync(sourceTemplate)) {
        console.error(`源模板不存在: ${sourceTemplate}`);
        process.exit(1);
    }

    cleanTemplate(sourceTemplate, cleanTemplatePath);
    createBlankTemplate(sourceTemplate, blankTemplatePath);

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║              验证清理效果                              ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    try {
        execSync(`node tools/diagnose-ppt-lazyman.mjs "${cleanTemplatePath}"`, {
            cwd: repoRoot,
            stdio: 'inherit'
        });
    } catch {
        console.log('提示: clean-lazyman.pptx 为模板文件，诊断报错可忽略。\n');
    }
}

main();
