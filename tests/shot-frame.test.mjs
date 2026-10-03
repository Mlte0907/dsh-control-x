/**
 * 截图取景框（2026-10-03 用户提出）：截图时在目标窗口外缘闪一个框，
 * 告诉用户"刚截的是这里"。
 *
 * 为什么要做：截屏是**读用户的屏幕**，静默发生等于透明性缺口。用户观察到 Zcode 截图时
 * 会有焦点框闪一下（本机的 zcode computer-use 插件里查不到实现，它更可能来自客户端本体，
 * 所以这里按我们自己的事实来做，不声称复刻它）。
 *
 * 范围（用户 2026-10-03 拍板）：**只 x_desktop_shot，跟现有"允许窗口截图"开关走**
 * ——不新增设置项：开关关着时工具本身就会拒绝，取景框自然也不会出现。
 *
 * 关键约束（每条都是真机/设计事实）：
 * 1. **绝不 await**：提示是装饰，绝不能拖慢截图本身；画不出来就静默没有。
 * 2. 框画在目标矩形**外缘**（ps1 里 -Border 外扩），因此即使它在 BitBlt 进行时出现，
 *    也不会被截进图片里污染交付物。
 * 3. 独立短命进程、自毁式退出：与横幅浮窗解耦——横幅可以关、可以没起，取景框照常工作；
 *    反过来取景框挂了也不能影响横幅或截图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDesktopTools } from '../lib/desktop/tools.js';
import { createShotFlash } from '../lib/shot-frame.js';

const cfg = {
  ttlMs: 30000, allowedApps: [], physicalIdleMs: 0, trustPhysicalInput: true,
  desktopShotEnabled: true, bannerIdleExitMs: 120000,
};

const WINDOW = {
  pid: 20572, hwnd: 7277922, x: 1264, y: 228, width: 1296, height: 1007,
  title: '豆包', processName: 'Doubao', focused: true,
};

function makeCtx() {
  return {
    get: (n) => (n === 'attachments'
      ? { saveImage: async () => ({ attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1, name: 'a.jpg' }) }
      : undefined),
    logger: { info() {}, warn() {} },
  };
}

function makeManager() {
  return {
    observations: new Map([['obs1', { degraded: false }]]),
    windowShot: async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), window: { ...WINDOW } }),
  };
}

test('x_desktop_shot 必须触发取景框，且**不 await**（提示绝不能拖慢截图）', async () => {
  const seen = [];
  const list = buildDesktopTools(makeCtx(), cfg, {
    manager: makeManager(),
    // 永不 settle 的 promise：谁要是写了 await，这里会超时报错而不是静默通过
    shotFlash: (rect) => { seen.push(rect); return new Promise(() => {}); },
  });
  const tool = list.find((t) => t.name === 'x_desktop_shot');
  assert.ok(tool, 'x_desktop_shot 必须存在');

  const v = await Promise.race([
    tool.execute({ observation: 'obs1' }, {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('截图被取景框阻塞超过 3s——取景框必须 fire-and-forget')), 3000)),
  ]);

  assert.equal(v.ok, true, '取景框永不返回也不能挡住截图结果');
  assert.equal(seen.length, 1, '截图成功后必须触发一次取景框');
  assert.deepEqual(seen[0], WINDOW, '必须把 shot 返回的 window 矩形原样交出去（坐标由 ps1 外扩）');
  assert.equal(v.window.width, 1296, '返回值不受取景框影响');
});

test('截图开关关着时：工具拒绝，取景框一次都不许触发', async () => {
  let flashed = 0;
  const list = buildDesktopTools(makeCtx(), { ...cfg, desktopShotEnabled: false }, {
    manager: makeManager(),
    shotFlash: () => { flashed += 1; },
  });
  const tool = list.find((t) => t.name === 'x_desktop_shot');
  await assert.rejects(() => tool.execute({ observation: 'obs1' }, {}), (e) => e.code === 'ACTION_UNAVAILABLE');
  assert.equal(flashed, 0, '用户关掉截图 = 既没图也没提示');
});

test('shot-frame.ps1 真跑一次必须 exit 0（语法门查不出运行时错：New-Object 里带算术就是一例）', { skip: process.platform !== 'win32' }, async () => {
  // 2026-10-03：本文件第一版就撞在 `New-Object Type($a, $b - $c, ...)` 上——
  // 官方 Parser 全绿、真跑立刻抛 "因为 [System.Object[]] 没有名为 op_Subtraction 的方法"。
  // Parser 门只管语法，这道门管"跑得起来"。框只在左上角闪 120x80 一小块 80ms。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const script = new URL('../lib/shot-frame.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const { stdout, stderr } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', script,
    '-X', '60', '-Y', '60', '-W', '160', '-H', '100', '-Ms', '80',
  ], { timeout: 20000, windowsHide: true });
  assert.equal(stderr.trim(), '', `stderr 非空（脚本内部报错）：${stderr}`);
  assert.equal(stdout.trim(), '', `stdout 非空：${stdout}`);
});

test('shot-frame.ps1 必须贴合目标窗口且更温和（用户 2026-10-04 实测反馈）', () => {
  // 用户原话：「蓝了，然后好像比豆包的框大了一点，闪了一下，能更优雅一点么？温和一点。」
  // "大了一点" 的来源就是我原先的**向外外扩 4px**；捕获在 shotFlash 触发**之前**就已完成，
  // 所以现在可以贴着窗口画，不必再为"别截进图里"而外扩。
  const src = readFileSync(new URL('../lib/shot-frame.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\$script:Left\s*=\s*\$X\s*-/,
    '不得再向外外扩——那正是"比窗口大了一点"的来源');
  assert.match(src, /\$script:Left\s*=\s*\$X\b/, '框必须贴在窗口左上角');
  assert.match(src, /\$script:Width\s*=\s*\$W\b/, '宽度必须等于窗口宽度（不加边）');
  assert.match(src, /\[int\]\$Thickness = 2/, '线宽 2px：4px 太重，用户要"温和"');
  assert.match(src, /\[int\]\$Hold = 120/, '先停 120ms 再淡出：一上来就衰减会显得"闪一下"很生硬');
  assert.match(src, /\[int\]\$Ms = 420/, '总时长 420ms：350ms 偏急');
});

test('createShotFlash：同步 spawn、参数正确、失败静默不外抛', () => {
  const calls = [];
  const flash = createShotFlash({
    env: {},
    spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {}, on() {} }; },
  });

  assert.equal(flash({ x: -10, y: 20, width: 100, height: 50 }), true, '副屏负坐标必须允许');
  assert.equal(calls.length, 1, '必须同步发出（fire-and-forget），不能等任何回调');
  const a = calls[0].args;
  for (const flag of ['-X', '-Y', '-W', '-H']) assert.ok(a.includes(flag), `缺少 ${flag}`);
  assert.equal(a[a.indexOf('-X') + 1], '-10');
  assert.equal(a[a.indexOf('-W') + 1], '100');
  assert.ok(a.some((s) => /shot-frame\.ps1$/.test(s)), '必须指向 lib/shot-frame.ps1');
  assert.equal(calls[0].opts.stdio, 'ignore', '提示进程不该占用 stdio');

  // 非法矩形：不发进程
  const noSpawn = createShotFlash({ spawnImpl: () => { throw new Error('不该被调用'); } });
  assert.equal(noSpawn(null), false);
  assert.equal(noSpawn({ x: 0, y: 0, width: 0, height: 50 }), false);
  assert.equal(noSpawn({ x: NaN, y: 0, width: 10, height: 10 }), false);

  // spawn 本身抛错：静默 false，绝不往外抛（装饰失败不能影响截图）
  const boom = createShotFlash({ spawnImpl: () => { throw new Error('spawn 失败'); } });
  assert.equal(boom({ x: 0, y: 0, width: 10, height: 10 }), false);
});
