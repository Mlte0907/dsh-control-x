/**
 * x_desktop_wait（0.5.34）：桌面侧的"等一下再看"。
 *
 * 为什么加：浏览器侧早有 x_browser_wait，桌面侧一直没有——模型自己预期它存在：
 *   真机会话 session-c7fd771f step28（2026-10-03 23:56）
 *     → Error: unknown tool "x_desktop_wait"
 *   当时它只能改用 pwsh Start-Sleep 绕。
 * 参考（用户点名的 UI-TARS）：他们的 action space 里 `wait()` 是**一等公民**——
 *   "Sleep for 5s and take a screenshot to check for any changes"——
 *   "等一下再观察"本来就是 GUI 任务的常态动作，不该让模型去发明工具名。
 *
 * 边界（防把回合卡死）：ms 夹在 100–10000。生成类任务常要 10~60 秒，
 * 但一个动作里睡 60 秒会把整个回合吊住——超上限直接报错，让模型自己决定
 * 是分几次等、还是先去做别的（返回 note 里写清上限）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopTools, WAIT_MS_MAX, WAIT_MS_MIN, clampWaitMs } from '../lib/desktop/tools.js';

const cfg = { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true, desktopShotEnabled: false };
const ctx = { get: () => undefined, logger: { info() {}, warn() {} } };

test('桌面侧必须有等待工具（浏览器有 x_browser_wait，桌面曾缺位被模型撞上）', () => {
  const list = buildDesktopTools(ctx, cfg, {});
  const tool = list.find((t) => t.name === 'x_desktop_wait');
  assert.ok(tool, 'x_desktop_wait 必须存在——真机 c7fd771f step28 已经撞过 unknown tool');
  assert.equal(WAIT_MS_MAX, 10000, '上限 10s：一个动作里睡更久会把整个回合吊住');
  assert.equal(WAIT_MS_MIN, 100);
});

test('clampWaitMs：夹在 [100, 10000]，非数字回默认值', () => {
  assert.equal(clampWaitMs(120), 120, '正常值原样');
  assert.equal(clampWaitMs(0), WAIT_MS_MIN, '0 → 下限');
  assert.equal(clampWaitMs(-5), WAIT_MS_MIN, '负数 → 下限');
  assert.equal(clampWaitMs(999999), WAIT_MS_MAX, '超上限 → 10s');
  assert.equal(clampWaitMs('abc'), 1000, '非数字 → 默认 1000');
});

test('真的会等，且返回值告诉模型"接下来要重新观察"', async () => {
  const list = buildDesktopTools(ctx, cfg, {});
  const tool = list.find((t) => t.name === 'x_desktop_wait');
  const t0 = Date.now();
  const r = await tool.execute({ ms: 150 }, {});
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed >= 120, `必须真的等了（实测 ${elapsed}ms）`);
  assert.equal(r.waited_ms, 150, '回报实际等待时长');
  assert.match(r.note, /x_desktop_tree/, '必须点明：等完要重新观察，不要拿旧快照做动作');
});

test('不给 ms 直接报错（schema 的必填检查先于 execute），且范围写在描述里让模型能自救', async () => {
  const list = buildDesktopTools(ctx, cfg, {});
  const tool = list.find((t) => t.name === 'x_desktop_wait');
  await assert.rejects(() => tool.execute({}, {}), (e) => /ms/.test(e.message));
  assert.match(tool.parameters.properties.ms.description, /100/, '范围下限要写在参数描述里');
  assert.match(tool.description, /10000/, '上限也要写在工具描述里');
});
