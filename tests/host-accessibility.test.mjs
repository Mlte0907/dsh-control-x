/**
 * 宿主无障碍旗标：设置页「桌面观察」开关的后端。
 * - PS 集成测试（仅 Windows）：真跑 host-shortcuts.ps1，对临时目录里的假快捷方式
 *   做 detect → patch → restore 全循环，验证只动旗标、不动其他 Arguments。
 * - watch 路由测试：GET 只读转发、POST 开关转发、缺控制器与非法入参的如实报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHostAccessibilityController, shortcutDirs } from '../lib/core/host-accessibility.js';
import { WatchServer } from '../lib/browser/watch.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

test('shortcutDirs：覆盖开始菜单/桌面/任务栏固定，且过滤空段', () => {
  const dirs = shortcutDirs({ APPDATA: 'C:\\u\\AppData\\Roaming', ProgramData: 'C:\\PD', PUBLIC: 'C:\\Public' }, 'C:\\u');
  assert.equal(dirs.length, 5);
  assert.ok(dirs.every((d) => !d.includes('\\\\') && !d.endsWith('\\')), '不允许空段拼出的怪路径');
});

test('host-shortcuts.ps1：detect → patch → restore 全循环，只动旗标不动其他参数', { skip: !isWin }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cx-host-a11y-'));
  try {
    // 造一个指向 node.exe 的假快捷方式，带既有参数——验证 patch/restore 只增删旗标本身。
    const lnk = join(tmp, 'host.lnk');
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');`
      + `$s.TargetPath='${process.execPath}';$s.Arguments='--foo bar';$s.Save()`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps]);

    const ctl = createHostAccessibilityController({ dirs: [tmp], exePath: process.execPath });

    const d0 = await ctl.detect();
    assert.equal(d0.ok, true);
    assert.equal(d0.shortcuts.length, 1, '按 exe 全路径命中快捷方式');
    assert.equal(d0.shortcuts[0].patched, false, '初始不带旗标');

    const on = await ctl.set(true);
    assert.equal(on.shortcuts[0].patched, true);
    assert.match(on.shortcuts[0].args, /--force-renderer-accessibility/);
    assert.match(on.shortcuts[0].args, /--foo bar/, '既有参数必须原样保留');
    assert.equal(on.restartRequired, true, '改的是启动方式，必须提示重启');
    assert.equal((await ctl.detect()).shortcuts[0].patched, true, 'patch 结果可被 detect 读回');

    const off = await ctl.set(false);
    assert.equal(off.shortcuts[0].patched, false);
    assert.doesNotMatch(off.shortcuts[0].args, /force-renderer-accessibility/);
    assert.equal(off.shortcuts[0].args.trim(), '--foo bar', '还原后其他参数一字不动');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('host-accessibility：非 Windows 平台如实报不可用，不假装成功', async () => {
  const ctl = createHostAccessibilityController({ platform: 'linux' });
  const r = await ctl.detect();
  assert.equal(r.available, false);
  assert.match(r.error, /仅 Windows/);
});

test('watch 路由：GET/POST /host-accessibility 转发控制器，缺控制器与非法入参如实报错', async () => {
  const calls = [];
  const fake = {
    detect: async () => { calls.push('detect'); return { ok: true, shortcuts: [{ path: 'a.lnk', patched: true }], errors: [] }; },
    set: async (enabled) => { calls.push(`set:${enabled}`); return { ok: true, shortcuts: [], errors: [] }; },
  };
  const ws = new WatchServer({}, () => {}, null, null, null, null, fake);
  let route = null;
  ws.attach({ register: (r) => { route = r; } });
  function fakeRes() {
    return { headersSent: false, status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  }
  async function request(method, path, body) {
    const res = fakeRes();
    const payload = body === undefined ? '' : JSON.stringify(body);
    await route.handler({
      method, url: 'http://local/api/x-control' + path, on() {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload; },
    }, res);
    return res;
  }

  const got = JSON.parse((await request('GET', '/host-accessibility')).body);
  assert.equal(got.available, true);
  assert.equal(got.shortcuts.length, 1);
  await request('POST', '/host-accessibility', { enabled: true });
  await request('POST', '/host-accessibility', { enabled: false });
  const bad = JSON.parse((await request('POST', '/host-accessibility', { enabled: 'yes' })).body);
  assert.equal(bad.error !== undefined, true, '非布尔 enabled 报错');

  const bare = new WatchServer({});
  let route2 = null;
  bare.attach({ register: (r) => { route2 = r; } });
  const res = fakeRes();
  await route2.handler({ method: 'GET', url: 'http://local/api/x-control/host-accessibility', on() {} }, res);
  const off = JSON.parse(res.body);
  assert.equal(off.available, false, '缺控制器时不能假装可用');
  assert.deepEqual(calls, ['detect', 'set:true', 'set:false']);
});
