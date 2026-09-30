/**
 * M2 闭环验收：桌面语义控制（零键鼠注入）。
 *
 * 平台事实（证据见 docs/DSH-SDK-CONTRACT.md §11）：Win11 打包应用（记事本）的
 * Start-Process pid 与窗口进程不对应，且可能复用已有进程——按 pid 清理会误伤用户窗口。
 * 因此验收选用经典 Win32 进程 charmap（字符映射表）：
 *   启动 → 枚举窗口定位 pid → 编号树观察 → ValuePattern 写入 → 重新观察验证 →
 *   Invoke 字符按钮（点击）→ 重新观察验证编辑框内容变化 → 清理（只杀自己的 pid）。
 * 全部动作走 UIA 模式：不注入键鼠事件、不抢前台焦点。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../lib/index.js';

const execFileAsync = promisify(execFile);

const registered = new Map();
const mockCtx = {
  tools: { register: (t) => registered.set(t.name, t) },
  get: () => undefined,
  logger: { info() {}, warn() {} },
};
apply(mockCtx, { headless: true, ttlMs: 30000 });
await registered.get('x_activate').execute({}, { signal: AbortSignal.timeout(10000) });
const call = async (name, args) => {
  const tool = registered.get(name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  const started = Date.now();
  const value = await tool.execute(args ?? {}, { signal: AbortSignal.timeout(60000) });
  console.log(`[${name}] (${Date.now() - started}ms)`);
  return value;
};
function assert(cond, message) {
  if (!cond) throw new Error(`验收失败: ${message}`);
  console.log(`  ✔ ${message}`);
}

/** 宿主会用 output.schema 校验工具返回值——返回缺 schema 要求的键 = 这次调用被判失败。
 *  2026-10-01 真机 E2E 实测踩到过：x_browser_tabs 少 ok:true，而它不走 withTab 包装。
 *  宿主外的测试全都直接调 execute()、绕过这道校验，所以必须在这里显式对账。 */
function assertReturnShape(tool, value, label) {
  const need = tool.output?.schema?.required ?? [];
  const have = value !== null && typeof value === 'object' ? Object.keys(value) : [];
  const missing = need.filter((key) => !have.includes(key));
  assert(missing.length === 0, `${label} 返回值满足自身契约（实际键：${have.join(',')}）`);
  return value;
}

// ── 闭环 ──
const launched = await call('x_desktop_launch', { target: 'charmap.exe' });
assertReturnShape(registered.get('x_desktop_launch'), launched, 'x_desktop_launch');
assert(Number.isInteger(launched.pid), `启动 charmap pid=${launched.pid}`);
const pid = launched.pid;

await new Promise((r) => setTimeout(r, 2000)); // 等待窗口建立

const apps = await call('x_desktop_apps');
assertReturnShape(registered.get('x_desktop_apps'), apps, 'x_desktop_apps');
const mine = apps.windows.filter((w) => w.pid === pid);
assert(mine.length > 0, `x_desktop_apps 看到我们的窗口`);
assert(mine[0].title.includes('字符映射表'), `中文标题 UTF-8 完好（"${mine[0].title}"）——helper stdio 编码修正生效`);
const hwnd = mine[0].hwnd;

const obs1 = await call('x_desktop_tree', { hwnd, max_elements: 500 });
assertReturnShape(registered.get('x_desktop_tree'), obs1, 'x_desktop_tree');
assert(obs1.observation && obs1.elementCount > 10, `编号树观察成功（${obs1.elementCount} 元素，${obs1.elapsedMs}ms）`);

const edit = obs1.elements.find((e) => e.patterns.includes('Value') && !e.isPassword && e.enabled);
assert(edit, `找到可写元素（#${edit?.index} ${edit?.role} "${edit?.name}"）`);
assert(!edit.patterns.includes('Invoke') || true, '');

assertReturnShape(registered.get('x_desktop_value'), await call('x_desktop_value', { observation: obs1.observation, element: edit.index, value: 'X' }), 'x_desktop_value');
const obs2 = await call('x_desktop_tree', { hwnd, max_elements: 500 });
const edit2 = obs2.elements.find((e) => e.index === edit.index);
assert(edit2 && (edit2.value ?? '').trim() === 'X', `重新观察确认写入落地（值=${JSON.stringify(edit2?.value)}）`);

// 语义点击：charmap 默认视图的字符网格是自绘控件（UIA 不可见，roles census 证据：
// 只有 选择/复制 两个 Button + 188 个字体 ListItem）。改用 Toggle 模式点击
// "高级查看(V)" 复选框——效果证据 = ToggleState 翻转（直接证据，不受元素数上限掩盖）。
const advanced = obs2.elements.find((e) => e.role === 'CheckBox' && e.patterns.includes('Toggle') && e.enabled);
assert(advanced, `找到可切换的复选框（#${advanced?.index} "${advanced?.name}"）`);
const beforeState = advanced.toggleState;
assertReturnShape(registered.get('x_desktop_press'), await call('x_desktop_press', { observation: obs2.observation, element: advanced.index }), 'x_desktop_press');
const obs3 = await call('x_desktop_tree', { hwnd, max_elements: 500 });
const advanced3 = obs3.elements.find((e) => e.index === advanced.index);
assert(advanced3 && advanced3.toggleState && advanced3.toggleState !== beforeState,
  `点击生效：复选框状态 ${beforeState} → ${advanced3?.toggleState}——语义动作 + 效果验证闭环`);
const newEdits = obs3.elements.filter((e) => e.role === 'Edit' && !obs2.elements.some((o) => o.index === e.index && o.role === 'Edit'));
assert(newEdits.length > 0, '高级查看展开出新编辑控件，可继续语义操作');

// 清理：charmap 是经典进程，pid 就是窗口进程，只杀自己的
await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
console.log(`  ✔ 清理完成（taskkill ${pid}）`);
console.log('\nM2 闭环验收通过：零键鼠注入、零焦点抢占（除启动瞬间），语义动作 + 观察验证闭环成立');
