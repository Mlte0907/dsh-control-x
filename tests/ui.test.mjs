/**
 * UI 验收：客户端 bundle 的官方 slot 注册 + 面板路由行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('client bundle 注册三个官方原生 slot', async () => {
  const handlers = new Map();
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { handlers.set(spec.id, spec.factory); },
    },
  };
  // 触发 client bundle 装载
  await import('../lib/client.js');
  const factory = handlers.get('dsh-control-x');
  assert.equal(typeof factory, 'function');
  // 模拟宿主 require：react 仅做 createElement stub，其他模块返回空对象
  const exports = factory((name) => {
    if (name === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
    return {};
  });
  assert.equal(exports.name, 'dsh-control-x');
  // inject 只能声明必然存在的基础服务；可选服务走 apply 内 ctx.inject（否则 cordis 永远等待）
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  const makeSlots = (into) => ({
    // 宿主接受两种形状：generator function（yield register）与箭头函数（直接返回 register）
    inject(slot, gen) {
      const out = typeof gen === 'function' ? (gen[Symbol.iterator] ? Array.from(gen()) : [gen()]) : [gen];
      for (const r of out) into.push({ slot, reg: r });
    },
    register(options, Component) { return { options, Component }; },
  });
  // configForms 缺失时必须静默跳过（不抛错），不注册任何东西
  const skipped = [];
  await exports.apply({ effect: (fn) => fn(), inject: (s, cb) => cb({}), slots: makeSlots(skipped) });
  assert.equal(skipped.length, 0, '可选服务缺失时不注册也不抛错');
  // configForms 存在 → 注册设置页配置区（settings.section，先例 dsh-pangu/agent-presets）
  const settingsRegs = [];
  const fakeForm = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { headless: true, ttlMs: 30000 } }),
    subscribe: () => () => {},
    set: async () => {},
  };
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('configForms')) {
        cb({
          configForms: { get: () => fakeForm, whileServed: (namespaces, fn) => fn() },
          effect: (fn) => fn(),
          slots: makeSlots(settingsRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.equal(settingsRegs.length, 2, 'settings.section + conversation.input.overlay');
  const section = settingsRegs.find((r) => r.slot === 'settings.section');
  assert.ok(section, '设置页 section 已注册');
  assert.equal(section.reg.options.id, 'control-x');
  assert.equal(section.reg.options.label(), 'X-Agent操控', '设置导航栏标题');
  assert.equal(typeof section.reg.options.inject, 'function', 'configFace 注入（配置读写）');
  assert.equal(typeof section.reg.Component, 'function');
  const face = section.reg.options.inject();
  assert.equal(typeof face.set, 'function', 'face.set 暴露写通道');
  assert.equal(typeof face.hooks.cxSettings.subscribe, 'function', 'face.hooks.cxSettings 是 store');
  const inputBtn = settingsRegs.find((r) => r.slot === 'conversation.input.overlay');
  assert.equal(inputBtn.reg.options.id, 'control-x', '输入框按钮 seat');
  assert.equal(typeof inputBtn.reg.Component, 'function', '输入框按钮组件');
  // sidebarRightTabs 存在 → 注册侧边栏入口 + 面板
  const sideRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => { if (services.includes('sidebarRightTabs')) cb({ sidebarRightTabs: {}, slots: makeSlots(sideRegs) }); },
    slots: makeSlots([]),
  });
  const slots = sideRegs.map((r) => r.slot).sort();
  assert.deepEqual(slots, ['shell.overlay', 'sidebar.footer.action']);
  const entry = sideRegs.find((r) => r.slot === 'sidebar.footer.action');
  assert.equal(entry.reg.options.id, 'control-x');
  assert.equal(typeof entry.reg.Component, 'function', '侧边栏入口组件');
  const overlay = sideRegs.find((r) => r.slot === 'shell.overlay');
  assert.equal(typeof overlay.reg.Component, 'function', '面板内容组件');
  // sidebarRightTabs 带 register → 注册右侧栏 tab（不再注册 footer/overlay）
  const rightRegs = [];
  const tabDefs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('sidebarRightTabs')) {
        cb({
          sidebarRightTabs: { register: (def) => { tabDefs.push(def); return () => {}; } },
          slots: makeSlots(rightRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.equal(tabDefs.length, 1, 'tab 类型注册一次');
  assert.equal(tabDefs[0].id, 'dsh-control-x');
  assert.equal(tabDefs[0].kind, 'dsh-control-x');
  assert.equal(typeof tabDefs[0].title, 'function', 'chip 标题是取值函数');
  assert.equal(tabDefs[0].title(), 'X-Agent浏览器', '右侧栏 chip 标题');
  assert.equal(tabDefs[0].guide.length, 1, '引导页入口一枚');
  assert.equal(tabDefs[0].guide[0].title(), 'X-Agent浏览器', '引导页入口标题');
  assert.equal(typeof tabDefs[0].guide[0].icon, 'function', '引导入口图标组件');
  const rightSlots = rightRegs.map((r) => r.slot).sort();
  assert.deepEqual(rightSlots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  const body = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab');
  assert.equal(body.reg.options.key, 'dsh-control-x', '正文 seat 按 tab id keyed');
  assert.equal(typeof body.reg.Component, 'function', 'tab 正文组件');
  assert.equal(typeof body.reg.options.inject, 'function', '正文可读设置 face（关闭横幅/按钮显隐）');
  const title = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab.title');
  assert.equal(title.reg.options.key, 'dsh-control-x');
  // register 抛错（热重放重复注册）→ 视为已就位：仍补 seat，绝不回退 footer/overlay
  const replayRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('sidebarRightTabs')) {
        cb({
          sidebarRightTabs: { register: () => { throw new Error('duplicate id'); } },
          slots: makeSlots(replayRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.deepEqual(replayRegs.map((r) => r.slot).sort(), ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    '重复注册时仍补 seat，不产生 footer/overlay 双入口');
  delete globalThis.window;
});

test('性能契约：面板不可见即停流 + CDP 出帧节流', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // 面板由宿主侧栏承载，不可见时组件仍挂载：不门控就会出现无人观看仍在推流的空转。
  assert.match(src, /IntersectionObserver/, '用 IntersectionObserver 判定面板可见性');
  assert.match(src, /ref: rootRef/, '可见性观察锚点挂在面板根节点');
  assert.match(src, /\[selected, live\]/, '帧流订阅随可见性重建（不可见即 close）');
  assert.match(src, /\[live\]/, '标签页轮询随可见性启停');

  const { SCREENCAST_OPTIONS } = await import('../lib/browser/watch.js');
  assert.ok(SCREENCAST_OPTIONS.everyNthFrame >= 2,
    '服务端 120ms 才取一帧，源侧不必逐帧编码 JPEG');
  assert.ok(SCREENCAST_OPTIONS.maxWidth <= 1280, '推流宽度受限');
  assert.equal(SCREENCAST_OPTIONS.format, 'jpeg');
});

test('watch 路由：GET /tabs 与 GET /config', async () => {
  const { WatchServer } = await import('../lib/browser/watch.js');
  const fakeManager = {
    listTabs: () => [{ id: 't1', url: 'https://x/', title: 'X' }],
    get: () => ({ url: () => 'https://x/' }),
    requireTabId: (hint) => hint ?? 't1',
    navigate: async (tab, url) => ({ id: tab, url, title: 'N' }),
    open: async (url) => ({ id: 't1', url, title: 'O' }),
    history: async (tab, action) => ({ id: tab, url: 'https://x/', title: action }),
    clearData: async (mode) => ({ ok: true, mode, cleared: ['cache'] }),
  };
  const ws = new WatchServer(fakeManager);
  let route = null;
  ws.attach({ register: (r) => { route = r; } });
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/api/x-control');
  function fakeRes() {
    return { headersSent: false, status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  }
  async function request(method, path, body) {
    const res = fakeRes();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: 'http://local/api/x-control' + path,
      on() {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload; },
    };
    await route.handler(req, res);
    return res;
  }
  const res1 = await request('GET', '/tabs');
  assert.deepEqual(JSON.parse(res1.body), { tabs: [{ id: 't1', url: 'https://x/', title: 'X' }] });
  const res2 = await request('GET', '/config');
  assert.equal(res2.status, 200);
  // 地址栏导航：有 tab 原地跳，无 tab 新开
  const nav1 = JSON.parse((await request('POST', '/navigate', { tab: 't1', url: 'https://y/' })).body);
  assert.equal(nav1.ok, true);
  assert.equal(nav1.tab.url, 'https://y/');
  const nav2 = JSON.parse((await request('POST', '/navigate', { url: 'https://z/' })).body);
  assert.equal(nav2.tab.url, 'https://z/');
  const navBad = await request('POST', '/navigate', {});
  assert.equal(navBad.status, 400, '缺 url 返回 400');
  // 工具栏历史导航
  const hist = JSON.parse((await request('POST', '/nav', { tab: 't1', action: 'back' })).body);
  assert.equal(hist.ok, true);
  assert.equal(hist.tab.title, 'back');
  // 在默认浏览器打开（stub 掉真实拉起）
  ws.spawnExternal = async (u) => u;
  const ext = JSON.parse((await request('POST', '/open-external', { tab: 't1' })).body);
  assert.equal(ext.ok, true);
  assert.equal(ext.url, 'https://x/');
  // 清除浏览器数据
  const clear = JSON.parse((await request('POST', '/clear-data', { mode: 'all' })).body);
  assert.equal(clear.ok, true);
  assert.equal(clear.mode, 'all');
});
