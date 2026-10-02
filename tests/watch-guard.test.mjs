/**
 * 浏览器信任栅栏的回归测试（2026-10-02 新增，勿删）。
 *
 * 这条栅栏是被一次真实事故逼出来的：宿主 `dsh-host-webserver` 的分发是纯
 * `match(pathname) → route.handler`（app.asar 内 lib/index.js:229-245），**webserver 层
 * 没有任何全局栅栏**；宿主自己的 Host/Origin 三重校验 + 浏览器会话认证只作用在
 * `dsh-client-connection` 自己那条 `/api` 路由上。插件用 `webServer.register({kind:'prefix'})`
 * 注册的是第二条独立路由，于是原本完全落在那道栅栏之外。
 *
 * 实测（对运行中的宿主打的同一个请求）：
 *     GET /api                   → 403   ← 宿主拒绝
 *     GET /api/x-control/config  → 200   ← 插件放行
 *
 * 而这条无鉴权的路上挂着有副作用的端点：POST /update（下载安装新版本）、
 * POST /host-accessibility（改宿主启动快捷方式）、POST /clear-data（清 Cookie）、
 * POST /input（点击打字）、POST /login-window（拉起有头浏览器）。
 *
 * 参照实现：Fisfzy/dsh-ego-browser（同代、同宿主、同架构的唯一同类）做了四件事，
 * 见其 lib/index.js:2040-2061 与 :1149。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchServer, requestGuardReason, isLoopbackHostHeader, MAX_BODY_BYTES } from '../lib/browser/watch.js';
import { gatedReq, fakeRes, callRoute } from './helpers.mjs';

const HOST = '127.0.0.1:19387';

/** 一个每个端点都有副作用的假管理器：栅栏一旦失效，测试就会看见它被调用。 */
function spyManager() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push(name); return Promise.resolve({ ok: true, mode: 'all', cleared: [], tab: null, saved: true }); };
  return {
    calls,
    listTabs: () => { calls.push('listTabs'); return []; },
    clearData: rec('clearData'),
    openLoginWindow: rec('openLoginWindow'),
    finishLogin: rec('finishLogin'),
    requireTabId: (h) => h ?? 't1',
    get: () => ({ url: () => 'https://x/' }),
    input: null,
  };
}

function mount(extra = {}) {
  const m = spyManager();
  let route = null;
  const updater = extra.updater ?? {
    snapshot: () => ({ status: 'idle' }),
    check: async () => { m.calls.push('update:check'); return { status: 'idle' }; },
    startApply: () => { m.calls.push('update:apply'); return { status: 'working' }; },
  };
  // WatchServer(manager, activity, listVisionModels, banner, updater, hostAccessibility)
  const ws = new WatchServer(m, null, null, null, updater, extra.hostAccessibility);
  ws.attach({ register: (r) => { route = r; } });
  return { route, m };
}

test('栅栏第 1 条：Host 必须回环（这条杀 DNS rebinding）', () => {
  assert.equal(isLoopbackHostHeader('127.0.0.1:19387'), true);
  assert.equal(isLoopbackHostHeader('localhost:19387'), true);
  assert.equal(isLoopbackHostHeader('[::1]:19387'), true);
  // rebinding 场景：socket 连到了本机，但 Host 头是攻击者域名
  assert.equal(isLoopbackHostHeader('evil.example'), false);
  assert.equal(isLoopbackHostHeader('evil.example:19387'), false);
  // 0.0.0.0 不是回环，宿主启动时也直接拒绝它（会把 RCE 暴露到网络上）
  assert.equal(isLoopbackHostHeader('0.0.0.0:19387'), false);
  assert.equal(isLoopbackHostHeader(undefined), false);
  assert.equal(isLoopbackHostHeader(''), false);

  const denied = requestGuardReason({ method: 'GET', headers: { host: 'evil.example', origin: 'http://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.error, 'host-not-loopback');
});

test('栅栏第 2 条：POST 的 Origin 必须与 Host 同源（杀跨站）', () => {
  const cross = requestGuardReason({
    method: 'POST',
    headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' },
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.error, 'origin-not-allowed');

  const same = requestGuardReason({
    method: 'POST',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
  });
  assert.equal(same, null, '同源必须放行，否则面板自己都用不了');

  // Origin 存在但解析不了 → 400，不当放行
  assert.equal(requestGuardReason({
    method: 'POST', headers: { host: HOST, origin: 'not a url', 'content-type': 'application/json' },
  }).status, 400);

  // 缺席 Origin 放行：那是 curl / 验收脚本 / 单测这类非浏览器客户端，
  // 它们仍然要过第 1、3 条。按 Fetch 规范，浏览器对 POST 一定带 Origin，所以不构成绕过。
  assert.equal(requestGuardReason({
    method: 'POST', headers: { host: HOST, 'content-type': 'application/json' },
  }), null);
});

test('栅栏第 3 条：POST 必须是 application/json（触发预检，跨域发不出去）', () => {
  const textPlain = requestGuardReason({
    method: 'POST', headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'text/plain' },
  });
  assert.equal(textPlain.status, 415);
  assert.equal(textPlain.error, 'content-type-not-supported');
  // 这正是 `fetch(url, {mode:'no-cors', headers:{'Content-Type':'text/plain'}})` 那条绕过路径
  assert.equal(requestGuardReason({
    method: 'POST', headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'text/plain;charset=UTF-8' },
  }).status, 415);
  assert.equal(requestGuardReason({ method: 'POST', headers: { host: HOST } }).status, 415);
  // GET 不受此限（EventSource 之类也用 GET）
  assert.equal(requestGuardReason({ method: 'GET', headers: { host: HOST } }), null);
});

test('端到端：恶意跨站请求打不动任何有副作用的端点', async () => {
  const { route, m } = mount();
  const hostile = {
    host: HOST,
    origin: 'https://evil.example',
    // 攻击者会挑一个"简单请求"内容类型来绕预检
    'content-type': 'text/plain',
  };
  const targets = [
    ['POST', '/update', { action: 'apply' }],
    ['POST', '/host-accessibility', { enabled: true }],
    ['POST', '/clear-data', { mode: 'all' }],
    ['POST', '/input', { tab: 't1', type: 'click', x: 1, y: 1 }],
    ['POST', '/login-window', { url: 'https://attacker.example' }],
  ];
  for (const [method, path, body] of targets) {
    const res = await callRoute(route, method, path, body, hostile);
    assert.equal(res.status, 403, `${method} ${path} 必须被拒（跨站）`);
  }
  // DNS rebinding：Host 与 Origin 都是攻击者域名，栅栏第 1 条独立生效
  const rebound = await callRoute(route, 'POST', '/update', { action: 'apply' }, {
    host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json',
  });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.json.error, 'host-not-loopback');
  assert.deepEqual(m.calls, [], '一个副作用都不许发生');
});

test('端到端：同源合法客户端照常可用（栅栏不能把面板自己锁死）', async () => {
  const { callRoute } = await import('./helpers.mjs');
  const calls = [];
  const acc = {
    detect: async () => { calls.push('detect'); return { ok: true, shortcuts: [], errors: [] }; },
    set: async (e) => { calls.push(`set:${e}`); return { ok: true, shortcuts: [], errors: [] }; },
  };
  const { route, m } = mount({ hostAccessibility: acc });
  assert.equal((await callRoute(route, 'GET', '/tabs')).status, 200);
  assert.equal((await callRoute(route, 'POST', '/update', { action: 'check' })).status, 200);
  assert.equal((await callRoute(route, 'POST', '/host-accessibility', { enabled: true })).status, 200);
  assert.deepEqual(m.calls, ['listTabs', 'update:check']);
  assert.deepEqual(calls, ['set:true'], '同源 POST 真的转到了控制器（detect 只在 GET 时调）');
  // 只读端点也要通，且不带 Origin（浏览器 GET 不带 Origin）
  assert.equal((await callRoute(route, 'GET', '/host-accessibility')).status, 200);
  assert.deepEqual(calls, ['set:true', 'detect']);
});

test('请求体有硬上限（不设上限则任意本地页面能把宿主内存吃光）', async () => {
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
  const { route } = mount();
  // 造一个超过上限的 body
  const big = 'x'.repeat(MAX_BODY_BYTES + 1024);
  const req = gatedReq('POST', '/input', undefined);
  req.headers = { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' };
  req[Symbol.asyncIterator] = async function* () { yield big; };
  const res = fakeRes();
  await route.handler(req, res);
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /请求体超过上限/);
});
