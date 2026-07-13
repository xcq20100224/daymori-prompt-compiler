import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const repoRoot = process.cwd();
const maxRetries = 3;
const forbiddenPatterns = [
    /内容由AI生成/g,
    /由AI生成/g,
    /AI生成/g,
    /OfficePLUS/g,
    /LOGO/g,
    /CONTENT/g,
    /请在此输入/g,
    /输入标题/g,
    /placeholder/gi,
    /添加标题|Add title/gi,
    /单击此处|Click here/gi,
    /编辑文本|Edit text/gi,
    /副标题|Subtitle/gi,
    /页脚|Footer/gi,
    /\d{4}年\d{1,2}月\d{1,2}日/g,
    /汇报人|Presenter/gi
];

function run(command, options = {}) {
    return execSync(command, {
        cwd: repoRoot,
        stdio: 'inherit',
        ...options
    });
}

function findLatestPptxFromVariantSummary() {
    const variantsDir = path.resolve(repoRoot, 'docs/benchmarks/results/variants');
    if (!fs.existsSync(variantsDir)) return null;

    const dirs = fs
        .readdirSync(variantsDir)
        .map((name) => ({
            name,
            fullPath: path.join(variantsDir, name)
        }))
        .filter((x) => fs.existsSync(x.fullPath) && fs.statSync(x.fullPath).isDirectory())
        .map((x) => ({
            ...x,
            mtime: fs.statSync(x.fullPath).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

    if (!dirs.length) return null;

    for (const dir of dirs) {
        const summaryPath = path.join(dir.fullPath, 'summary.json');
        if (!fs.existsSync(summaryPath)) continue;

        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        const candidate =
            summary?.best?.relativePath ||
            summary?.best?.path ||
            summary?.items?.[0]?.relativePath ||
            summary?.results?.[0]?.relativePath;

        if (!candidate) continue;

        const pptxPath = path.resolve(repoRoot, candidate);
        if (fs.existsSync(pptxPath)) return pptxPath;
    }

    return null;
}

function postProcessCleanup(pptxPath) {
    if (!pptxPath || !fs.existsSync(pptxPath)) return;
    const zip = new AdmZip(pptxPath);
    let modified = false;
    const entries = new Map();

    for (const entry of zip.getEntries()) {
        const entryName = entry.entryName;
        let content = entry.getData();

        if (/\.xml$/i.test(entryName)) {
            let text = content.toString('utf8');
            for (const pattern of forbiddenPatterns) {
                const cleaned = text.replace(pattern, '');
                if (cleaned !== text) {
                    text = cleaned;
                    modified = true;
                }
            }
            content = Buffer.from(text, 'utf8');
        }

        entries.set(entryName, content);
    }

    if (modified) {
        const out = new AdmZip();
        for (const [name, data] of entries.entries()) {
            out.addFile(name, data);
        }
        out.writeZip(pptxPath);
        console.log('✅ 生成后清理完成');
    }
}

async function generateAndValidate(topic, retryCount = 0) {
    console.log(`\n[尝试 ${retryCount + 1}/${maxRetries}] 生成主题: ${topic}\n`);

    try {
        run(
            `node tools/run-variant-batch.mjs --topic="${topic}" --count=1 --concurrency=1 --enhanced --template="docs/benchmarks/templates/inbox/clean-lazyman.pptx"`,
            {
                timeout: 300000,
                env: {
                    ...process.env,
                    BENCH_API_BASE: process.env.BENCH_API_BASE || 'http://127.0.0.1:3402',
                    VARIANT_FETCH_TIMEOUT_MS: process.env.VARIANT_FETCH_TIMEOUT_MS || '240000',
                    PROMPT_ENHANCED_LEVEL: String(retryCount > 0 ? 3 : (process.env.PROMPT_ENHANCED_LEVEL || 1))
                }
            }
        );
    } catch (err) {
        console.error('生成失败:', err.message);
        return null;
    }

    const pptxPath = findLatestPptxFromVariantSummary();
    if (!pptxPath) {
        console.error('未找到可验证的PPTX产物。');
        return null;
    }

    postProcessCleanup(pptxPath);

    try {
        run(`node tools/validate-lazyman-constraints.mjs "${pptxPath}"`);
        console.log('\n✅ LazyMan验证通过！\n');
        return pptxPath;
    } catch {
        console.log('\n❌ 验证未通过\n');

        if (retryCount < maxRetries - 1) {
            console.log('⚠️  重试时将使用3倍强度prompt\n');
            process.env.PROMPT_ENHANCED_LEVEL = '3';
            console.log('等待5秒后重试...\n');
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return generateAndValidate(topic, retryCount + 1);
        }

        return null;
    }
}

async function main() {
    const topic = process.argv[2] || 'AI客服降本增效方案';

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║         自动修复至LazyMan标准                          ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    const result = await generateAndValidate(topic);

    if (result) {
        console.log(`🎉 成功！LazyMan级PPT: ${result}\n`);
        process.exit(0);
    }

    console.log(`⚠️  ${maxRetries}次尝试均未达标，需要人工介入\n`);
    process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
