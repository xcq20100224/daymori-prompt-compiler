import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const config = {
    totalSamples: parseInt(process.argv[2], 10) || 100,
    batchSize: 10,
    targetTop: 5,
    concurrency: 2,
    topics: [
        'AI客服降本增效方案',
        '企业数字化转型',
        '产品市场策略',
        '用户增长运营',
        '供应链优化'
    ]
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateBatch(batchIndex, topic) {
    console.log(`\n[Batch ${batchIndex}] 生成 ${config.batchSize} 个样本...`);

    try {
        execSync(
            `node tools/run-variant-batch.mjs --topic="${topic}" --count=${config.batchSize} --concurrency=${config.concurrency} --enhanced --fetchTimeoutMs=240000 --maxRetries=3`,
            {
                cwd: repoRoot,
                stdio: 'inherit',
                timeout: 600000,
                env: {
                    ...process.env,
                    BENCH_API_BASE: process.env.BENCH_API_BASE || 'http://127.0.0.1:3402',
                    VARIANT_FETCH_TIMEOUT_MS: '240000',
                    VARIANT_MAX_RETRIES: '3'
                }
            }
        );
        return true;
    } catch (err) {
        console.error(`Batch ${batchIndex} 失败: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║         海量生成筛选（SpaceX方法）                     ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log(`目标: 生成 ${config.totalSamples} 个样本，筛选 top ${config.targetTop}\n`);

    const batches = Math.ceil(config.totalSamples / config.batchSize);
    let successCount = 0;

    for (let i = 0; i < batches; i += 1) {
        const topic = config.topics[i % config.topics.length];
        const success = await generateBatch(i + 1, topic);
        if (success) successCount += 1;

        if ((i + 1) % 5 === 0) {
            const diagnosedCount = Math.min((i + 1) * config.batchSize, config.totalSamples);
            console.log(`\n[中间诊断] 已生成约 ${diagnosedCount} 个样本\n`);
            try {
                execSync(`node tools/batch-diagnose-variants.mjs ${diagnosedCount}`, {
                    cwd: repoRoot,
                    stdio: 'inherit'
                });
            } catch {
                console.log('中间诊断跳过\n');
            }
        }

        await sleep(2000);
    }

    console.log(`\n✅ 完成 ${successCount}/${batches} 批生成\n`);

    console.log('执行最终诊断...\n');
    execSync(
        `node tools/batch-diagnose-variants.mjs ${config.totalSamples}`,
        { cwd: repoRoot, stdio: 'inherit' }
    );

    const resultPath = path.resolve(repoRoot, 'docs/benchmarks/training/batch_diagnosis_results.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    const allResults = result.results || [];
    const topSamples = allResults
        .filter((r) => (r.score || 0) >= 95)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, config.targetTop);

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║              Top 5 LazyMan样本                         ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    if (!topSamples.length) {
        console.log('暂无 >=95 分样本\n');
    } else {
        topSamples.forEach((s, i) => {
            console.log(`${i + 1}. ${s.variantDir}`);
            console.log(`   分数: ${s.score} | 路径: ${s.pptxPath}\n`);
        });
    }

    const sampleCount = result.sampleCount || allResults.length || 1;
    const rate = allResults.filter((r) => (r.score || 0) >= 95).length / sampleCount;
    console.log(`最终LazyMan达标率: ${(rate * 100).toFixed(1)}%\n`);

    const outputPath = path.resolve(repoRoot, 'docs/benchmarks/training/massive_generation_results.json');
    fs.writeFileSync(
        outputPath,
        JSON.stringify({
            timestamp: new Date().toISOString(),
            config,
            successBatches: successCount,
            sampleCount,
            lazymanRate: rate,
            topSamples
        }, null, 2),
        'utf8'
    );
    console.log(`✅ 已保存: ${path.relative(repoRoot, outputPath).replace(/\\/g, '/')}`);

    if (rate < 0.3) {
        console.log('⚠️  达标率 <30%，建议执行方案3（系统重构）\n');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
