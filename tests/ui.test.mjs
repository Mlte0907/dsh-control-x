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
  assert.deepEqual(exports.inject, ['slots', 'locale', 'settingsScope', 'shell']);
  const regs = [];
  const makeSlots = (into) => ({
    // 宿主接受两种形状：generator function（yield register）与箭头函数（直接返回 register）
    inject(slot, gen) {
      const out = typeof gen === 'function' ? (gen[Symbol.iterator] ? Array.from(gen()) : [gen()]) : [gen];
      for (const r of out) into.push({ slot, reg: r });
    },
    register(options, Component) { return { options, Component }; },
  });
  // settingsScope 分支：设置 → 插件 行内卡片
  const settingsRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: (services, cb) => { if (services.includes('settingsScope')) cb({ settingsScope: {}, slots: makeSlots(settingsRegs) }); },
    slots: makeSlots([]),
  });
  assert.equal(settingsRegs.length, 1);
  assert.equal(settingsRegs[0].slot, 'settings.plugin.item');
  assert.equal(settingsRegs[0].reg.options.key, 'dsh-control-x');
  assert.equal(typeof settingsRegs[0].reg.Component, 'function');
  // 侧边栏入口 + 浮层面板
  const shellRegs = [];
  await exports.apply({
    effect: (fn) => fn(),
    inject: () => {},
    slots: makeSlots(shellRegs),
    shell: {},
  });
  const slots = shellRegs.map((r) => r.slot).sort();
  assert.deepEqual(slots, ['shell.overlay', 'sidebar.footer.action']);
  const entry = shellRegs.find((r) => r.slot === 'sidebar.footer.action');
  assert.equal(entry.reg.options.id, 'control-x');
  assert.equal(typeof entry.reg.Component, 'function', '侧边栏入口按钮');
  const overlay = shellRegs.find((r) => r.slot === 'shell.overlay');
  assert.equal(typeof overlay.reg.Component, 'function', '面板内容组件');
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
