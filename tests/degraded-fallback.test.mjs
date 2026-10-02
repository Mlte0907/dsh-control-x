/**
 * degraded / x_desktop_shot / x_desktop_click_at 的回归测试（2026-10-03）。
 *
 * 背景：整条「改宿主启动快捷方式加 --force-renderer-accessibility」功能下线，实测三条理由：
 *   1. 旗标在现代 Chromium 上已无效——playwright chromium 实测 102 vs 103 元素（噪声）；
 *   2. 替代方案 SPI_SETSCREENREADER 是一次性闩锁，关不掉（关后仍 159 元素，
 *      而"从未开启"时只有 13）；
 *   3. 覆盖不全且会留残留：只改 .lnk 覆盖不到"开始菜单搜索 / 宿主自重启"等入口。
 * Electron 应用改走「树能看就用树，不能看就截图 + 坐标点击」——对应 ZCode 的
 * strategy:auto（优先 a11y，回落 event/坐标）。
 *
 * 物理输入那三个函数会**真的**动本机光标与键盘，所以这里在测试启动时把 lib/ 复制到
 * 临时目录、只替换 physical.js 为记录桩。其余文件是当前源码的原样副本，不会脱节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'cx-degraded-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });
cpSync(join(HERE, '..', 'lib'), TMP, { recursive: true });
writeFileSync(join(TMP, 'desktop', 'physical.js'), `
globalThis.__CX_PHYSICAL__ ??= [];
const rec = (e, ...a) => { globalThis.__CX_PHYSICAL__.push([e, ...a]); };
export function userIdleMs() { return 999999; }
export function assertUserIdle() { rec('assertIdle'); }
export function activateWindow(hwnd) { rec('activate', hwnd); }
export function clickAt(x, y, button) { rec('click', x, y, button); }
export function typeUnicode(text) { rec('type', text); }
export function pressChord(chord) { rec('key', chord); }
`, 'utf8');

const { buildDesktopTools } = await import(pathToFileURL(join(TMP, 'desktop', 'tools.js')).href);
const { DesktopManager, DEGRADED_NAMED_MAX, DEGRADED_TOTAL_MIN } =
  await import(pathToFileURL(join(TMP, 'desktop', 'manager.js')).href);

const calls = () => globalThis.__CX_PHYSICAL__ ?? [];
const flat = () => calls().map(([k, ...a]) => (a.length ? `${k}:${a.join(',')}` : k));

/** 造一个 observe 结果：n 个元素，前 named 个有名字。 */
const tree = (n, named) => ({
  window: { pid: 1, title: 'App', className: 'C', hwnd: 777, processName: 'app' },
  elements: Array.from({ length: n }, (_, i) => ({
    index: i + 1, runtimeId: [1, i + 1],
    role: i % 2 === 0 ? 'Button' : 'Pane',
    name: i < named ? `控件 ${i}` : '',
    isPassword: false, patterns: [],
  })),
  tree: '', elapsedMs: 3, truncated: false,
});
/** 窗口矩形（window_rect 命令的返回）。 */
const RECT = {
  window: { pid: 1, title: 'App', hwnd: 777, x: 336, y: 139, width: 1965, height: 1106, foreground: false },
};

/** 一小张合法 JPEG（1x1，像素 0xFF D8 FF E0 … FF D9）。 */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

function setup({ elements = tree(13, 4), shotOk = true, shotEnabled = true } = {}) {
  DesktopManager.prototype.runHelper = async function (command) {
    if (command === 'observe') return structuredClone(elements);
    if (command === 'window_rect') return structuredClone(RECT);
    if (command === 'window_shot') {
      if (!shotOk) {
        const { ControlXError } = await import(pathToFileURL(join(TMP, 'core', 'errors.js')).href);
        throw new ControlXError('窗口截图失败：PrintWindow 返回空，或画面几乎全黑。', { code: 'STALE_STATE' });
      }
      return { imageBase64: JPEG.toString('base64'), bytes: JPEG.length, window: structuredClone(RECT.window) };
    }
    throw new Error(`桩未实现: ${command}`);
  };
  const list = buildDesktopTools(
    { get: (n) => (n === 'approval' ? { request: async () => 'allowed-once' }
      : n === 'attachments' ? { saveImage: async () => ({ attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: JPEG.length, width: 1965, height: 1106, name: 'a.jpg' }) }
        : undefined), logger: { info() {}, warn() {} } },
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true, desktopShotEnabled: shotEnabled },
  );
  return list;
}
const byName = (list, n) => list.find((t) => t.name === n);

// ───────────────────────── 1) degraded 判定 ─────────────────────────

test('degraded：空壳窗口（DSH 实测 13/4）被标为不可用，并给出替代路径', async () => {
  const list = setup();
  const v = await byName(list, 'x_desktop_tree').execute({});
  assert.equal(v.degraded, true, '13 个元素/4 有名字必须判为 degraded');
  assert.equal(v.namedCount, 4, 'namedCount 要如实报出——它才是判断树好不好用的指标');
  assert.match(v.degradedReason, /语义动作.*不可用/s);
  assert.match(v.degradedReason, /x_desktop_shot/, '必须告诉模型替代路径是什么');
  assert.match(v.degradedReason, /重试观察无用/, '必须明说这不是时序问题，否则模型会反复重试');
});

test('degraded：正常窗口不误报（OpenCode 实测 48/33、Edge 实测 499/461）', async () => {
  for (const [n, named, label] of [[48, 33, 'OpenCode'], [499, 461, 'Edge 152']]) {
    const list = setup({ elements: tree(n, named) });
    const v = await byName(list, 'x_desktop_tree').execute({});
    assert.equal(v.degraded, false, `${label}（${n}/${named}）不该被判 degraded`);
    // 不 degraded 时 degradedReason 必须为空串（不是 undefined）——宿主会先做无损快照，
    // undefined 字段会被判 "value is not lossless JSON" 而让整次调用失败（0.5.9 事故）。
    assert.equal(v.degradedReason, '', `${label} 不 degraded 时 degradedReason 应为空串`);
  }
});

test('degraded 阈值就是那两个常量（改动它们必须同步改本测试的期望）', () => {
  assert.equal(typeof DEGRADED_NAMED_MAX, 'number');
  assert.equal(typeof DEGRADED_TOTAL_MIN, 'number');
  // 阈值必须落在「空壳(13/4)」与「正常(48/33)」之间，否则判定会误报
  assert.ok(DEGRADED_NAMED_MAX > 4 && DEGRADED_NAMED_MAX < 33, `named 阈值 ${DEGRADED_NAMED_MAX} 必须在 4 与 33 之间`);
  assert.ok(DEGRADED_TOTAL_MIN > 13 && DEGRADED_TOTAL_MIN < 48, `total 阈值 ${DEGRADED_TOTAL_MIN} 必须在 13 与 48 之间`);
});

// ───────────────────────── 2) x_desktop_shot ─────────────────────────

test('x_desktop_shot：只截已观察过的那个窗口，并返回可用的 image 引用', async () => {
  const list = setup();
  const obs = await byName(list, 'x_desktop_tree').execute({});
  const r = await byName(list, 'x_desktop_shot').execute({ observation: obs.observation });
  assert.equal(r.ok, true);
  assert.equal(r.image.attachmentId, 'sha256:x');
  assert.equal(r.image.mediaType, 'image/jpeg');
  assert.equal(r.image.bytes, JPEG.length);
  assert.equal(r.degraded, true, '同一个观察的 degraded 判定必须与 tree 一致');
  assert.match(r.note, /degraded/, '兜底窗口要提醒模型这是兜底路径');
  assert.equal(r.window.hwnd, 777, '必须回报窗口元数据，模型才知道截的是哪个窗口');
  assert.equal(r.window.width, 1965);
  // 图片块要交给宿主：render 必须把 image block 一起吐出来，否则模型看不到画面
  const blocks = byName(list, 'x_desktop_shot').output.render({}, r);
  assert.ok(blocks.some((b) => b.type === 'image' && b.attachment?.attachmentId === 'sha256:x'),
    'render 必须包含 image block（对标 x_browser_shot）');
});

test('x_desktop_shot：必须绑定 observation（不能凭 hwnd 截任意窗口）', async () => {
  const list = setup();
  await assert.rejects(
    () => byName(list, 'x_desktop_shot').execute({ observation: 'never-observed' }),
    (e) => e.code === 'STALE_STATE',
    '不存在的 observation 必须拒绝——否则就成了任意窗口截图器',
  );
  // 即便额外传了 hwnd 也不行：observation 是唯一凭据
  await assert.rejects(
    () => byName(list, 'x_desktop_shot').execute({ observation: 'never-observed', hwnd: 777 }),
    (e) => e.code === 'STALE_STATE',
  );
});

test('x_desktop_shot：schema 不得声明被忽略的窗口参数（observation 是唯一凭据）', async () => {
  const list = setup();
  for (const name of ['x_desktop_shot', 'x_desktop_click_at']) {
    const props = byName(list, name).parameters.properties;
    for (const banned of ['pid', 'title', 'hwnd', 'element']) {
      assert.equal(banned in props, false,
        `${name} 不该声明 "${banned}"：observation 已决定目标，多声明一个不生效的参数`
        + '就是"文档说能用实际必失败"，模型会误以为能凭它指定别的窗口/元素');
    }
    assert.equal('observation' in props, true, `${name} 必须声明 observation`);
    assert.ok(byName(list, name).parameters.required.includes('observation'));
  }
});

test('截图开关：默认关，且关着时如实报"用户的选择"而不是假装可用', async () => {
  const list = setup({ shotEnabled: false });
  const obs = await byName(list, 'x_desktop_tree').execute({});
  await assert.rejects(
    () => byName(list, 'x_desktop_shot').execute({ observation: obs.observation }),
    (e) => e.code === 'ACTION_UNAVAILABLE'
      // 三样必须都在：是谁关的、为什么关、以及不要绕过
      && /用户/.test(e.message) && /密码/.test(e.message) && /不要绕过/.test(e.message),
    '拒绝信息必须让模型能转述给用户，且明确禁止绕过',
  );
  // 默认值本身：必须是"关"。这里用 undefined 模拟"用户从没碰过这个设置"
  const bare = buildDesktopTools({ get: () => undefined, logger: { info() {}, warn() {} } },
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true });
  const o2 = await byName(bare, 'x_desktop_tree').execute({});
  await assert.rejects(
    () => byName(bare, 'x_desktop_shot').execute({ observation: o2.observation }),
    (e) => e.code === 'ACTION_UNAVAILABLE',
    '没配 desktopShotEnabled 时必须视为关（fail-closed），不能当成开',
  );
});

test('截图开关：关着时 degradedReason 不能还在推荐截图（否则就是"文档说能用实际必失败"）', async () => {
  const off = setup({ shotEnabled: false });
  const on = setup({ shotEnabled: true });
  const rOff = await byName(off, 'x_desktop_tree').execute({});
  const rOn = await byName(on, 'x_desktop_tree').execute({});
  assert.equal(rOff.degraded, true);
  assert.equal(rOn.degraded, true);
  assert.doesNotMatch(rOff.degradedReason, /x_desktop_shot 看图/,
    '截图关着时还让模型去截图 = 让它必然撞一次 ACTION_UNAVAILABLE');
  assert.match(rOff.degradedReason, /截图当前被用户关闭/);
  assert.match(rOff.degradedReason, /密码/, '必须把"为什么默认关"一并讲清，否则模型会去劝用户开');
  assert.match(rOff.degradedReason, /x_desktop_key/, '必须给出关着时仍然能走的路');
  assert.match(rOn.degradedReason, /x_desktop_shot/, '开关打开时才推荐截图');
});

test('截图开关：工具仍然注册（否则模型无法解释"为什么看不了"）', () => {
  const list = setup({ shotEnabled: false });
  assert.ok(byName(list, 'x_desktop_shot'),
    '开关关着时工具必须仍可见——不注册等于模型不知道有这条路径，'
    + '也就无法向用户解释，这是真正的「文档说能用实际必失败」');
});

test('x_desktop_shot：PrintWindow 失败/全黑时如实报错，不返回空图', async () => {
  const list = setup({ shotOk: false });
  const obs = await byName(list, 'x_desktop_tree').execute({});
  await assert.rejects(
    () => byName(list, 'x_desktop_shot').execute({ observation: obs.observation }),
    (e) => e.code === 'STALE_STATE' && /全黑/.test(e.message),
    '全黑帧不是"看到一个黑色的应用"，必须与截图失败区分开',
  );
});

test('x_desktop_shot：无 attachments 服务时如实报不可用（不静默返回空）', async () => {
  DesktopManager.prototype.runHelper = async function (c) {
    if (c === 'observe') return structuredClone(tree(13, 4));
    if (c === 'window_shot') return { imageBase64: JPEG.toString('base64'), bytes: JPEG.length, window: structuredClone(RECT.window) };
    throw new Error('stub ' + c);
  };
  const list = buildDesktopTools({ get: () => undefined, logger: { info() {}, warn() {} } },
    // 截图开关要开着，才轮到"没挂 attachments"成为真正的失败原因
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true, desktopShotEnabled: true });
  const obs = await byName(list, 'x_desktop_tree').execute({});
  await assert.rejects(
    () => byName(list, 'x_desktop_shot').execute({ observation: obs.observation }),
    (e) => e.code === 'ACTION_UNAVAILABLE' && /attachments/.test(e.message),
  );
});

// ───────────────────────── 3) x_desktop_click_at ─────────────────────────

test('x_desktop_click_at：窗口内坐标正确换算成屏幕坐标，且过物理门控', async () => {
  const list = setup();
  const obs = await byName(list, 'x_desktop_tree').execute({});
  globalThis.__CX_PHYSICAL__ = [];
  const r = await byName(list, 'x_desktop_click_at').execute(
    { observation: obs.observation, x: 840, y: 620, label: '提交' }, { agent: 'a' },
  );
  assert.equal(r.ok, true);
  // 窗口在 (336,139)，窗口内 (840,620) -> 屏幕 (1176, 759)
  assert.deepEqual(r.clickedAt, { screenX: 336 + 840, screenY: 139 + 620 });
  assert.deepEqual(flat(), ['assertIdle', 'activate:777', `click:${336 + 840},${139 + 620},left`]);
  assert.match(r.disturbance, /提交/, 'label 要出现在向用户明示的文案里');
  assert.match(r.disturbance, /精度低于语义动作/, '必须如实告知这是坐标兜底路径');
});

test('x_desktop_click_at：越界坐标被拒绝并说清是窗口内坐标而非屏幕坐标', async () => {
  const list = setup();
  const obs = await byName(list, 'x_desktop_tree').execute({});
  for (const [x, y] of [[-1, 10], [10, -1], [1965, 10], [10, 1106]]) {
    globalThis.__CX_PHYSICAL__ = [];
    await assert.rejects(
      () => byName(list, 'x_desktop_click_at').execute({ observation: obs.observation, x, y }, { agent: 'a' }),
      (e) => /超出窗口范围|窗口内坐标/.test(e.message),
      `(${x},${y}) 必须被拒`,
    );
    assert.deepEqual(flat(), [], '越界时一个物理调用都不该发生');
  }
});

test('x_desktop_click_at：树 degraded 时依然可用（这正是它存在的理由）', async () => {
  // 13 个元素的空壳窗口——x_desktop_mouse_click 在这里用不了（它需要元素矩形），
  // 而 click_at 不解析任何元素，所以它是唯一可用的点击路径。
  const list = setup();
  const obs = await byName(list, 'x_desktop_tree').execute({});
  assert.equal(obs.degraded, true);
  const el = obs.elementCount ? 1 : 0;
  // 证明 mouse_click 在这种情况下确实无路可走
  await assert.rejects(
    () => byName(list, 'x_desktop_mouse_click').execute({ observation: obs.observation, element: 999 }, { agent: 'a' }),
    (e) => e.code === 'ELEMENT_UNAVAILABLE',
    '树里没有该编号时 mouse_click 必须拒绝',
  );
  globalThis.__CX_PHYSICAL__ = [];
  const r = await byName(list, 'x_desktop_click_at').execute({ observation: obs.observation, x: 5, y: 5 }, { agent: 'a' });
  assert.equal(r.ok, true, 'click_at 不依赖元素，degraded 窗口照样能点');
  void el;
});

test('x_desktop_click_at：必须过物理门控（trustPhysicalInput 关掉时走审批）', async () => {
  DesktopManager.prototype.runHelper = async function (c) {
    if (c === 'observe') return structuredClone(tree(13, 4));
    if (c === 'window_rect') return structuredClone(RECT);
    throw new Error('stub ' + c);
  };
  let approvalCalls = 0;
  const list = buildDesktopTools(
    { get: (n) => (n === 'approval' ? { request: async () => { approvalCalls += 1; return 'rejected'; } } : undefined),
      logger: { info() {}, warn() {} } },
    // trustPhysicalInput 未开 -> 必须请求审批；审批拒绝 -> 必须拒绝，且一个物理调用都不发生
    { ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: false },
  );
  const obs = await byName(list, 'x_desktop_tree').execute({});
  globalThis.__CX_PHYSICAL__ = [];
  await assert.rejects(
    () => byName(list, 'x_desktop_click_at').execute({ observation: obs.observation, x: 5, y: 5 }, { agent: 'a' }),
    (e) => e.code === 'PERMISSION_DENIED',
  );
  assert.equal(approvalCalls, 1, '必须真的走审批（不能绕过）');
  assert.deepEqual(flat(), ['assertIdle'], '审批拒绝后不得前置窗口或点击');
});

// ───────────────────────── 4) 旗标功能确实已下线 ─────────────────────────

test('回归：代码里不再有任何写宿主/应用启动配置的东西', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const libRoot = join(HERE, '..', 'lib');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ps1)$/.test(e.name)) files.push(p);
    }
  };
  walk(libRoot);
  // 注意：只查"写启动配置"的能力，不查 CreateShortcut 本身——uia-helper.ps1 里
  // x_desktop_launch 需要**读** .lnk 来解析启动目标，那是既有且正当的功能。
  // 要禁止的是 link.Save()（写回 Arguments）与任何写宿主配置的路径。
  const banned = [
    'host-accessibility', 'host-shortcuts', 'hostAccessibility',
    'force-renderer-accessibility', 'SPI_SETSCREENREADER',
    '.Save()', 'Arguments =',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // 注释里可以提这些名字（解释为什么不做），代码里不行
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*#.*$/gm, '');
    for (const b of banned) {
      assert.equal(code.includes(b), false,
        `${f.replace(libRoot, 'lib')} 的代码里不应再出现 "${b}"（注释里提及历史决定是可以的）`);
    }
  }
  const exists = (rel) => { try { readFileSync(join(libRoot, rel)); return true; } catch { return false; } };
  assert.equal(exists('core/host-accessibility.js'), false, 'lib/core/host-accessibility.js 必须已删除');
  assert.equal(exists('host-shortcuts.ps1'), false, 'lib/host-shortcuts.ps1 必须已删除');
  void readdirSync;
});

test('回归：skill 文案教模型走兜底路径，且不再教它改启动配置', async () => {
  const { CONTROL_X_SKILL } = await import('../lib/skill.js');
  const c = CONTROL_X_SKILL.content;
  assert.match(c, /degraded/, '必须教模型识别 degraded');
  assert.match(c, /x_desktop_shot/, '必须点名截图工具');
  assert.match(c, /x_desktop_click_at/, '必须点名坐标工具');
  assert.match(c, /x_desktop_key/, '必须提到树空掉时键盘仍可用');
  assert.match(c, /不修改任何应用或宿主的启动配置/, '必须明确宣告不越界');
  assert.equal(/force-renderer-accessibility/.test(c), false, 'skill 不得再教用户加旗标');
  // 反向对照：这两条兜底路径都要有，否则模型只会一直撞墙
  assert.doesNotMatch(c.slice(0, c.indexOf('degraded')), /x_desktop_shot/, '前置段落不应混入兜底指引');
});

test('skill 不得让模型为「已经看到的截图」再多绕一次调用', async () => {
  // 2026-10-03 真机实测：豆包任务连拍 6 张 x_desktop_shot，全程**没调** x_vision_describe，
  // 直接看图就完成了任务——因为 x_desktop_shot 的返回自带 image block，进的是 Agent
  // 自己的上下文。而当时的 skill 文案把 x_vision_describe 写在前面、"或自己看图"写在
  // 后面，等于在教模型多花一次模型调用去换一个它已经能看到的东西。
  const { CONTROL_X_SKILL } = await import('../lib/skill.js');
  const c = CONTROL_X_SKILL.content;
  assert.match(c, /已经看得到|直接看图|不需要再调/,
    'skill 必须明确告诉模型：x_desktop_shot 的图片块已在上下文里，直接看');
  assert.match(c, /最后手段|只吃文本/,
    'x_vision_describe 必须被降级为「会话模型确实只吃文本时」的最后手段');
});

test('skill 不得写「网页任务一律走浏览器」——那会让「打开XX」一律开成网页', async () => {
  // 2026-10-03 真实走错：用户说「打开豆包」，Agent 按优先级阶梯里那句「网页任务一律在此层」
  // 直接去了 doubao.com，撞上登录拦截；用户说明「桌面豆包是正常登录态」才切回桌面端。
  const { CONTROL_X_SKILL } = await import('../lib/skill.js');
  const c = CONTROL_X_SKILL.content;
  assert.doesNotMatch(c, /网页任务一律/,
    '「一律」把「打开XX」这类不分网页/桌面的指令一律导向网页，必须改掉');
  assert.match(c, /先桌面后网页|先查桌面/,
    'skill 必须给出「先查桌面端」的明确顺序');
  assert.match(c, /人机识别|验证码/,
    '必须写明无头浏览器在登录/扫码/人机识别场景下必然失败，且要换桌面端而不是重试');
});
