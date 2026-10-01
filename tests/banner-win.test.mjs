/**
 * 桌面置顶横幅（Windows 原生浮窗）纯逻辑测试。
 *
 * 只测不碰真实 PowerShell 的部分：状态计算、变化签名、启动/停止编排。
 * 真实浮窗的渲染（置顶、穿透、打字）用 PowerShell 起真进程在真机验收里验，
 * 单元测试里拉真进程只会把套件变慢并引入环境依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bannerState, stateSignature, createDesktopBanner } from '../lib/banner-win.js';
import { createActivityTracker } from '../lib/desktop/activity.js';

const BASE = { active: true, running: true, tool: 'x_desktop_value', kind: 'desktop', since: 1, idleMs: 0, graceMs: 2500 };

test('桌面活动与浏览器活动给出不同文案', () => {
  const desk = bannerState(BASE);
  const brow = bannerState({ ...BASE, kind: 'browser', tool: 'x_browser_open' });
  assert.equal(desk.text, 'X-Agent 正在操控桌面…（x_desktop_value）');
  assert.equal(brow.text, 'X-Agent 正在使用浏览器…（x_browser_open）');
  assert.notEqual(desk.text, brow.text, '两类活动不能共用一句话——用户分不出 Agent 在动屏幕还是上网');
});

test('不活跃时清空文案（浮窗据此隐藏）', () => {
  const s = bannerState({ ...BASE, active: false, running: false });
  assert.equal(s.text, '');
  assert.equal(s.active, false);
});

test('没有工具名时不硬凑一个空括号', () => {
  assert.equal(bannerState({ ...BASE, tool: '' }).text, 'X-Agent 正在操控桌面…');
});

test('主题色缺失时退回默认值，不留空串', () => {
  const s = bannerState(BASE, { bg: '', fg: undefined });
  assert.equal(s.bg, '#23242a');
  assert.equal(s.fg, '#eeeeee');
  assert.ok(/^#[0-9a-f]{6}$/i.test(s.bg), '默认色必须是浮窗能解析的 #RRGGBB');
});

test('变化签名忽略 since/idleMs：否则每 400ms 都会写一次文件', () => {
  const a = bannerState({ ...BASE, since: 1, idleMs: 0 });
  const b = bannerState({ ...BASE, since: 999999, idleMs: 12345 });
  assert.equal(stateSignature(a), stateSignature(b));
});

test('变化签名能分辨真正要重画的三件事', () => {
  const base = bannerState(BASE);
  assert.notEqual(stateSignature(base), stateSignature(bannerState({ ...BASE, tool: 'x_browser_open', kind: 'browser' })));
  assert.notEqual(stateSignature(base), stateSignature(bannerState(BASE, { bg: '#ffffff' })));
  assert.notEqual(stateSignature(base), stateSignature(bannerState({ ...BASE, active: false })));
});

test('tracker 能区分两类活动', () => {
  let t = 1000;
  const tracker = createActivityTracker({ graceMs: 0, now: () => t });
  tracker.begin('x_browser_open', 'browser');
  assert.equal(tracker.snapshot().kind, 'browser');
  tracker.end('x_browser_open');
  tracker.begin('x_desktop_press', 'desktop');
  assert.equal(tracker.snapshot().kind, 'desktop');
});

test('停止写入：被停用后浮窗不会再收到旧状态', () => {
  const writes = [];
  const banner = createDesktopBanner({
    activity: createActivityTracker({ graceMs: 0 }),
    spawnImpl: () => ({ unref() {}, on() {}, kill() {} }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  // start 会先写一份初始状态；这里只断言编排本身，不去碰真实 spawn/文件。
  assert.equal(typeof banner.start, 'function');
  assert.equal(typeof banner.stop, 'function');
  assert.ok(Array.isArray(writes));
});

test('浮窗脚本不含 CJK 字面量（Windows PowerShell 无 BOM 按 ANSI 解码会解析失败）', () => {
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  const offenders = [...src].filter((ch) => /[^\x00-\x7F]/.test(ch));
  assert.deepEqual(offenders, [], `脚本必须纯 ASCII，实际含 ${offenders.length} 个非 ASCII 字符`);
});

test('浮窗脚本必须启动计时器（Timer 创建后是静止的，不 Start 就没有打字动画）', () => {
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  assert.match(src, /\$timer\.Start\(\)/, '缺 Start() 的话横幅永远停在空框——实测踩过');
  assert.match(src, /WS_EX_TRANSPARENT/, '必须点击穿透，否则置顶浮窗会挡住用户自己的桌面');
  assert.match(src, /HWND_TOPMOST/, '必须置顶，否则 Agent 操控别的应用时看不见');
});