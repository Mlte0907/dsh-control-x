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
  const regs = [];
  const ctx = {
    effect: (fn) => fn(),
      slots: {
        inject(slot, gen) {
          const out = typeof gen === 'function' ? (gen[Symbol.iterator] ? Array.from(gen()) : [gen()]) : [gen];
          for (const r of out) regs.push({ slot, reg: r });
        },
        register(options, Component) { return { options, Component }; },
      },
      locale: {},
      effect: (fn) => fn(),
    };
  await exports.apply(ctx);
  const names = regs.map((r) => r.slot);
  assert.deepEqual(names.sort(), ['settings.plugins.tab', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  const settings = regs.find((r) => r.slot === 'settings.plugins.tab');
  assert.equal(settings.reg.options.id, 'control-x');
  assert.equal(typeof settings.reg.Component, 'function', '设置 tab 挂载组件');
  const panel = regs.find((r) => r.slot === 'sidebar.right.pane.tab');
  assert.equal(panel.reg.options.key, 'control-x');
  assert.equal(typeof panel.reg.Component, 'function', '右侧面板组件');
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
