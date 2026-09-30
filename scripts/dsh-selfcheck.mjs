#!/usr/bin/env node
/**
 * dsh-control-x 本机自检：一条命令确认 Node 侧与面板能力是否正常。
 *
 * 用法（在 DSH 运行时执行）：
 *   node scripts/dsh-selfcheck.mjs
 *
 * 检查项：
 *   1. 已安装的包版本与 exports 是否符合客户端 bundle 装配要求
 *   2. client.js 的 module.exports.inject 是否只含基础服务（否则 boot 会卡死）
 *   3. 宿主 webServer 上的 /api/x-control/* 路由是否已注册
 *   4. 浏览器 userDataDir 与 CDP screencast 能力（面板画面的前提）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

const PROFILE = 'D:/Users/sun_w/.dsh/profiles/desktop';
const PKG = join(PROFILE, 'node_modules/dsh-control-x/package.json');

let failures = 0;
const ok = (m) => console.log('  ✔ ' + m);
const bad = (m) => { failures++; console.log('  ✘ ' + m); };

console.log('=== 1. 安装状态 ===');
if (!existsSync(PKG)) {
  bad('未安装：' + PKG + '（请先在市场安装）');
} else {
  const j = JSON.parse(readFileSync(PKG, 'utf8'));
  ok('版本 ' + j.version);
  // client-modules 的 locatePkgJson 依赖 exports["./package.json"]，缺失会导致整包不被识别为 client package
  j.exports?.['./package.json'] ? ok('exports 含 ./package.json') : bad('exports 缺 ./package.json（客户端 bundle 不会被装配）');
  j.exports?.['./client'] ? ok('exports 含 ./client') : bad('exports 缺 ./client');
  j.dsh?.client?.platform === 'web' ? ok('dsh.client.platform=web') : bad('dsh.client.platform 不是 web');
}

console.log('=== 2. client.js inject（boot 崩溃的头号原因）===');
const CLIENT = join(PROFILE, 'node_modules/dsh-control-x/lib/client.js');
if (existsSync(CLIENT)) {
  const c = readFileSync(CLIENT, 'utf8');
  const m = c.match(/var inject = \[([^\]]*)\]/);
  if (m) {
    const list = m[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean);
    const base = ['slots', 'locale'];
    const extra = list.filter((x) => !base.includes(x));
    extra.length === 0
      ? ok('inject 仅含基础服务: ' + JSON.stringify(list))
      : bad('inject 含可选服务 ' + JSON.stringify(extra) + '：宿主会一直等这些服务，boot 卡死（pending waiting for services）');
  } else {
    bad('client.js 中未找到 inject 声明');
  }
} else {
  bad('client.js 不存在');
}

console.log('=== 3. 宿主路由 /api/x-control/* ===');
// 找 DSH 监听的端口
let port = null;
try {
  const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH', { encoding: 'utf8' });
  const pid = Number((out.match(/"DeepSeek Harness\.exe","(\d+)"/) || [])[1]);
  if (pid) {
    const conns = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object -First 1 -ExpandProperty LocalPort"`,
      { encoding: 'utf8' }
    ).trim();
    if (conns) port = conns.split('\n')[0].trim();
  }
} catch { /* 忽略 */ }

if (!port) {
  console.log('  – 未找到 DSH 监听端口（应用可能未运行）');
} else {
  console.log('  端口 ' + port);
  for (const route of ['/api/x-control/config', '/api/x-control/tabs']) {
    try {
      const r = execSync(`curl -s -m 4 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}${route}"`, { encoding: 'utf8' }).trim();
      r === '200' ? ok(`${route} → 200（已注册）`) : bad(`${route} → ${r}（期望 200）`);
    } catch (e) { bad(`${route} 请求失败`); }
  }
}

console.log('=== 4. 浏览器与推流能力 ===');
const dir = join(homedir(), '.dsh', 'cache', 'dsh-control-x', 'browser-profile');
existsSync(dir) ? ok('browser-profile 存在: ' + dir) : console.log('  – browser-profile 尚未创建（首次调用 x_browser_open 时创建）');
try {
  const { chromium } = await import('playwright-core');
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
  if (!exe) { bad('未找到 Chrome/Edge'); }
  else {
    const b = await chromium.launchPersistentContext(dir, { executablePath: exe, headless: true, viewport: { width: 1280, height: 800 } });
    const p = await b.newPage();
    await p.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const cdp = await p.context().newCDPSession(p);
    let got = false;
    cdp.on('Page.screencastFrame', (f) => { got = true; cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 1 });
    await new Promise((r) => setTimeout(r, 2500));
    got ? ok('CDP screencast 出帧（面板画面可用）') : bad('screencast 未出帧');
    await cdp.send('Page.stopScreencast').catch(() => {});
    await b.close();
  }
} catch (e) { bad('浏览器探测失败: ' + String(e.message).slice(0, 80)); }

console.log('\n' + (failures === 0 ? '自检通过。' : `自检发现 ${failures} 个问题。`));
process.exit(failures === 0 ? 0 : 1);
