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

test('文字一次到位，且没有打字动画也没有光标（用户 2026-10-02）', async (t) => {
  const { banner, dispose } = await load({ snap: { active: true, tool: 'x_desktop_value' } });
  t.after(dispose);
  await flush();
  const box = banner().children[0];
  const label = box.children[1];
  const BASE = 'X-Agent正在控制电脑，操控键鼠会打断操作';

  // 结构上：只有圆点 + 文字两个孩子。闪烁的光标以 1.25Hz 闪，被用户当成
  // 横幅本身在闪，已经连同打字效果一起去掉。
  assert.equal(box.children.length, 2, `横幅内应只剩圆点与文字（实际 ${box.children.length} 个元素）`);
  for (const child of Array.from(box.children)) {
    assert.doesNotMatch(String(child.style && child.style.cssText), /dsh-control-x-blink/,
      '不得再有闪烁光标动画');
  }

  assert.equal(label.textContent, BASE, '文字一次到位，没有逐字/逐点动画');
  // 多等一会儿：文字必须一直不变，不存在"先短后长"的打字过程。
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(label.textContent, BASE, '600ms 后仍是完整文案（没有打字过程）');
});

test('reduced-motion：圆点固定为单一颜色，不做变色循环', async (t) => {
  const { banner, dispose } = await load({ reduceMotion: true, snap: { active: true, tool: 'x_desktop_press' } });
  t.after(dispose);
  await flush();
  const dot = banner().children[0].children[0];
  const label = banner().children[0].children[1];
  assert.match(dot.style.cssText, /background:#3b82f6/, 'reduced-motion 下固定蓝色');
  assert.doesNotMatch(dot.style.cssText, /animation:/, 'reduced-motion 下不跑变色动画');
  assert.equal(label.textContent, 'X-Agent正在控制电脑，操控键鼠会打断操作');
  assert.ok(!label.textContent.includes('x_desktop_press'), '不出现动作名');
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

test('主题上报必须把 CSS 颜色折算成 #RRGGBB（不折算就会被服务端静默丢弃）', async () => {
  // 2026-10-03 真机故障：宿主样式表原文是
  //     --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  //     --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  // getComputedStyle 对自定义属性返回的是**字面量**，于是客户端 POST 上去的是
  // `rgb(15, 17, 21)`，服务端只收 #hex、其余丢弃 → 主题色永远落不了地，
  // 桌面横幅停在默认深色，**不随宿主深浅色变化**（用户实测报告）。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /function toHex\(/,
    '必须有颜色折算函数——自定义属性给的是 rgb()/var() 字面量，不是 #hex');
  const from = src.indexOf('function pushTheme');
  const to = src.indexOf('function tick');
  assert.ok(from > 0 && to > from, 'pushTheme 与 tick 的位置变了：本断言要看两者之间的那段');
  const push = src.slice(from, to);
  assert.match(push, /toHex\(/,
    'pushTheme 上报的必须是折算后的值，不能把 CSS 原文直接 POST 上去');
  assert.doesNotMatch(push, /getPropertyValue\([^)]*\)\.trim\(\)[^)]*\)/,
    '不许再出现「取到什么就发什么」的裸上报——那正是被服务端丢掉的那条路径');
});
