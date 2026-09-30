/**
 * Spike：playwright-core 无头驱动本机 Chrome/Edge。
 * 验证：① 浏览器自动发现；② headless 启动（零可见窗口）；③ 页面读取。
 * 只访问 example.com，只读操作。
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const candidates = [
  process.env['CONTROL_X_BROWSER_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error(JSON.stringify({ ok: false, error: 'no chrome/edge found', candidates }));
  process.exit(1);
}

const started = Date.now();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const title = await page.title();
  const h1 = await page.locator('h1').textContent();
  const ariaSnapshotSupported = typeof page.locator('body').ariaSnapshot === 'function';
  console.log(JSON.stringify({
    ok: true,
    executablePath,
    headless: true,
    title,
    h1: h1?.trim(),
    ariaSnapshotSupported,
    elapsedMs: Date.now() - started,
    browserVersion: browser.version(),
  }, null, 2));
} finally {
  await browser.close();
}
