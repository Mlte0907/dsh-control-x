/**
 * 面板路由测试的共享助手。
 *
 * 2026-10-02 起 watch.js 的 handler 顶部有浏览器信任栅栏（见 watch.js 的
 * requestGuardReason 注释）：Host 必须回环、POST 的 Origin 必须与 Host 同源、
 * POST 必须是 application/json。裸调 handler 的测试必须带上真实请求头，
 * 否则会被栅栏正确地拦成 403/415——那不是回归，是栅栏在干活。
 *
 * 这里造的请求头与真实客户端一致：面板由 DSH 自己的渲染层加载，
 * 连的是 127.0.0.1:<port>，所以 Host 与 Origin 都是回环。
 */

/** 一个通过栅栏的请求（默认回环同源）。 */
export function gatedReq(method, path, body, overrides = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const host = '127.0.0.1:19387';
  const headers = {
    host,
    // 浏览器对 GET/HEAD 不带 Origin；带上了就必须与 Host 同源。
    ...(method === 'GET' ? {} : { origin: `http://${host}` }),
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    ...overrides,
  };
  return {
    method,
    url: 'http://local/api/x-control' + path,
    headers,
    on() {},
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    },
  };
}

/** 一个收集状态码与响应体的 res。 */
export function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    body: '',
    headers: {},
    writeHead(s, h) { this.status = s; this.headers = h ?? {}; },
    end(b) { this.body = b ?? ''; },
  };
}

/** 跑一次请求，返回 { status, json }。 */
export async function callRoute(route, method, path, body, reqOverrides) {
  const res = fakeRes();
  await route.handler(gatedReq(method, path, body, reqOverrides), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 允许非 JSON 响应 */ }
  return { status: res.status, body: res.body, json };
}
