/**
 * 顶部横幅：Agent 操控桌面时的提示（打字效果 + 主题自适应背景 + 失效自愈）。
 *
 * 单独一个文件是有意的：client.js 在 import 期就执行 window.__ModuleLoader__.load，
 * 而 node --test 每个测试文件是独立进程，这里才能自己控制 window/document 的装载时机。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 够用的最小 DOM：横幅只用到 createElement/appendChild/textContent/style/setAttribute。 */
function makeDom() {
  const makeEl = (tag) => ({
    tagName: tag, children: [], attrs: {}, style: { cssText: '' }, _text: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.removed = true; },
    addEventListener() {},
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    cssTextOf() { return this.style.cssText; },
    walk(out = []) { out.push(this); this.children.forEach((c) => c.walk?.(out)); return out; },
  });
  const body = makeEl('body');
  const head = makeEl('head');
  return {
    body, head,
    createElement: makeEl,
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };
}

async function load({ reduceMotion = false, snap, fetchFails = false } = {}) {
  const dom = makeDom();
  globalThis.document = dom;
  globalThis.matchMedia = () => ({ matches: reduceMotion });
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(url);
    if (fetchFails) return Promise.reject(new Error('route gone'));
    return Promise.resolve({ json: async () => snap });
  };
  const handlers = new Map();
  globalThis.window = { __ModuleLoader__: { load: (spec) => handlers.set(spec.id, spec.factory) } };
  await import(`../lib/client.js?banner=${Math.random()}`);
  const factory = handlers.get('dsh-control-x');
  const exports = factory((name) => {
    if (name === 'react') return { createElement: (type, props, ...kids) => ({ type, props, children: kids }) };
    return {};
  });
  // 真实宿主会提供这两个服务；这里给最小实现让 apply 走完。
  // 收好 ctx.effect 的 disposer：横幅的轮询是递归 setTimeout，不卸载的话
  // 事件循环永不结束，node --test 会挂住（2026-10-01 踩过：整轮测试卡死无输出）。
  const disposers = [];
  await exports.apply({
    effect: (fn) => { disposers.push(fn()); },
    inject: (services, cb) => { if (services.includes('configForms')) cb({}); },
    slots: { inject() {}, register() { return {}; } },
  });
  return {
    dom,
    calls,
    banner: () => dom.body.children.find((c) => c.attrs['data-dhcx-activity'] === 'banner'),
    dispose: () => { disposers.forEach((fn) => { try { fn(); } catch { /* 已卸载 */ } }); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 轮询等待条件成立；超时抛错。不靠"睡够多少毫秒"来判定（文案一改就假红/假绿）。 */
async function waitFor(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor 超时');
}

test('活动时挂出横幅，默认隐藏；无活动则不显示', async (t) => {
  const { dom, banner, dispose } = await load({ snap: { active: false, tool: '' } });
  t.after(dispose);
  await flush();
  const host = banner();
  assert.ok(host, '横幅宿主常驻挂载（避免动作时才创建导致闪烁）');
  assert.equal(host.style.opacity, '0', '空闲时不可见');
  assert.equal(dom.body.children.includes(host), true);
});

test('背景框用宿主主题变量（切浅/深主题自动跟随），且不用会变白的 brand 变量', async (t) => {
  const { banner, dispose } = await load({ snap: { active: false, tool: '' } });
  t.after(dispose);
  await flush();
  const box = banner().children[0];
  assert.match(box.style.cssText, /background:var\(--dsw-alias-bg-elevated/, '背景必须是主题层变量');
  assert.match(box.style.cssText, /color:var\(--dsw-alias-label-primary/, '文字色跟随主题');
  assert.doesNotMatch(box.style.cssText, /background:[^;]*--dsw-alias-brand-primary/,
    '本机 brand 变量解析成白色，不能用它当背景');
});

test('reduced-motion：文字直接完整显示，不做打字动画', async (t) => {
  const { banner, dispose } = await load({ reduceMotion: true, snap: { active: true, tool: 'x_desktop_press' } });
  t.after(dispose);
  await flush();
  const label = banner().children[0].children[1];
  assert.match(label.textContent, /^X-Agent 正在操控中…/, '一次到位');
  assert.match(label.textContent, /x_desktop_press/, '带出正在执行的动作名');
});

test('打字效果：逐字出现，且带闪烁光标', async (t) => {
  const { banner, dispose } = await load({ snap: { active: true, tool: 'x_desktop_value' } });
  t.after(dispose);
  await flush();
  const box = banner().children[0];
  const label = box.children[1];
  const caret = box.children[2];
  assert.match(caret.style.cssText, /dsh-control-x-blink/, '光标带闪烁动画');
  await new Promise((r) => setTimeout(r, 130));
  assert.ok(label.textContent.length > 0, '已经开始打字');
  assert.ok(label.textContent.length < 20, `此时还没打完（实际 ${JSON.stringify(label.textContent)}）`);
  // 打字中：屏幕上的是全文的一个前缀（不是另一段文案，也不是从中间开始）
  assert.ok('X-Agent 正在操控中…（x_desktop_value）'.startsWith(label.textContent),
    `必须是全文前缀（实际 ${JSON.stringify(label.textContent)}）`);
  // 打字结束后文案完整（轮询等待，不拍脑袋定毫秒数——文案长度一变就会假红）
  const full = 'X-Agent 正在操控中…（x_desktop_value）';
  await waitFor(() => label.textContent === full, 4000);
  assert.equal(label.textContent, full);
});

test('接口挂掉时横幅自己隐藏，不留下假的"正在操控"', async (t) => {
  // fetchFails 让 load 装一个必定失败的 fetch：模拟插件被停用/路由消失
  const { banner, dispose } = await load({ fetchFails: true });
  t.after(dispose);
  await flush();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(banner().style.opacity, '0', '取数失败必须隐藏');
});

test('轮询节奏随活跃状态切换（活跃 600ms / 空闲 2500ms）', async (t) => {
  const { calls, dispose } = await load({ snap: { active: true, tool: 'x_desktop_press' } });
  t.after(dispose);
  await flush();
  assert.ok(calls.every((u) => u === '/api/x-control/activity'), '只打活动端点');
  assert.ok(calls.length >= 1);
});
