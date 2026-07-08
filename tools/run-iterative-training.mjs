import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const config = {
    iterations: parseInt(process.argv[2], 10) || 5,
    samplesPerIteration: 10,
    targetScore: 95,
    targetRate: 0.7
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIteration(iter) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log(`║        Iteration ${iter}/${config.iterations}                               ║`);
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log(`[${iter}.1] 生成 ${config.samplesPerIteration} 个样本...\n`);

    const topics = [
        'AI客服降本增效方案',
        '企业数字化转型路线图',
        '产品上市策略分析',
        '用户增长运营方案',
        '供应链优化实施计划'
    ];

    const topic = topics[iter % topics.length];

    try {
        execSync(
            `node tools/run-variant-batch.mjs --topic="${topic}" --count=${config.samplesPerIteration} --concurrency=1 --enhanced --fetchTimeoutMs=240000 --maxRetries=3`,
            {
                cwd: repoRoot,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    BENCH_API_BASE: process.env.BENCH_API_BASE || 'http://127.0.0.1:3402',
                    VARIANT_FETCH_TIMEOUT_MS: process.env.VARIANT_FETCH_TIMEOUT_MS || '240000',
                    VARIANT_MAX_RETRIES: process.env.VARIANT_MAX_RETRIES || '3'
                }
            }
        );
    } catch (err) {
        console.error(`生成失败: ${err.message}`);
        return null;
    }

    await sleep(5000);

    console.log(`\n[${iter}.2] 诊断新生成的样本...\n`);
    let diagResult;
    try {
        const output = execSync(
            `node tools/batch-diagnose-variants.mjs ${config.samplesPerIteration}`,
            { cwd: repoRoot, encoding: 'utf8' }
        );
        console.log(output);

        const resultPath = path.resolve(repoRoot, 'docs/benchmarks/training/batch_diagnosis_results.json');
        diagResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch (err) {
        console.error(`诊断失败: ${err.message}`);
        return null;
    }

    console.log(`\n[${iter}.3] 分析模式并更新规则...\n`);

    const lazymanRate = diagResult.lazymanRate || 0;
    const avgScore = diagResult.avgScore || 0;

    console.log(`当前Iteration ${iter} 成绩:`);
    console.log(`  LazyMan达标率: ${(lazymanRate * 100).toFixed(1)}%`);
    console.log(`  平均分数: ${avgScore.toFixed(1)}/100\n`);

    const failures = (diagResult.results || []).filter((r) => r.score < config.targetScore);
    const commonIssues = {
        watermark: failures.filter((r) => r.watermarkPages > 0).length,
        pageNumber: failures.filter((r) => r.pageNumberPages > 0).length,
        halfFilled: failures.filter((r) => r.totalPages > 0 && (r.halfFilledPages / r.totalPages) > 0.15).length
    };

    console.log('失败模式统计:');
    console.log(`  水印问题: ${commonIssues.watermark}个样本`);
    console.log(`  页码问题: ${commonIssues.pageNumber}个样本`);
    console.log(`  内容密度: ${commonIssues.halfFilled}个样本\n`);

    return {
        iteration: iter,
        lazymanRate,
        avgScore,
        commonIssues,
        shouldContinue: lazymanRate < config.targetRate
    };
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║         迭代训练优化器                                 ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('配置:');
    console.log(`  迭代次数: ${config.iterations}`);
    console.log(`  每轮样本数: ${config.samplesPerIteration}`);
    console.log(`  目标达标率: ${(config.targetRate * 100).toFixed(0)}%\n`);

    const history = [];

    for (let i = 1; i <= config.iterations; i += 1) {
        const result = await runIteration(i);
        if (!result) {
            console.error(`Iteration ${i} 失败，终止训练`);
            break;
        }

        history.push(result);

        if (!result.shouldContinue) {
            console.log(`\n达到目标。LazyMan率: ${(result.lazymanRate * 100).toFixed(1)}%`);
            break;
        }

        if (i < config.iterations) {
            console.log('\n等待5秒后开始下一轮...\n');
            await sleep(5000);
        }
    }

    const historyPath = path.resolve(repoRoot, 'docs/benchmarks/training/iterative_training_history.json');
    fs.writeFileSync(historyPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        config,
        history
    }, null, 2), 'utf8');

    console.log(`\n✅ 训练历史已保存: ${path.relative(repoRoot, historyPath).replace(/\\/g, '/')}\n`);

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║              训练总结                                  ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    history.forEach((h) => {
        console.log(`Iteration ${h.iteration}: ${(h.lazymanRate * 100).toFixed(1)}% (平均${h.avgScore.toFixed(1)}分)`);
    });

    const finalRate = history[history.length - 1]?.lazymanRate || 0;
    console.log(`\n最终LazyMan达标率: ${(finalRate * 100).toFixed(1)}%`);

    if (finalRate >= config.targetRate) {
        console.log(`\n已达到目标(${(config.targetRate * 100).toFixed(0)}%)`);
    } else {
        console.log('\n未达标，建议继续迭代或调整prompt');
    }
}

main().catch(console.error);
