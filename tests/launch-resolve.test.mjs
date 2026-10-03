/**
 * x_desktop_launch 名字解析门（2026-10-04）。
 *
 * 真机证据：0.5.32 的四个会话（M3 / space-bunny / deepseek-flash / mimo 四个不同模型）
 * **全部**在 `x_desktop_launch {"target":"豆包"}` 上撞 "The system cannot find the file
 * specified"，然后各自花 1~3 步自救（改进程名 / 翻开始菜单 / 解 lnk / 翻桌面）。
 * helper 此前只把 target 丢给 Start-Process，不查快捷方式、App Paths、PATH。
 *
 * 本文件用**注入的搜索目录**验证解析顺序，不依赖本机装了什么应用（可重复、可移植）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESOLVER = join(ROOT, 'lib', 'launch-resolve.ps1');
const HELPER = join(ROOT, 'lib', 'desktop', 'uia-helper.ps1');

/** 把命令用 UTF-16LE base64 传给 powershell——`-Command` 直传中文会被 PS5.1 按控制台
 *  代码页解码（实测：测试里的「豆包」「某应用」全变乱码，路径匹配一律失败）。 */
function psRun(command) {
  const b64 = Buffer.from(command, 'utf16le').toString('base64');
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: 30000, windowsHide: true });
}

/** 在临时目录里造一个快捷方式（WScript.Shell 是 Windows 自带 COM）。 */
async function makeShortcut(dir, lnkName, targetPath) {
  const ps = `$s=New-Object -ComObject WScript.Shell; $c=$s.CreateShortcut(${JSON.stringify(join(dir, lnkName))}); $c.TargetPath=${JSON.stringify(targetPath)}; $c.Save()`;
  await psRun(ps);
}

/** dot-source 解析器并调用一次，返回解析结果（或 null）。
 *  开头那句是**强制 UTF-8 输出**：不加的话 PS 用控制台代码页写 stdout，路径里的中文
 *  到 node 这边已是乱码，断言必然失败（与 uia-helper.ps1 强制 stdio UTF-8 同一个理由）。 */
async function resolve(target, opts = {}) {
  const dir = opts.dir ? `-SearchDirs @(${JSON.stringify(opts.dir)})` : '';
  const flags = [opts.noRegistry ? '-NoRegistry' : '', opts.noPath ? '-NoPath' : ''].filter(Boolean).join(' ');
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); `
    + `. '${RESOLVER.replace(/'/g, "''")}'; `
    + `$r = Resolve-CxLaunchTarget -Target ${JSON.stringify(target)} ${dir} ${flags}; `
    + `if ($null -eq $r) { Write-Output '<null>' } else { Write-Output $r }`;
  const { stdout } = await psRun(script);
  const out = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return out === '<null>' ? null : out;
}

test('按快捷方式文件名解析（真机四模型撞的就是这条）', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-launch-'));
  try {
    await makeShortcut(dir, '豆包.lnk', 'C:\\Windows\\System32\\notepad.exe');
    const hit = await resolve('豆包', { dir, noRegistry: true, noPath: true });
    assert.ok(hit, '按应用名必须能解析到开始菜单里的快捷方式');
    assert.match(hit.replace(/\//g, '\\'), /豆包\.lnk$/i, '应返回那个 .lnk 本身（Start-Process 能直接跑 .lnk）');

    // 带后缀也该认
    assert.ok(await resolve('豆包.lnk', { dir, noRegistry: true, noPath: true }), '带 .lnk 后缀也要能解析');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('按快捷方式**指向的 exe 名**解析（MiniMax-M3 那条自救路径）', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-launch-'));
  try {
    // 快捷方式叫「中文名」，但指向 Doubao.exe —— 传 "Doubao" 也必须找到
    await makeShortcut(dir, '某应用.lnk', 'C:\\Windows\\System32\\calc.exe');
    const hit = await resolve('calc', { dir, noRegistry: true, noPath: true });
    assert.ok(hit, '按目标 exe 名也要能找到快捷方式');
    assert.match(hit.replace(/\//g, '\\'), /某应用\.lnk$/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('已是存在的路径 → 直接原样返回', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-launch-'));
  try {
    const f = join(dir, 'thing.exe');
    writeFileSync(f, 'x');
    const hit = await resolve(f, { dir, noRegistry: true, noPath: true });
    assert.equal(hit, f, '路径存在时必须原样返回，不做多余查找');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('找不到 → 返回 null（由调用方给出"已尝试过哪里"的可自救报错）', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-launch-'));
  try {
    const hit = await resolve('cx-绝不可能存在的应用-xyz', { dir, noRegistry: true, noPath: true });
    assert.equal(hit, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PATH 兜底：系统自带命令能被解析（不开注册表/快捷方式也一样）', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-launch-'));
  try {
    const hit = await resolve('notepad.exe', { dir, noRegistry: true });
    assert.ok(hit, 'PATH 里的 exe 必须能解析到');
    assert.ok(existsSync(hit));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uia-helper 必须真的引入解析器并在 launch 里用它（源码门）', () => {
  const helper = readFileSync(HELPER, 'utf8');
  assert.match(helper, /launch-resolve\.ps1/,
    'uia-helper.ps1 必须 dot-source lib/launch-resolve.ps1——否则解析器写得再对也没人调');
  assert.match(helper, /Resolve-CxLaunchTarget/,
    'launch 分支必须调用 Resolve-CxLaunchTarget 做名字解析');
  const src = readFileSync(RESOLVER, 'utf8');
  assert.match(src, /Start Menu\\Programs/, '必须查开始菜单（用户 + 公共）');
  assert.match(src, /App Paths/, '必须查注册表 App Paths');
  assert.match(src, /Get-Command/, '必须有 PATH 兜底');
});
