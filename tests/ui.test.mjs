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
  // configForms 存在 → 注册插件页配置卡片（plugins.bundle.config，按包名 keyed）
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
  assert.equal(settingsRegs.length, 1);
  assert.equal(settingsRegs[0].slot, 'plugins.bundle.config');
  assert.equal(settingsRegs[0].reg.options.key, 'dsh-control-x');
  assert.equal(typeof settingsRegs[0].reg.options.inject, 'function', 'configFace 注入（配置读写）');
  assert.equal(typeof settingsRegs[0].reg.Component, 'function');
  const face = settingsRegs[0].reg.options.inject();
  assert.equal(typeof face.set, 'function', 'face.set 暴露写通道');
  assert.equal(typeof face.hooks.cxSettings.subscribe, 'function', 'face.hooks.cxSettings 是 store');
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
  assert.equal(tabDefs[0].guide.length, 1, '引导页入口一枚');
  assert.equal(typeof tabDefs[0].guide[0].icon, 'function', '引导入口图标组件');
  const rightSlots = rightRegs.map((r) => r.slot).sort();
  assert.deepEqual(rightSlots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  const body = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab');
  assert.equal(body.reg.options.key, 'dsh-control-x', '正文 seat 按 tab id keyed');
  assert.equal(typeof body.reg.Component, 'function', 'tab 正文组件');
  const title = rightRegs.find((r) => r.slot === 'sidebar.right.pane.tab.title');
  assert.equal(title.reg.options.key, 'dsh-control-x');
  // register 抛错（id 撞名）→ 退回旧路径 footer + overlay，不能带倒插件
  const legacyRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => {
      if (services.includes('sidebarRightTabs')) {
        cb({
          sidebarRightTabs: { register: () => { throw new Error('duplicate id'); } },
          slots: makeSlots(legacyRegs),
        });
      }
    },
    slots: makeSlots([]),
  });
  assert.deepEqual(legacyRegs.map((r) => r.slot).sort(), ['shell.overlay', 'sidebar.footer.action']);
  delete globalThis.window;
});

test('watch 路由：GET /tabs 与 GET /config', async () => {
  const { WatchServer } = await import('../lib/browser/watch.js');
  const fakeManager = { listTabs: () => [{ id: 't1', url: 'https://x/', title: 'X' }], get: () => ({}) };
  const ws = new WatchServer(fakeManager);
  let route = null;
  ws.attach({ register: (r) => { route = r; } });
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/api/x-control');
  function fakeRes() {
    return { headersSent: false, status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  }
  const res1 = fakeRes();
  await route.handler({ method: 'GET', url: 'http://local/api/x-control/tabs', on() {} }, res1);
  assert.deepEqual(JSON.parse(res1.body), { tabs: [{ id: 't1', url: 'https://x/', title: 'X' }] });
  const res2 = fakeRes();
  await route.handler({ method: 'GET', url: 'http://local/api/x-control/config', on() {} }, res2);
  assert.equal(res2.status, 200);
});
