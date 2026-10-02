/**
 * 浏览器空闲回收：headless 实例是 9 个进程、数百 MB 的常驻树，
 * 工具与面板都停用后必须自动还回去；面板在推流时（hold）则绝不能回收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager } from '../lib/browser/manager.js';

/** 造一个假 context：只关心 close() 是否被调用。 */
function fakeManager(idleMs) {
  const m = new BrowserManager({ browserIdleMs: idleMs });
  const state = { closed: 0 };
  m.context = {
    browser: () => ({ isConnected: () => true }),
    close: async () => { state.closed += 1; },
  };
  m.pages = new Map();
  return { m, state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('空闲超时后自动关闭实例', async () => {
  const { m, state } = fakeManager(60);
  m.touch();
  await sleep(200);
  assert.equal(state.closed, 1, '超过 browserIdleMs 未使用即关闭');
  assert.equal(m.context, null, '关闭后 context 置空，下次调用重新懒启动');
});

test('持续使用不会回收', async () => {
  const { m, state } = fakeManager(120);
  for (let i = 0; i < 4; i++) { m.touch(); await sleep(50); }
  assert.equal(state.closed, 0, '每次 touch 重置计时');
  await sleep(250);
  assert.equal(state.closed, 1, '停止使用后仍会回收');
});

test('面板推流持有期间不回收', async () => {
  const { m, state } = fakeManager(50);
  m.hold();
  m.touch();
  await sleep(200);
  assert.equal(state.closed, 0, 'hold 期间画面不能断');
  m.release();
  await sleep(200);
  assert.equal(state.closed, 1, 'release 后恢复回收');
});

test('browserIdleMs=0 关闭回收', async () => {
  const { m, state } = fakeManager(0);
  m.touch();
  await sleep(150);
  assert.equal(state.closed, 0, '0 = 不回收（长跑任务可关掉）');
  assert.equal(m.idleTimer, null);
});

test('shutdown 清理定时器，不留悬挂回调', async () => {
  const { m, state } = fakeManager(5000);
  m.touch();
  assert.ok(m.idleTimer, '已排定回收检查');
  await m.shutdown();
  assert.equal(m.idleTimer, null, '定时器已清');
  assert.equal(state.closed, 1);
});

test('gotoWithGrace：goto 超时但导航已提交时，宽限等待转成功', async () => {
  // 2026-10-02 两次端到端实测的形态：goto 20s 超时，但页面其实在加载，
  // x_browser_wait 等 load 随后成功。宽限等待把这类慢启动变成成功而不是报错。
  const m = new BrowserManager({});
  const calls = [];
  const slowPage = {
    async goto() { calls.push('goto'); throw new Error('Timeout 20000ms exceeded.'); },
    async waitForLoadState(state) { calls.push(`wait:${state}`); },
  };
  await m.gotoWithGrace(slowPage, 'https://example.com/');
  assert.deepEqual(calls, ['goto', 'wait:domcontentloaded'], '超时后应恰好宽限等待一次');
});

test('gotoWithGrace：宽限内仍未到 DCL，原样抛超时（由 mapNavigationError 归一）', async () => {
  const m = new BrowserManager({});
  const deadPage = {
    async goto() { throw new Error('Timeout 20000ms exceeded.'); },
    async waitForLoadState() { throw new Error('Timeout 10000ms exceeded.'); },
  };
  await assert.rejects(
    () => m.gotoWithGrace(deadPage, 'https://example.com/'),
    (err) => err.message.includes('Timeout 20000ms exceeded'),
  );
});

test('gotoWithGrace：非超时错误立即上抛，不做无谓宽限', async () => {
  const m = new BrowserManager({});
  const refusedPage = {
    async goto() { throw new Error('net::ERR_CONNECTION_REFUSED at https://example.com'); },
    waitForLoadState: async () => { throw new Error('宽限不该被调用'); },
  };
  await assert.rejects(() => m.gotoWithGrace(refusedPage, 'https://example.com/'), /ERR_CONNECTION_REFUSED/);
});
