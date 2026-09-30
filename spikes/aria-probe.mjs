import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded' });
const snap = await page.locator('body').ariaSnapshot();
const lines = snap.split('\n').filter(l => /textbox|searchbox|编辑|输入/.test(l));
console.log('snapshot textbox lines:'); for (const l of lines) console.log('  ' + JSON.stringify(l));
const counts = await page.evaluate(() => {
  const els = [...document.querySelectorAll('input,textarea,[role=textbox],[role=searchbox]')];
  return els.slice(0, 6).map(el => ({
    tag: el.tagName, id: el.id, name: el.getAttribute('name'),
    ariaLabel: el.getAttribute('aria-label'), placeholder: el.getAttribute('placeholder'), title: el.getAttribute('title'),
    role: el.getAttribute('role'),
  }));
});
console.log('input elements:'); for (const c of counts) console.log('  ' + JSON.stringify(c));
for (const [label, loc] of [
  ["getByRole('textbox')", page.getByRole('textbox')],
  ["getByRole('textbox',{name:'输入搜索词'})", page.getByRole('textbox', { name: '输入搜索词' })],
  ["getByRole('textbox',{name:'输入搜索词',exact:true})", page.getByRole('textbox', { name: '输入搜索词', exact: true })],
  ["getByRole('searchbox',{name:'输入搜索词'})", page.getByRole('searchbox', { name: '输入搜索词' })],
]) {
  try { console.log(label, '→ count', await loc.count()); } catch (e) { console.log(label, '→ ERR', e.message.split('\n')[0]); }
}
await browser.close();
