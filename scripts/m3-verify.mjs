/**
 * M3 闭环验收：Skill 门控 + 物理输入门控序列。
 *
 * 1) 门控：fresh apply 只有 x_status + x_activate；control-x skill 已注册；
 * 2) x_activate：注册完整词汇表（幂等）；
 * 3) 物理路径实弹：charmap 复选框物理点击（空闲阈值=0 测试模式、审批不可用 →
 *    confirm_disturbance 显式自认、前置窗口、真实光标点击）→ ToggleState 翻转验证；
 * 4) 清理。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../lib/index.js';
import { CONTROL_X_SKILL } from '../lib/skill.js';
import { isDangerousLabel, requestApproval } from '../lib/core/guard.js';

const execFileAsync = promisify(execFile);
function assert(cond, message) {
  if (!cond) throw new Error(`验收失败: ${message}`);
  console.log(`  ✔ ${message}`);
}

// ── 1. 门控 ──
let skillRegistered = null;
const registered = new Map();
const mockCtx = {
  tools: { register: (t) => registered.set(t.name, t) },
  get: () => undefined, // 无 approval 服务 → 物理路径走 confirm_disturbance 例外
  logger: { info() {}, warn() {} },
  inject: (services, cb) => {
    if (services.includes('skills')) {
      cb({ skills: { register: (s) => { skillRegistered = s; } }, logger: { info() {}, warn() {} } });
    }
  },
};
apply(mockCtx, { headless: true, physicalIdleMs: 0 });
assert(registered.size === 2 && registered.has('x_status') && registered.has('x_activate'),
  `门控生效：常驻仅 ${[...registered.keys()].join(' + ')}`);
assert(skillRegistered?.name === CONTROL_X_SKILL.name && skillRegistered.content.length > 500,
  `skill "${skillRegistered?.name}" 已注册（内容 ${skillRegistered?.content.length} 字符）`);

// ── 2. 激活 ──
const act1 = await registered.get('x_activate').execute({}, { signal: AbortSignal.timeout(10000) });
assert(act1.activated && act1.toolCount === 19, `激活：新注册 ${act1.toolCount} 个工具`);
const act2 = await registered.get('x_activate').execute({}, { signal: AbortSignal.timeout(10000) });
assert(act2.toolCount === 0, `幂等：重复激活注册 0 个`);
const status = await registered.get('x_status').execute({}, {});
assert(status.activated === true, 'x_status 报告 activated=true');

// ── 3. 物理路径实弹（try/finally 保证清理） ──
const call = async (name, args) => {
  const tool = registered.get(name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  const started = Date.now();
  const value = await tool.execute(args ?? {}, { signal: AbortSignal.timeout(60000) });
  console.log(`[${name}] (${Date.now() - started}ms)`);
  return value;
};

const launched = await call('x_desktop_launch', { target: 'charmap.exe' });
// 失败也必须清理：绝不留下僵尸窗口叠在用户桌面上（M4 教训：僵尸窗口曾污染验收）。
let cleanupDone = false;
const cleanup = async () => {
  if (cleanupDone || !Number.isInteger(launched.pid)) return;
  cleanupDone = true;
  await execFileAsync('taskkill', ['/PID', String(launched.pid), '/F'], { windowsHide: true }).catch(() => {});
  console.log(`  ✔ 清理完成（taskkill ${launched.pid}）`);
};
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

try {
  await new Promise((r) => setTimeout(r, 2000));
  const apps = await call('x_desktop_apps');
  const mine = apps.windows.filter((w) => w.pid === launched.pid);
  assert(mine[0].title.includes('字符映射表'), 'charmap 窗口就位');
  const hwnd = mine[0].hwnd;

  const obs = await call('x_desktop_tree', { hwnd, max_elements: 300 });
  const advanced = obs.elements.find((e) => e.role === 'CheckBox' && e.patterns.includes('Toggle') && e.enabled);
  assert(advanced, `目标：#${advanced.index} "${advanced.name}"`);

  console.log('[物理点击：三重门控全开]');
  const clicked = await call('x_desktop_mouse_click', {
    observation: obs.observation, element: advanced.index, confirm_disturbance: true,
  });
  assert(/已前置窗口/.test(clicked.disturbance) && /真实光标/.test(clicked.disturbance),
    `结果明示打扰：${clicked.disturbance.slice(0, 50)}…`);

  const obs2 = await call('x_desktop_tree', { hwnd, max_elements: 300 });
  const advanced2 = obs2.elements.find((e) => e.index === advanced.index);
  assert(advanced2.toggleState !== advanced.toggleState,
    `物理点击生效：ToggleState ${advanced.toggleState} → ${advanced2.toggleState}`);
} finally {
  await cleanup();
}

// ── 4. 危险词护栏单元证据 ──
assert(isDangerousLabel('清空回收站') && isDangerousLabel('确认支付') && !isDangerousLabel('复制字符'),
  '危险词匹配正确');
const rejected = await requestApproval(
  { get: () => ({ request: async () => 'rejected' }) }, {}, 'x_test', 'test');
assert(rejected === 'rejected', 'approval 请求透传 outcome');
const unavailable = await requestApproval(
  { get: () => ({ request: async () => { throw new Error('no turn'); } }) }, {}, 'x_test', 'test');
assert(unavailable === 'unavailable', 'approval 异常 fail-closed 为 unavailable');

console.log('\nM3 闭环验收通过：门控 + skill + 物理输入三重门控全部成立');
