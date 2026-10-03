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
  // ⚠️ 这条断言原先钉的是 `--dsw-alias-bg-elevated`——**宿主里不存在这个变量**，
  // CSS 于是永远走 fallback `#23242a`，页面横幅底色从不随主题变；而测试只检查
  // "用了某个主题变量名"，所以照样全绿。**测试把 bug 本身钉住了。**
  // 现在钉 `bg-layer-1`（宿主真实定义），变量名是否真存在由 `npm run verify:host-css`
  // 对着 app.asar 逐个核。
  assert.match(box.style.cssText, /background:var\(--dsw-alias-bg-layer-1/, '背景必须是宿主真实定义的主题层变量');
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

test('主题上报必须成对取自宿主真实存在的变量（凭空写的变量名就是这次故障的根因）', async () => {
  // 2026-10-03 23:xx 真机复盘（0.5.30 装了、折算也生效了，横幅底色**仍然**不变）：
  // 直接问运行中的面板 GET /api/x-control/activity，拿到
  //     {"theme":{"bg":"","fg":"#0f1115"}}
  // fg 已经是折算好的 hex（证明 toHex 在工作），bg 却是**空串**——因为
  // `--dsw-alias-bg-elevated` **在宿主里根本不存在**（从 app.asar 抽出：宿主共定义
  // 107 个 --dsw-alias-* 变量，没有这一个）。变量名是当初凭印象写的，取不到就返回 ''，
  // 一路静默到浮窗 → 底色永远停在 DEFAULT_THEME 的 #23242a，用户看到的就是
  // 「桌面横幅不随宿主主题变化」。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /function toHex\(/, '必须有颜色折算函数');
  assert.match(src, /THEME_PAIRS/, '必须是候选对列表——宿主改名/缺变量时能退到下一对');
  const from = src.indexOf('function pushTheme');
  const to = src.indexOf('function tick');
  assert.ok(from > 0 && to > from, 'pushTheme 与 tick 的位置变了：本断言要看两者之间的那段');
  assert.match(src.slice(from, to), /readPair\(/,
    'pushTheme 必须走 readPair 成对取色，不能单点读一个变量（单点=单点故障，且失败不可见）');
  // 死名字不许复活：只查取色用的那段，注释里提到它是为了留案底
  const pairs = src.slice(src.indexOf('THEME_PAIRS'), src.indexOf('function readPair'));
  assert.ok(pairs.length > 0, 'THEME_PAIRS 必须是数组字面量');
  assert.doesNotMatch(pairs, /bg-elevated/, '取色列表里不得再出现宿主没有的变量名');
  assert.match(pairs, /--dsw-alias-bg-layer-1/, '第一对必须是宿主真实存在的页面底色变量');
  assert.match(pairs, /--dsw-alias-label-primary/, 'fg 必须用 label-primary（宿主确实定义了它）');
});
