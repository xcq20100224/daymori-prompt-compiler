import { chromium } from 'playwright';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, textCandidates) {
  for (const text of textCandidates) {
    const locator = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`);
    const count = await locator.count();
    if (count > 0) {
      const target = locator.first();
      await target.click({ timeout: 2000 });
      return true;
    }
  }
  return false;
}

async function getStopBox(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    const stopEl = all.find((el) => {
      const t = (el.textContent || '').trim();
      return t.includes('停止') || t.toLowerCase().includes('stop');
    });
    if (!stopEl) return null;
    const r = stopEl.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

async function clickDirection(page, direction) {
  const stopBox = await getStopBox(page);
  if (!stopBox) {
    throw new Error('Cannot locate stop button.');
  }

  const cx = stopBox.x + stopBox.width / 2;
  const cy = stopBox.y + stopBox.height / 2;
  const dx = stopBox.width * 1.05;
  const dy = stopBox.height * 1.05;

  const points = {
    forward: { x: cx, y: cy - dy },
    backward: { x: cx, y: cy + dy },
    left: { x: cx - dx, y: cy },
    right: { x: cx + dx, y: cy },
  };

  const p = points[direction];
  if (!p) throw new Error(`Unknown direction: ${direction}`);

  await page.mouse.click(p.x, p.y);
}

async function pressDirection(page, direction, holdMs) {
  const stopBox = await getStopBox(page);
  if (!stopBox) {
    throw new Error('Cannot locate stop button.');
  }

  const cx = stopBox.x + stopBox.width / 2;
  const cy = stopBox.y + stopBox.height / 2;
  const dx = stopBox.width * 1.05;
  const dy = stopBox.height * 1.05;

  const points = {
    forward: { x: cx, y: cy - dy },
    backward: { x: cx, y: cy + dy },
    left: { x: cx - dx, y: cy },
    right: { x: cx + dx, y: cy },
  };

  const p = points[direction];
  if (!p) throw new Error(`Unknown direction: ${direction}`);

  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}

async function run() {
  const action = process.argv[2] || 'stop';
  const target = process.argv[3] || 'http://192.168.4.1:8080';
  const holdMs = Number(process.argv[4] || 600);
  const headlessRaw = String(process.argv[5] || 'false').toLowerCase();
  const headless = headlessRaw === '1' || headlessRaw === 'true' || headlessRaw === 'yes';

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.setDefaultTimeout(12000);
  await page.goto(target, { waitUntil: 'commit', timeout: 7000 });
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 });
  } catch {
    // Some embedded robot pages never fire DOMContentLoaded; continue with partial document.
  }
  await sleep(900);

  try {
    if (action === 'grab') {
      const ok = await clickByText(page, ['抓取', 'Grip', 'Grab']);
      if (!ok) throw new Error('Grab button not found.');
    } else if (action === 'release') {
      const ok = await clickByText(page, ['释放', 'Release']);
      if (!ok) throw new Error('Release button not found.');
    } else if (action === 'stop') {
      const ok = await clickByText(page, ['停止', 'stop', 'Stop']);
      if (!ok) throw new Error('Stop button not found.');
    } else if (action === 'forward' || action === 'backward' || action === 'left' || action === 'right') {
      await clickDirection(page, action);
    } else if (action === 'forward-hold' || action === 'backward-hold' || action === 'left-hold' || action === 'right-hold') {
      const direction = action.replace('-hold', '');
      await pressDirection(page, direction, holdMs);
      await clickByText(page, ['停止', 'stop', 'Stop']);
    } else {
      throw new Error('Unsupported action. Use: forward, backward, left, right, grab, release, stop, forward-hold, backward-hold, left-hold, right-hold');
    }

    console.log(`[OK] action=${action} target=${target}`);
  } finally {
    await sleep(400);
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`[FAILED] ${err.message}`);
  process.exit(1);
});
