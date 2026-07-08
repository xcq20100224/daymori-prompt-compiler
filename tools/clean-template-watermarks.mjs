import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

const watermarkPatterns = [
    /内容由AI生成/g,
    /由AI生成/g,
    /AI生成/g,
    /请在此输入您的文字内容/g,
    /请您单击此处输入文本/g,
    /输入标题/g,
    /LOGO/g,
    /CONTENT/g,
    /OfficePLUS/g,
    /或者到此处，/g,
    /输入您的内容/g,
    /20XX/g,
    /时间：202X/g
];

function cleanTemplate(templatePath) {
    console.log(`清理模板: ${templatePath}\\n`);

    const zip = new AdmZip(templatePath);
    let cleaned = 0;

    for (const entry of zip.getEntries()) {
        if (!/\.xml$/i.test(entry.entryName)) continue;

        let content = entry.getData().toString('utf8');
        let modified = false;

        for (const pattern of watermarkPatterns) {
            if (pattern.test(content)) {
                content = content.replace(pattern, '');
                modified = true;
            }
        }

        if (modified) {
            zip.updateFile(entry, Buffer.from(content, 'utf8'));
            cleaned += 1;
        }
    }

    if (cleaned > 0) {
        const backup = `${templatePath}.watermark-backup`;
        if (!fs.existsSync(backup)) {
            fs.copyFileSync(templatePath, backup);
            console.log(`✅ 已备份原文件: ${path.basename(backup)}`);
        } else {
            console.log(`ℹ️  已存在备份: ${path.basename(backup)}`);
        }

        zip.writeZip(templatePath);
        console.log(`✅ 已清理 ${cleaned} 个文件中的水印`);
        console.log(`✅ 已更新: ${path.basename(templatePath)}\\n`);
    } else {
        console.log('ℹ️  未发现水印，无需清理\\n');
    }
}

const templatesDir = path.resolve(repoRoot, 'docs/benchmarks/templates/inbox');

if (!fs.existsSync(templatesDir)) {
    console.error('模板目录不存在:', templatesDir);
    process.exit(1);
}

const templates = fs.readdirSync(templatesDir)
    .filter((f) => f.endsWith('.pptx'))
    .map((f) => path.join(templatesDir, f));

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║           模板水印清理工具                             ║');
console.log('╚════════════════════════════════════════════════════════╝\\n');

console.log(`发现 ${templates.length} 个模板文件:\\n`);
for (const t of templates) {
    console.log(`  - ${path.basename(t)}`);
}
console.log('');

for (const t of templates) {
    cleanTemplate(t);
}

console.log('╔════════════════════════════════════════════════════════╗');
console.log('║              清理完成                                  ║');
console.log('╚════════════════════════════════════════════════════════╝\\n');
console.log('建议：重新生成PPT并验证水印是否消失\\n');
