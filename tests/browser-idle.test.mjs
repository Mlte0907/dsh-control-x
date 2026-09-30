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
