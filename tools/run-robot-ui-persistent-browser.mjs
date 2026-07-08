#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const robotUrl = getArg('--url', 'http://192.168.8.5/');
const userDataDir = getArg('--profile-dir', path.resolve('tools', '.robot-ui-profile'));
const patchPath = path.resolve('tools', 'userscripts', 'robot-ui-patch.user.js');

if (!fs.existsSync(patchPath)) {
  console.error('[robot-ui-persistent] patch script not found:', patchPath);
  process.exit(1);
}

const patchScript = fs.readFileSync(patchPath, 'utf8');

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: null,
  ignoreHTTPSErrors: true,
  args: ['--start-maximized']
});

await context.addInitScript({ content: patchScript });

const pages = context.pages();
const page = pages.length ? pages[0] : await context.newPage();
await page.goto(robotUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

console.log('[robot-ui-persistent] Browser started.');
console.log('[robot-ui-persistent] URL:', robotUrl);
console.log('[robot-ui-persistent] Patch auto-injects on every refresh/navigation.');
console.log('[robot-ui-persistent] Keep this terminal running while using the browser.');

context.on('close', () => {
  process.exit(0);
});

await new Promise(() => {});
