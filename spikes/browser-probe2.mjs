import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter((p) => existsSync(p));
console.log('found:', candidates);
const executablePath = candidates[0];
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const resp = await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log('status:', resp?.status(), 'url:', page.url());
  console.log('title:', JSON.stringify(await page.title()));
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch((e) => `BODY_ERR: ${e.message.split('\n')[0]}`);
  console.log('body:', JSON.stringify(String(bodyText).slice(0, 200)));
  const html = await page.content().catch(() => 'HTML_ERR');
  console.log('html head:', String(html).slice(0, 300).replace(/\s+/g, ' '));
} finally { await browser.close(); }
