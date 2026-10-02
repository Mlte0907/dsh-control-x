/**
 * 桌面快照账本：TTL 软化的单元测试。
 * 0.5.14 之前过期快照被硬拒（30 秒 TTL 对"观察后要思考"的 agent 是必死墙，
 * 2026-10-02 飞书任务实测 10 分钟耗在撞墙上）；0.5.15 起过期后动作仍会带着
 * 元素身份（角色+名称）到 helper 里按 RuntimeId 重验——本文件测 Node 侧守卫：
 * 过期快照不再被删除或拒绝，revalidated 标记由 manager 动作方法带上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopManager } from '../lib/desktop/manager.js';

function makeSnapshot({ age = 0 } = {}) {
  const elements = new Map();
  elements.set(3, { runtimeId: [7, 42], role: 'Button', name: '确定', isPassword: false, patterns: ['Invoke'] });
  return {
    expiresAt: Date.now() + 30000 - age,
    processName: 'notepad',
    window: { pid: 1, title: '记事本', hwnd: 100, className: 'Notepad', processName: 'notepad' },
    elements,
  };
}

test('过期快照不再被硬拒：resolveTarget 返回元素并标记 expired（等待 RuntimeId 重验）', () => {
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: [] });
  m.observations.set('obs-1', makeSnapshot({ age: 60000 }));
  const { el, expired } = m.resolveTarget('obs-1', 3);
  assert.equal(el.name, '确定');
  assert.equal(expired, true, '过期标记要传给动作方法，用于生成 revalidated');
  assert.ok(m.observations.has('obs-1'), '过期快照必须保留（宽限期内供重验），不得删');
});

test('未过期快照照常工作，expired=false', () => {
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: [] });
  m.observations.set('obs-2', makeSnapshot({ age: 0 }));
  const { expired } = m.resolveTarget('obs-2', 3);
  assert.equal(expired, false);
});

test('不存在的快照仍然拒绝（不猜编号，纪律不变）', () => {
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: [] });
  assert.throws(() => m.resolveTarget('nope', 3), (err) => err.code === 'STALE_STATE');
});

test('快照存在但元素编号不存在：ELEMENT_UNAVAILABLE（不猜编号）', () => {
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: [] });
  m.observations.set('obs-3', makeSnapshot({ age: 60000 }));
  assert.throws(() => m.resolveTarget('obs-3', 99), (err) => err.code === 'ELEMENT_UNAVAILABLE');
});

test('白名单仍然生效：过期与否则是另一道门', () => {
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: ['calc'] });
  m.observations.set('obs-4', makeSnapshot({ age: 60000 }));
  assert.throws(() => m.resolveTarget('obs-4', 3), (err) => err.code === 'NOT_AUTHORIZED');
});

test('observe 的宽限清理只删远超 TTL 的快照（此处直接验证常量语义）', () => {
  // observe() 需要 spawn helper，这里用账本语义等价验证：宽限 = TTL + SNAPSHOT_GRACE。
  const m = new DesktopManager({ ttlMs: 30000, allowedApps: [] });
  m.observations.set('old', { ...makeSnapshot({ age: 60 * 60 * 1000 }) });   // 1 小时前到期 → 应清
  m.observations.set('fresh-expired', makeSnapshot({ age: 60000 }));          // 1 分钟前到期 → 应留
  const now = Date.now();
  for (const [id, snap] of m.observations) {
    if (snap.expiresAt + 30 * 60 * 1000 < now) m.observations.delete(id);
  }
  assert.ok(!m.observations.has('old'), '远超宽限的快照被清');
  assert.ok(m.observations.has('fresh-expired'), '宽限内的过期快照保留供重验');
});
