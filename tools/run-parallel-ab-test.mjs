import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const benchApiBase = process.env.BENCH_API_BASE || 'http://127.0.0.1:3402';

const configs = [
    {
        name: 'ConfigA-空白模板',
        template: 'docs/benchmarks/templates/inbox/blank-clean.pptx',
        enhanced: true,
        enhancedLevel: 1,
        relaxedGate: false,
        count: 5
    },
    {
        name: 'ConfigB-超强prompt',
        template: 'docs/benchmarks/templates/inbox/演示文稿4.pptx',
        enhanced: true,
        enhancedLevel: 3,
        relaxedGate: false,
        count: 5
    },
    {
        name: 'ConfigC-核心检查',
        template: 'docs/benchmarks/templates/inbox/演示文稿4.pptx',
        enhanced: true,
        enhancedLevel: 1,
        relaxedGate: true,
        count: 5
    }
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTemplateExists(templateRelPath) {
    const abs = path.resolve(repoRoot, templateRelPath);
    if (!fs.existsSync(abs)) {
        throw new Error(`模板不存在: ${templateRelPath}`);
    }
    return abs;
}

function calcRelaxedRate(results) {
    if (!results.length) return 0;
    const pass = results.filter((r) => (r.watermarkPages || 0) === 0 && (r.pageNumberPages || 0) === 0).length;
    return pass / results.length;
}

async function runConfig(config, index) {
    console.log(`\n[${index + 1}/3] 测试配置: ${config.name}\n`);

    ensureTemplateExists(config.template);
    const topic = `ABTest${index}_${Date.now()}`;

    const args = [
        'tools/run-variant-batch.mjs',
        `--topic=${topic}`,
        `--count=${config.count}`,
        '--concurrency=1',
        '--enhanced',
        `--template=${config.template}`
    ];

    try {
        execSync(`node ${args.join(' ')}`, {
            cwd: repoRoot,
            stdio: 'inherit',
            timeout: 600000,
            env: {
                ...process.env,
                BENCH_API_BASE: benchApiBase,
                PROMPT_ENHANCED_LEVEL: String(config.enhancedLevel || 1),
                RELAXED_GATE_CORE_ONLY: config.relaxedGate ? 'true' : 'false'
            }
        });

        const output = execSync(
            `node tools/batch-diagnose-variants.mjs ${config.count}`,
            {
                cwd: repoRoot,
                encoding: 'utf8',
                timeout: 120000,
                env: {
                    ...process.env,
                    BENCH_API_BASE: benchApiBase
                }
            }
        );
        console.log(output);

        const resultPath = path.resolve(repoRoot, 'docs/benchmarks/training/batch_diagnosis_results.json');
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const diagnosed = result.results || [];

        const lazymanRate = config.relaxedGate ? calcRelaxedRate(diagnosed) : (result.lazymanRate || 0);
        const avgScore = result.avgScore || 0;

        return {
            config: config.name,
            template: config.template,
            enhancedLevel: config.enhancedLevel,
            relaxedGate: config.relaxedGate,
            lazymanRate,
            avgScore,
            watermarkIssues: diagnosed.filter((r) => (r.watermarkPages || 0) > 0).length,
            pageNumberIssues: diagnosed.filter((r) => (r.pageNumberPages || 0) > 0).length,
            sampleCount: diagnosed.length
        };
    } catch (err) {
        console.error(`配置 ${config.name} 失败: ${err.message}`);
        return null;
    }
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║         并行A/B测试（第一性原理）                      ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    console.log(`API: ${benchApiBase}\n`);

    const results = [];

    for (let i = 0; i < configs.length; i += 1) {
        const result = await runConfig(configs[i], i);
        if (result) results.push(result);
        await sleep(3000);
    }

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║              A/B测试结果对比                           ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    results.forEach((r) => {
        console.log(`${r.config}:`);
        console.log(`  LazyMan率: ${(r.lazymanRate * 100).toFixed(1)}%`);
        console.log(`  平均分数: ${r.avgScore.toFixed(1)}`);
        console.log(`  水印问题: ${r.watermarkIssues}个`);
        console.log(`  页码问题: ${r.pageNumberIssues}个\n`);
    });

    if (!results.length) {
        throw new Error('A/B测试无可用结果');
    }

    const best = [...results].sort((a, b) => b.lazymanRate - a.lazymanRate)[0];
    console.log(`🏆 最优配置: ${best.config} (${(best.lazymanRate * 100).toFixed(1)}%)\n`);

    const outputPath = path.resolve(repoRoot, 'docs/benchmarks/training/ab_test_results.json');
    fs.writeFileSync(
        outputPath,
        JSON.stringify({
            timestamp: new Date().toISOString(),
            benchApiBase,
            best,
            results
        }, null, 2),
        'utf8'
    );
    console.log(`✅ 已保存: ${path.relative(repoRoot, outputPath).replace(/\\/g, '/')}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
