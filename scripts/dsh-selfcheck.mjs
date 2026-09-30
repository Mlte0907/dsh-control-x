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
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

console.log('=== 1b. profile patch 重复声明检查 ===');
// 插件在 dsh.profile.bundles 里时，宿主合成会自动应用包内 cordis.patch.yml 的 insert 声明；
// 若用户 patch 再手写顶层 `- id: dsh-control-x` 条目，合成后同 id 两条 → 插件不挂载（2026-10-01 实测）。
try {
  const profileJson = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
  const isBundle = ((profileJson.dsh?.profile?.bundles) ?? []).includes('dsh-control-x');
  const patchText = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8');
  const manual = /^- id: dsh-control-x$/m.test(patchText);
  if (isBundle && manual) {
    bad('profile cordis.patch.yml 手写了顶层 dsh-control-x 条目，而插件已是 bundle（宿主自动应用包内 patch）——同 id 双声明会让插件不挂载，请删除手写条目');
  } else if (manual) {
    ok('profile patch 手写条目存在（插件未列入 bundles，靠它声明）');
  } else if (isBundle) {
    ok('插件经 dsh.profile.bundles 自动应用包内 patch（profile 无手写条目）');
  } else {
    console.log('  – 插件既不在 bundles 也没有手写条目（可能未安装）');
  }
} catch (e) { console.log('  – 跳过（' + String(e?.message ?? e).slice(0, 60) + '）'); }

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

/** DSH 桌面版是 Electron 多进程：监听端口的进程未必是 tasklist 里的第一个同名进程，
 *  因此必须收集全部候选 PID（Harness 主/子进程 + 可能的 node 子进程），再取并集端口。 */
function candidatePorts() {
  const IMAGES = ['DeepSeek Harness.exe', 'node.exe', 'dsh.exe'];
  const pids = new Set();
  for (const image of IMAGES) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      for (const m of out.matchAll(new RegExp(`"${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}","(\\d+)"`, 'g'))) {
        pids.add(Number(m[1]));
      }
    } catch { /* 该镜像不存在则跳过 */ }
  }
  if (pids.size === 0) return [];
  const filter = [...pids].map((p) => `$_.OwningProcess -eq ${p}`).join(' -or ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { ${filter} } | Select-Object -ExpandProperty LocalPort`],
      { encoding: 'utf8' });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number).filter((n) => n > 0 && n < 65536))];
  } catch { return []; }
}

/** 端口是否就是 DSH 的 web 端口：用插件路由本身判定，避免误认其它本地服务。
 *  任何探测异常都记进 lastProbeError —— 早期版本裸 catch 吞异常，导致"curl 明明返回 200
 *  却报未找到端口"这类静默误判。 */
let lastProbeError = null;
function routeStatus(port, route) {
  try {
    return execFileSync('curl', ['-s', '-m', '4', '-o', devNull, '-w', '%{http_code}', `http://127.0.0.1:${port}${route}`], { encoding: 'utf8' }).trim();
  } catch (e) {
    lastProbeError = `${port}${route}: ${String(e?.message ?? e).slice(0, 100)}`;
    return null;
  }
}

const ports = process.env.DSH_PORT ? [Number(process.env.DSH_PORT), ...candidatePorts()] : candidatePorts();
let port = null;
for (const p of ports) {
  if (routeStatus(p, '/api/x-control/config') === '200') { port = p; break; }
}

if (!port) {
  console.log(`  – 未找到承载插件路由的端口（已探测 ${ports.length} 个候选${ports.length ? '：' + ports.join(', ') : ''}；应用可能未运行）`);
  if (lastProbeError) console.log('    最近一次探测错误：' + lastProbeError);
} else {
  console.log('  端口 ' + port);
  for (const route of ['/api/x-control/config', '/api/x-control/tabs']) {
    const r = routeStatus(port, route);
    r === '200' ? ok(`${route} → 200（已注册）`) : bad(`${route} → ${r ?? '请求失败'}（期望 200）`);
  }
}

console.log('=== 4. 浏览器与推流能力 ===');
const dir = join(homedir(), '.dsh', 'cache', 'dsh-control-x', 'browser-profile');
existsSync(dir) ? ok('browser-profile 存在: ' + dir) : console.log('  – browser-profile 尚未创建（首次调用 x_browser_open 时创建）');
// 用独立临时 profile 探测：插件自己的 headless 实例若正在运行会持有 browser-profile 的单例锁，
// 复用同一目录会以 "Target page, context or browser has been closed" 失败，从而把真实能力误判为不可用。
const probeDir = mkdtempSync(join(tmpdir(), 'dsh-control-x-probe-'));
try {
  const { chromium } = await import('playwright-core');
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
  if (!exe) { bad('未找到 Chrome/Edge'); }
  else {
    const b = await chromium.launchPersistentContext(probeDir, { executablePath: exe, headless: true, viewport: { width: 1280, height: 800 } });
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
finally { try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* 临时目录残留无碍 */ } }

console.log('\n' + (failures === 0 ? '自检通过。' : `自检发现 ${failures} 个问题。`));
process.exit(failures === 0 ? 0 : 1);
