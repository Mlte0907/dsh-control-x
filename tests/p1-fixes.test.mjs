/**
 * P1 回归：两个"说明书上写着能用、实际必然失败"的功能（2026-10-02 新增，勿删）。
 *
 * 1) x_desktop_type / x_desktop_key 的 `element` 是**可选**参数（"可选：先点击该元素获得
 *    焦点"），但此前实现用 `args.element ?? 0` 去查元素，而观察树里**不存在编号 0**：
 *    uia-helper.ps1 的 Observe-Tree 第一轮 `if ($index -gt 0)` 把窗口自身（index 0）
 *    排除在 elements 之外（真机实测返回 1..11，无 0）。于是不传 element 必然撞
 *    `ELEMENT_UNAVAILABLE: 元素 #0 不在观察快照…`，一条把模型引向"再观察一遍"的误导报错。
 *    参照实现 988hj7tczd-oss/dsh-computer-use 的 guard.js:64 在 element 缺席时**跳过**
 *    元素级检查，而不是拿 0 去顶。
 *
 * 2) x_vision_describe 的 `tab_id` 捷径（"或直接给 tab_id 让本工具现拍一张"）此前调用
 *    `browserManager.shot(id, {})` 漏传 attachments，而 manager.shot() 拿不到它就直接抛
 *    「当前环境未挂载 attachments 服务」——捷径必然失败，且报错完全指错了方向。
 *
 * ── 为什么复制一份 lib ──────────────────────────────────────────────
 * 物理输入那三个函数（activateWindow / clickAt / typeUnicode / pressChord）会**真的**
 * 动这台机器的光标与键盘，绝不能在测试里跑。而 lib/desktop/tools.js 是静态 import
 * '../physical.js'，ESM 命名空间只读、原模块也没法替换。
 * 所以这里在测试启动时把 lib/ 复制到临时目录、只替换掉那一个 physical.js 为记录桩，
 * 其余文件都是**当前源码的原样副本**——不会与源码脱节，测试跑的仍是真逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib');

// ── 搭一份 lib 副本，把 physical.js 换成记录桩 ──────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'cx-p1-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });
cpSync(LIB, TMP, { recursive: true });
writeFileSync(join(TMP, 'desktop', 'physical.js'), `
/** 测试桩：记录调用，绝不碰真实光标/键盘。 */
globalThis.__CX_PHYSICAL__ ??= [];
const rec = (entry, ...args) => { globalThis.__CX_PHYSICAL__.push([entry, ...args]); };
export function userIdleMs() { return 999999; }
export function assertUserIdle() { rec('assertIdle'); }
export function activateWindow(hwnd) { rec('activate', hwnd); }
export function clickAt(x, y, button) { rec('click', x, y, button); }
export function typeUnicode(text) { rec('type', text); }
export function pressChord(chord) { rec('key', chord); }
`, 'utf8');

const calls = () => globalThis.__CX_PHYSICAL__ ?? [];
const flat = () => calls().map(([k, ...a]) => (a.length ? `${k}:${a.join(',')}` : k));

const { buildDesktopTools } = await import(pathToFileURL(join(TMP, 'desktop', 'tools.js')).href);
const { DesktopManager } = await import(pathToFileURL(join(TMP, 'desktop', 'manager.js')).href);

/** 与真实 uia-helper.ps1 同形：编号从 1 开始（真机实测）。 */
const OBSERVE_RESULT = {
  window: { pid: 1, title: '记事本', className: 'Notepad', hwnd: 12345, processName: 'notepad' },
  elements: [
    { index: 1, runtimeId: [1, 1], role: 'Edit', name: '文本编辑器', isPassword: false, patterns: ['Value'] },
    { index: 2, runtimeId: [1, 2], role: 'Button', name: '永久删除账号', isPassword: false, patterns: ['Invoke'] },
  ],
  tree: '- Edit "文本编辑器" #1\n- Button "永久删除账号" #2',
  elapsedMs: 3,
  truncated: false,
};
DesktopManager.prototype.runHelper = async function (command) {
  if (command === 'observe') return structuredClone(OBSERVE_RESULT);
  if (command === 'rect') {
    return {
      element: { x: 0, y: 0, width: 10, height: 10, clickX: 5, clickY: 5 },
      window: { pid: 1, title: '记事本', hwnd: 12345, foreground: true },
    };
  }
  throw new Error(`桩未实现: ${command}`);
};

/** approval 服务：可配置成 always / rejected / unavailable。 */
const approvalFactory = (outcome) => (n) => (n === 'approval'
  ? { request: async () => outcome }
  : undefined);

async function tools(overrides = {}) {
  const cfg = { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true, ...overrides };
  const list = buildDesktopTools({ get: approvalFactory('allowed-once'), logger: { info() {}, warn() {} } }, cfg);
  const tree = await list.find((t) => t.name === 'x_desktop_tree').execute({});
  return { list, observation: tree.observation };
}

test('x_desktop_type 省略可选的 element：不再撞"元素 #0"，而是打到窗口当前焦点', async () => {
  const { list, observation } = await tools();
  globalThis.__CX_PHYSICAL__ = [];
  const r = await list.find((t) => t.name === 'x_desktop_type').execute({ observation, text: '你好' }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.ok(r.disturbance.includes('已前置窗口"记事本"'), r.disturbance);
  // 关键：如实告知"没指定元素 → 危险词检查被跳过"，不装作做过检查
  assert.match(r.disturbance, /未指定元素/);
  assert.match(r.disturbance, /危险词检查已跳过/);
  assert.deepEqual(flat(), ['assertIdle', 'activate:12345', 'type:你好'], '只前置窗口 + 输入，没有多余的点击');
});

test('x_desktop_key 省略可选的 element：同上，且按键真的注入了', async () => {
  const { list, observation } = await tools();
  globalThis.__CX_PHYSICAL__ = [];
  const r = await list.find((t) => t.name === 'x_desktop_key').execute({ observation, key: 'ctrl+s' }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.match(r.disturbance, /未指定元素/);
  assert.deepEqual(flat(), ['assertIdle', 'activate:12345', 'key:ctrl+s']);
});

test('给了 element 时行为不变：先点元素再输入，且不做"未指定元素"声明', async () => {
  const { list, observation } = await tools();
  globalThis.__CX_PHYSICAL__ = [];
  const r = await list.find((t) => t.name === 'x_desktop_type')
    .execute({ observation, element: 1, text: 'hi' }, { agent: 'a' });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.disturbance, /未指定元素/);
  assert.deepEqual(flat(), ['assertIdle', 'activate:12345', 'click:5,5,left', 'type:hi']);
});

test('危险词护栏在给了 element 时仍然生效（没被上面的改动削弱）', async () => {
  // 元素名含「永久删除」，且 trustPhysicalInput=true（开了全权操控）。
  // 危险词门必须**独立于**物理门控生效——这正是 tools.js 的注释承诺的。
  const list = buildDesktopTools(
    { get: approvalFactory('rejected'), logger: { info() {}, warn() {} } },
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true },
  );
  const tree = await list.find((t) => t.name === 'x_desktop_tree').execute({});
  globalThis.__CX_PHYSICAL__ = [];
  await assert.rejects(
    () => list.find((t) => t.name === 'x_desktop_type').execute({ observation: tree.observation, element: 2, text: 'x' }, { agent: 'a' }),
    (e) => e.code === 'PERMISSION_DENIED',
    '名字含"永久删除"的元素：即使全权操控开启、审批被拒也必须拦下',
  );
  assert.deepEqual(flat(), [], '危险词门在物理门控之前拦住，一个物理调用都不该发生');
});

test('「全权操控」开关是实时读取的（回归：此前被快照成常量，改了要重载插件才生效）', async () => {
  let trust = false;
  const cfg = { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, get trustPhysicalInput() { return trust; } };
  // approval 永远拒绝：开关关着时必须被挡
  const list = buildDesktopTools({ get: approvalFactory('rejected'), logger: { info() {}, warn() {} } }, cfg);
  const tree = await list.find((t) => t.name === 'x_desktop_tree').execute({});
  const args = { observation: tree.observation, text: 'x' };
  await assert.rejects(() => list.find((t) => t.name === 'x_desktop_type').execute(args, { agent: 'a' }),
    (e) => e.code === 'PERMISSION_DENIED');

  // 用户在设置页把开关打开——**不重载插件**
  trust = true;
  const r = await list.find((t) => t.name === 'x_desktop_type').execute(args, { agent: 'a' });
  assert.equal(r.ok, true, '开关翻 true 后必须立刻生效');
  assert.match(r.disturbance, /全权操控/);
});

test('x_vision_describe 的 tab_id 捷径：真的能现拍一张（此前必然抛"未挂载 attachments"）', async () => {
  const { buildVisionTools } = await import('../lib/vision/tools.js');
  const ATTACH = { attachmentId: 'sha256:x', mediaType: 'image/jpeg', width: 1, height: 1, bytes: 1, name: 'a.jpg' };
  let saveImageCalls = 0;
  const browserManager = {
    listTabs: () => [{ id: 't1', url: 'https://e/', title: 'E' }],
    requireTabId: (h) => h ?? 't1',
    shot: async function (id, opts) {
      // 这里断言的就是修复点：opts.attachments 必须在场，否则 manager.shot() 直接抛错
      assert.ok(opts?.attachments?.saveImage, 'manager.shot 必须拿到 attachments 服务');
      saveImageCalls += 1;
      return { image: ATTACH };
    },
  };
  const llm = {
    listProviders: async () => ['p1'],
    listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1', inputModalities: ['image'] }],
    stream: async function* () { yield { type: 'text-delta', text: '一个红色按钮' }; },
  };
  const ctx = {
    get: (n) => (n === 'llm' ? llm : n === 'attachments' ? { saveImage: async () => ATTACH } : undefined),
    logger: { info() {}, warn() {} },
  };
  const [tool] = buildVisionTools(ctx, { visionModel: '' }, { browserManager });
  const r = await tool.execute({ tab_id: 't1' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.text, '一个红色按钮');
  assert.equal(saveImageCalls, 1);
});

test('x_vision_describe 的 attachment 路径必须真过一遍参数校验（0.5.27 在这一步就崩）', async () => {
  // 2026-10-03 真机会话实证，两次都是**字段齐全**的 image 引用：
  //   session-949b10c8（0.5.25）13:50:44 → Error: boolean true is not iterable
  //   session-32c83987（0.5.27）14:08:59 → 同一句；14:09:03 改传数组 →
  //     「需要 object 类型，实际是 object」（自相矛盾）
  // 崩在 wrappedExecute 的参数校验里，**代码根本没走到 describeImage**——
  // 这正是既有测试全绿却真机翻车的原因：vision.test.mjs 全部直接调 describeImage，
  // 没有一条用 attachment 对象走 tool.execute。这道门补上那一步。
  const { buildVisionTools } = await import('../lib/vision/tools.js');
  const ATTACH = {
    attachmentId: 'sha256:41b65e2de570343ecf7f18078420da5281176ac84537e259ada1cde0532f3718',
    mediaType: 'image/jpeg', bytes: 23244, width: 648, height: 503, name: 'x-desktop-1791006640792.jpg',
  };
  const llm = {
    listProviders: async () => ['p1'],
    listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1', inputModalities: ['image'] }],
    stream: async function* () { yield { type: 'text-delta', text: '豆包窗口，底部有输入框' }; },
  };
  const ctx = { get: (n) => (n === 'llm' ? llm : undefined), logger: { info() {}, warn() {} } };
  const [tool] = buildVisionTools(ctx, { visionModel: '' }, { browserManager: null });
  const r = await tool.execute({ attachment: ATTACH, prompt: '描述这张图' }, {});
  assert.equal(r.ok, true, 'attachment 路径必须能走通——degraded 桌面窗口只有这一条图源');
  assert.equal(r.text, '豆包窗口，底部有输入框');
});

test('x_vision_describe 支持 file_path：工作区里刚落盘的图也能被视觉模型看到', async () => {
  // 2026-10-03 真机会话 238eddfb step33-36：模型生成完图片想验收，但它只能吃文本，
  // 宿主 read_image 拒（model does not declare image input），而 x_vision_describe
  // **只收 attachment 引用/ tab_id**——它三次都传了同一个旧截图的 attachmentId，
  // 视觉模型反复答「我看到的是豆包界面截图，不是那张长图」，最后只能用 PowerShell
  // 解析 PNG 头+数颜色来"验图"。纯文本模型 + 图落在工作区 = 没有验图通道。
  const { writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { buildVisionTools } = await import('../lib/vision/tools.js');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const file = join(tmpdir(), `cx-vision-filepath-${Date.now()}.png`);
  writeFileSync(file, png);
  try {
    let saved = null;
    let seen = null;
    const attachments = {
      saveImage: async ({ data, mediaType, name }) => {
        saved = { bytes: data.length, mediaType, name };
        return { attachmentId: 'sha256:fromfile', mediaType, bytes: data.length, width: 1, height: 1, name };
      },
    };
    const llm = {
      listProviders: async () => ['p1'],
      listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1', inputModalities: ['image'] }],
      stream: async function* (opts) { seen = opts; yield { type: 'text-delta', text: '一张 1x1 的测试图' }; },
    };
    const ctx = {
      get: (n) => (n === 'llm' ? llm : n === 'attachments' ? attachments : undefined),
      logger: { info() {}, warn() {} },
    };
    const [tool] = buildVisionTools(ctx, { visionModel: '' }, { browserManager: null });

    const r = await tool.execute({ file_path: file }, {});
    assert.equal(r.ok, true, 'file_path 必须能走通整条链路（读文件 → 存 attachments → 视觉模型）');
    assert.equal(r.text, '一张 1x1 的测试图');
    assert.deepEqual(saved, { bytes: png.length, mediaType: 'image/png', name: pathBasename(file) },
      '必须按真实字节入库，mediaType 由文件内容判定');

    const img = seen.messages[0].content.find((c) => c.type === 'image');
    assert.equal(img.attachment.attachmentId, 'sha256:fromfile',
      '视觉模型收到的必须是这张文件的引用——不能是别的旧截图');

    // 文件不存在：要点名路径，别甩一句"缺少图片附件"把方向指错
    await assert.rejects(
      () => tool.execute({ file_path: join(tmpdir(), 'cx-not-here.png') }, {}),
      (e) => /cx-not-here\.png/.test(e.message),
    );
  } finally {
    try { rmSync(file, { force: true }); } catch { /* 已清理 */ }
  }
});

function pathBasename(p) {
  return String(p).split(/[\\/]/).pop();
}
