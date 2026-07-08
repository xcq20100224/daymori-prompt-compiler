import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

const config = {
    topic: process.argv[2] || 'AI客服降本增效方案',
    apiBase: process.env.BENCH_API_BASE || 'http://localhost:3402'
};

function run(cmd, desc) {
    console.log(`\\n[执行] ${desc}`);
    execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

function latestVariantDir() {
    const variantsRoot = path.resolve(repoRoot, 'docs/benchmarks/results/variants');
    const dirs = fs.readdirSync(variantsRoot)
        .map((name) => ({
            name,
            abs: path.join(variantsRoot, name),
            mtimeMs: fs.statSync(path.join(variantsRoot, name)).mtimeMs
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return dirs[0] || null;
}

function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║         LazyMan级PPT生成器                             ║');
    console.log('╚════════════════════════════════════════════════════════╝\\n');

    console.log(`主题: ${config.topic}`);
    console.log(`API: ${config.apiBase}\\n`);

    run('node tools/clean-template-watermarks.mjs', '清理模板水印');

    const cmd = `node tools/run-variant-batch.mjs --topic="${config.topic}" --count=3 --concurrency=1 --top=1 --enhanced --template="docs/benchmarks/templates/inbox/ppt-picked-in-powerpoint.pptx"`;
    run(cmd, '生成PPT（增强规则）');

    const latest = latestVariantDir();
    if (!latest) {
        throw new Error('未找到生成目录');
    }

    const summaryPath = path.join(latest.abs, 'summary.json');
    console.log(`\\n最新summary: ${path.relative(repoRoot, summaryPath)}`);

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const bestRel = summary?.best?.relativePath;
    if (!bestRel) {
        throw new Error('生成成功但未找到best.relativePath');
    }

    console.log(`最新PPT: ${bestRel}`);
    run(`node tools/diagnose-ppt-lazyman.mjs "${bestRel}"`, '诊断新PPT');

    console.log('\\n✅ 生成完成！');
}

main();
