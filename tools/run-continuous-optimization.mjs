import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const benchApiBase = process.env.BENCH_API_BASE || 'http://127.0.0.1:3402';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function optimize() {
    let round = 0;

    while (true) {
        round += 1;
        console.log(`\n[循环 ${round}] 开始新一轮优化...\n`);

        execSync(
            'node tools/run-variant-batch.mjs --topic="持续优化测试" --count=20 --concurrency=2 --enhanced --fetchTimeoutMs=240000 --maxRetries=3',
            {
                cwd: repoRoot,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    BENCH_API_BASE: benchApiBase,
                    VARIANT_FETCH_TIMEOUT_MS: '240000',
                    VARIANT_MAX_RETRIES: '3'
                }
            }
        );

        execSync('node tools/batch-diagnose-variants.mjs 20', {
            cwd: repoRoot,
            stdio: 'inherit',
            env: {
                ...process.env,
                BENCH_API_BASE: benchApiBase
            }
        });

        const resultPath = path.resolve(repoRoot, 'docs/benchmarks/training/batch_diagnosis_results.json');
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const rate = result.lazymanRate || 0;

        console.log(`\n当前达标率: ${(rate * 100).toFixed(1)}%`);

        if (rate >= 0.7) {
            console.log('\n🎉 达到目标！停止优化\n');
            break;
        }

        await sleep(10000);
    }
}

optimize().catch((err) => {
    console.error(err);
    process.exit(1);
});
