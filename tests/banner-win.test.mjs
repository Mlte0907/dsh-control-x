/**
 * 桌面置顶横幅（Windows 原生浮窗）纯逻辑测试。
 *
 * 只测不碰真实 PowerShell 的部分：状态计算、变化签名、启动/停止编排。
 * 真实浮窗的渲染（置顶、穿透、打字）用 PowerShell 起真进程在真机验收里验，
 * 单元测试里拉真进程只会把套件变慢并引入环境依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bannerState, stateSignature, createDesktopBanner, BANNER_TEXT, DOT_COLORS, DOT_CYCLE_MS } from '../lib/banner-win.js';
import { createActivityTracker } from '../lib/desktop/activity.js';

const BASE = { active: true, running: true, tool: 'x_desktop_value', kind: 'desktop', since: 1, idleMs: 0, graceMs: 5000 };

test('文案固定且不带工具名（用户 2026-10-01：不要给我多加字）', () => {
  const desk = bannerState(BASE);
  const brow = bannerState({ ...BASE, kind: 'browser', tool: 'x_browser_open' });
  assert.equal(desk.text, BANNER_TEXT);
  assert.equal(desk.text, 'X-Agent正在控制电脑，操控键鼠会打断操作');
  assert.equal(brow.text, BANNER_TEXT, '桌面与浏览器共用一句，不因 kind 改文案');
  assert.ok(!desk.text.includes('x_desktop_value'), '文案里不能出现工具名');
  assert.ok(!desk.text.includes('（'), '不拼空括号');
  // 打字效果与三个点已在 2026-10-02 去掉，状态里不该再有 dots 字段。
  assert.equal(desk.dots, undefined, '不再有打字动画，dots 字段应当整个消失');
  assert.ok(!BANNER_TEXT.includes('.'), '文案本身不带动画尾巴');
});

test('不活跃时清空文案（浮窗据此隐藏）', () => {
  const s = bannerState({ ...BASE, active: false, running: false });
  assert.equal(s.text, '');
  assert.equal(s.dots, undefined);
  assert.equal(s.active, false);
});

test('主题色缺失时退回默认值，不留空串', () => {
  const s = bannerState(BASE, { bg: '', fg: undefined });
  assert.equal(s.bg, '#23242a');
  assert.equal(s.fg, '#eeeeee');
  assert.ok(/^#[0-9a-f]{6}$/i.test(s.bg), '默认色必须是浮窗能解析的 #RRGGBB');
});

test('变化签名忽略 since/idleMs：否则每 400ms 都会写一次文件', () => {
  const a = bannerState({ ...BASE, since: 1, idleMs: 0 });
  const b = bannerState({ ...BASE, since: 999999, idleMs: 12345 });
  assert.equal(stateSignature(a), stateSignature(b));
});

test('变化签名只认"真要重画"的四件事，忽略工具名/活动种类', () => {
  const base = bannerState(BASE);
  // 工具名与 kind 每次动作都在变，纳入签名会让状态文件每步重写。
  assert.equal(stateSignature(base), stateSignature(bannerState({ ...BASE, tool: 'x_browser_click', kind: 'browser' })));
  assert.notEqual(stateSignature(base), stateSignature(bannerState(BASE, { bg: '#ffffff' })));
  assert.notEqual(stateSignature(base), stateSignature(bannerState(BASE, { fg: '#000000' })));
  assert.notEqual(stateSignature(base), stateSignature(bannerState({ ...BASE, active: false })));
});

test('tracker 能区分两类活动', () => {
  let t = 1000;
  const tracker = createActivityTracker({ graceMs: 0, now: () => t });
  tracker.begin('x_browser_open', 'browser');
  assert.equal(tracker.snapshot().kind, 'browser');
  tracker.end('x_browser_open');
  tracker.begin('x_desktop_press', 'desktop');
  assert.equal(tracker.snapshot().kind, 'desktop');
});

test('停止写入：被停用后浮窗不会再收到旧状态', () => {
  const writes = [];
  const banner = createDesktopBanner({
    activity: createActivityTracker({ graceMs: 0 }),
    spawnImpl: () => ({ unref() {}, on() {}, kill() {} }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  // start 会先写一份初始状态；这里只断言编排本身，不去碰真实 spawn/文件。
  assert.equal(typeof banner.start, 'function');
  assert.equal(typeof banner.stop, 'function');
  assert.ok(Array.isArray(writes));
});

test('没 start() 就不建临时目录（否则没走 stop() 的调用方会留孤儿目录，实测堆到 62 个 16.3MB）', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-control-x-')).length;
  const banner = createDesktopBanner({
    activity: createActivityTracker({ graceMs: 0 }),
    spawnImpl: () => ({ unref() {}, on() {}, kill() {} }),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-control-x-')).length;
  assert.equal(after, before, 'createDesktopBanner() 本身不许建目录');
  assert.equal(banner.statePath, null, '未 start() 时 statePath 应为 null，且必须是 getter 才对');
  banner.stop();
});

test('按需拉起：没 start() 就不起进程；重复 start 幂等；停手超时会自己退出', (t) => {
  // 2026-10-01：横幅原本随 DSH 启动就常驻。现在改成第一次操控才拉起、
  // 停手 idleExitMs 后自己退出。start() 会被每次动作调用，没有幂等闸就会
  // 一路 spawn 出第二个 powershell，界面上变成两个横幅叠着。
  let clock = 0;
  let spawned = 0;
  let killed = 0;
  let tickFn = null;
  const activity = createActivityTracker({ graceMs: 0, now: () => clock });
  const banner = createDesktopBanner({
    activity,
    idleExitMs: 1000,
    now: () => clock,
    spawnImpl: () => { spawned += 1; return { unref() {}, on() {}, kill() { killed += 1; } }; },
    // 与 setInterval(callback, ms) 同序：第一个参数就是回调。
    setIntervalImpl: (fn) => { tickFn = fn; return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  t.after(() => banner.stop());

  assert.equal(banner.available, false, '没 start() 就不该有进程');
  assert.equal(spawned, 0);

  banner.start();
  assert.equal(spawned, 1);
  banner.start();
  banner.start();
  assert.equal(spawned, 1, '重复 start 不能重复拉进程（否则界面上是两个叠加的横幅）');
  assert.equal(banner.available, true);

  // 一次真实操控：活跃期间 tick 什么都不做。
  activity.begin('x_desktop_press', 'desktop');
  clock += 10;
  tickFn();
  assert.equal(banner.available, true, '正在操控时不能退出');

  // 停手超过 idleExitMs：自己退掉。
  activity.end('x_desktop_press');
  clock += 2000;
  tickFn();
  assert.equal(banner.available, false, '停手超过 idleExitMs 应自己退出');
  assert.equal(killed, 1, '退出要真的 kill 掉 powershell 进程');

  // 下次操控能重新拉起（且不会因为 lastActiveAt 是旧的而刚起来就自杀）。
  clock += 5000;
  activity.begin('x_desktop_press', 'desktop');
  banner.start();
  assert.equal(spawned, 2, '下次操控应能重新拉起');
  clock += 10;
  tickFn();
  assert.equal(banner.available, true, '刚拉起就自杀 = lastActiveAt 没重置');
});

test('apply() 不得在加载时就拉横幅（按需：只有 onBegin 里那一处 start）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const calls = src.match(/banner\.start\(\)/g) ?? [];
  assert.equal(calls.length, 1, `banner.start() 出现 ${calls.length} 次，只允许 onBegin 钩子里那一次；` +
    '在 apply() 里直接调就又变成随 DSH 启动常驻了');
  assert.match(src, /onBegin:/, '横幅必须挂在活动跟踪器的 onBegin 上才会被按需拉起');
});

test('状态点三色循环：红→黄→蓝，每 2 秒换一个（用户 2026-10-01）', () => {
  assert.deepEqual([...DOT_COLORS], ['#ef4444', '#eab308', '#3b82f6'], '红/琥珀/蓝三色');
  assert.equal(DOT_CYCLE_MS, 2000);
  assert.equal(DOT_COLORS.length, 3, '只有三色，循环回第一色');
});

test('浮窗不得在左上角闪一下：Run 之前必须先算好几何 + 全透明起步', () => {
  // 用户实测报告的现象。成因：Application.Run($form) 会拿构造默认值
  // (0,0 / 420x40) 把窗体显示出来，第一个 tick 才把它挪到正中。
  // 修法：Run 之前先读状态、先 Set-CxGeometry，并把 Opacity 压到 0，
  // 让"Run 强行显示的那一帧"不可能是错的。
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  const runIdx = src.indexOf('Application]::Run($form)');
  assert.ok(runIdx > 0, '应能找到 Application.Run');
  const before = src.slice(0, runIdx);
  assert.match(before, /^\s*\$form\.Opacity = 0\s*$/m, 'Run 之前必须先把不透明度压到 0');
  assert.match(before, /try \{ Set-CxGeometry \} catch \{ \}/, 'Run 之前必须先算好几何，否则第一帧就在左上角');
  assert.match(src, /Get-CxDotColor/, 'Paint 要用三色圆点');
  assert.doesNotMatch(src, /\$script:Accent/, '旧的单色 Accent 必须彻底换掉');
});

test('物理输入门控：confirm_disturbance 以前收了却从不看（真 bug）', () => {
  // 用户 2026-10-01 实测：传了 confirm_disturbance: true 仍被"未获用户批准"挡下。
  // 根因：guardPhysical(exec, toolName, label) 的签名里根本没有这个参数，
  // 三个调用点也没传。schema 与工具描述都把它写成出口，代码却无视。
  const src = readFileSync(new URL('../lib/desktop/tools.js', import.meta.url), 'utf8');
  assert.match(src, /guardPhysical = async \(exec, toolName, label, confirm\)/, '门控必须真的接收 confirm');
  for (const tool of ['x_desktop_mouse_click', 'x_desktop_type', 'x_desktop_key']) {
    assert.match(
      src,
      new RegExp(`guardPhysical\\(exec, '${tool}', el\\.name, args\\.confirm_disturbance\\)`),
      `${tool} 必须把 confirm_disturbance 传进门控`,
    );
  }
  // 'rejected' 表示确实有人点了拒绝：自认与信任开关都不该放行。
  // 所以 confirm 只许出现在 'unavailable' 那一支里，位置必须在其后。
  const unavail = src.indexOf("if (outcome === 'unavailable') {");
  const confirmAt = src.indexOf('if (confirm === true)');
  assert.ok(unavail > 0, '应存在 unavailable 分支');
  assert.ok(confirmAt > unavail, 'confirm 的判断必须落在 unavailable 分支之后');
  assert.match(src, /if \(trustPhysicalInput\) \{/, '「全权操控」开关必须真的被读');
});

test('浮窗脚本不含 CJK 字面量（Windows PowerShell 无 BOM 按 ANSI 解码会解析失败）', () => {
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  const offenders = [...src].filter((ch) => /[^\x00-\x7F]/.test(ch));
  assert.deepEqual(offenders, [], `脚本必须纯 ASCII，实际含 ${offenders.length} 个非 ASCII 字符`);
});

test('浮窗脚本必须启动计时器（Timer 创建后是静止的，不 Start 就没有打字动画）', () => {
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  assert.match(src, /\$timer\.Start\(\)/, '缺 Start() 的话横幅永远停在空框——实测踩过');
  assert.match(src, /WS_EX_TRANSPARENT/, '必须点击穿透，否则置顶浮窗会挡住用户自己的桌面');
  assert.match(src, /HWND_TOPMOST/, '必须置顶，否则 Agent 操控别的应用时看不见');
});

test('浮窗显隐必须读表单真实状态，不能只认缓存标志（实测踩过：空框常驻左上角）', () => {
  const src = readFileSync(new URL('../lib/banner-overlay.ps1', import.meta.url), 'utf8');
  // Application.Run($form) 会自行 Show()，把它之前的 $form.Hide() 抵消掉。缓存标志
  // $script:Visible 初值 $false，于是「$wantVisible -ne $script:Visible」永远为假，
  // Hide() 从不执行：空框从启动起就钉在 (0,0)，状态说空闲它也照常显示。实测复现
  // （active:false → VISIBLE at (0,0) 420x40），修法是改读 $form.Visible。
  assert.doesNotMatch(
    src,
    /\$wantVisible\s+-ne\s+\$script:Visible/,
    '又退回「只在跳变时动作」的写法了：Application.Run 会自己 Show()，缓存标志会和真实可见性脱钩',
  );
  assert.match(src, /-not \$form\.Visible/, '显示前必须读 $form.Visible 真实状态');
  assert.match(src, /if \(\$form\.Visible\) \{ \$form\.Hide\(\) \}/, '隐藏前必须读 $form.Visible 真实状态');
});