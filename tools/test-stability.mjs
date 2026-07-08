import { spawn } from 'node:child_process';
import path from 'node:path';

const repoRoot = process.cwd();
const testTopics = [
  '用户增长策略',
  '区块链技术架构',
  '咖啡店选址方案'
];

console.log('===稳定性测试: 3个主题各生成1次===\n');

async function runOne(topic) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = 120000;
    const child = spawn(process.execPath, [
      path.resolve(repoRoot, 'tools/run-variant-batch.mjs'),
      `--topic=${topic}`,
      '--count=1',
      '--concurrency=1'
    ], { cwd: repoRoot, stdio: 'pipe' });

    let output = '';
    child.stdout.on('data', (d) => {
      output += String(d);
    });
    child.stderr.on('data', (d) => {
      output += String(d);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill errors and resolve as timeout.
      }
      const duration = `${((Date.now() - start) / 1000).toFixed(1)}s`;
      resolve({
        topic,
        ok: false,
        score: 0,
        duration,
        error: 'timeout'
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = `${((Date.now() - start) / 1000).toFixed(1)}s`;

      try {
        const trimmed = output.trim();
        const jsonStart = trimmed.lastIndexOf('{');
        const parsed = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
        const result = JSON.parse(parsed);
        resolve({
          topic,
          ok: code === 0 && (result.summary?.success || 0) > 0,
          score: result.summary?.best?.autoScore || 0,
          duration,
          error: result.summary?.best?.error || null
        });
      } catch {
        resolve({
          topic,
          ok: false,
          score: 0,
          duration,
          error: 'parse_failed'
        });
      }
    });
  });
}

const results = [];
for (const topic of testTopics) {
  console.log(`测试: ${topic}...`);
  const result = await runOne(topic);
  results.push(result);
  console.log(`  -> ${result.ok ? 'OK' : 'FAIL'} score=${result.score} ${result.duration}\n`);
}

console.log('\n=== 稳定性测试结果 ===');
console.table(results);

const successRate = ((results.filter((r) => r.ok).length / results.length) * 100).toFixed(0);
console.log(`\n成功率: ${successRate}%`);

if (Number(successRate) < 80) {
  console.log('稳定性不足，需要修复API或重试逻辑');
} else if (results.every((r) => r.score === results[0].score)) {
  console.log('所有主题得分相同，可能是topic参数未生效');
} else {
  console.log('稳定性测试通过');
}
