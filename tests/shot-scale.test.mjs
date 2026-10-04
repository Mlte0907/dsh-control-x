/**
 * 0.5.35 的门：`max_edge` 是**长边上限**，不是整档除法。
 *
 * 缺陷证据（2026-10-04，三个真机会话 + 全量 24 张截图扫描）：
 *   lib/desktop/uia-helper.ps1:64
 *     scale = (int)Math.Ceiling(longEdge / (double)maxEdge)   ← 整数档！
 *   → 窗口 1296 宽、默认档 max_edge=1280：ceil(1.0125)=2 → 出 648×503，
 *     比"上限 1280"少掉 3/4 的像素——超出上限 16px，付出 4 倍代价。
 *   → 显式 max_edge=1100/1280 的 5 张请求同样落到 648（本该 1100×855 / 1280×995）。
 *   → 会话 88aa0eec 连吃 3 张半尺寸后，自己改传 max_edge=1296 才拿到清晰图——
 *     那是模型**摸索出来的绕法**，别的模型未必会。
 *
 * 两道门：
 *   A（确定性，不依赖桌面状态）：把 helper 里 Add-Type 编译的 C# 抽出来单独编译，
 *     直接调 XNative.Shot.ScaleSize，期望值按"等比贴上限"算死。
 *   B（真机全链路）：真的观察一个窗口、真的截，JPEG SOF 解出的宽必须 = srcW*maxEdge/longEdge。
 *     今天 1296 宽的窗配 600 → 432（=1296/3），期望 600 → 红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopManager } from '../lib/desktop/manager.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, '..', 'lib', 'desktop', 'uia-helper.ps1');

/** JPEG 尺寸：扫 SOF0-SOF15 段（不用第三方库，也别把门建在宿主的 attachments 上）。 */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

test('门A：C# 缩放函数必须"等比贴上限"（确定性，不依赖桌面上开着什么）', { skip: process.platform !== 'win32' }, async () => {
  const helper = readFileSync(HELPER, 'utf8');
  const m = helper.match(/\$src = @'([\s\S]*?)'@/);
  assert.ok(m, 'uia-helper.ps1 的 C# 块结构变了（$src = @' + "'" + '...' + "'" + '@）——本测试要跟着改，别删掉它');

  const dir = mkdtempSync(join(tmpdir(), 'cx-scale-'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } });

  const cs = join(dir, 'shot.cs');
  writeFileSync(cs, m[1], 'ascii'); // C# 块实测纯 ASCII（0.5.35 复核过）
  const probe = join(dir, 'probe.ps1');
  writeFileSync(probe, [
    "param([string]$Cs)",
    "$ErrorActionPreference = 'Stop'",
    "$src = Get-Content -Raw -Path $Cs",
    // 与 uia-helper.ps1:116 完全同款的编译方式（-ReferencedAssemblies 不能少）
    "Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.Drawing'",
    "$cases = @('1296,1007,600','1296,1007,1280','1296,1007,1100','1296,1007,1400','500,300,600','1296,1007,100','1296,1007,0')",
    'foreach ($c in $cases) {',
    '  $i = $c -split ","',
    '  $r = [XNative.Shot]::ScaleSize([int]$i[0], [int]$i[1], [int]$i[2])',
    '  Write-Output ($c + "=>" + $r[0] + "x" + $r[1])',
    '}',
    '',
  ].join('\r\n'), 'ascii');

  const { stdout } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', probe, '-Cs', cs,
  ], { timeout: 60000, windowsHide: true });

  const got = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf('=>');
    if (i > 0) got.set(line.slice(0, i).trim(), line.slice(i + 2).trim());
  }
  const expected = {
    '1296,1007,600': '600x466',    // 600 宽的窗配 600 → 贴上限
    '1296,1007,1280': '1280x995',  // 默认档：1296 宽的窗配 1280 → 1280（旧代码给 648！）
    '1296,1007,1100': '1100x855',  // 旧代码 ceil(1.18)=2 → 648
    '1296,1007,1400': '1296x1007', // 没超上限：原样
    '500,300,600': '500x300',      // 窗口比上限还小：原样
    '1296,1007,100': '100x78',     // 极小上限也要给出真实等比结果
    '1296,1007,0': '1296x1007',    // maxEdge<=0 视为不缩
  };
  for (const [k, want] of Object.entries(expected)) {
    assert.equal(got.get(k), want, `ScaleSize(${k}) 应为 ${want}，实际 ${got.get(k) ?? '(没返回)'}——max_edge 必须是上限，不是整档除法`);
  }
});

test('门B：真机链路——windowShot(max_edge=600) 出的图必须贴着 600 宽', { skip: process.platform !== 'win32' }, async () => {
  const mgr = new DesktopManager({ ttlMs: 60000, allowedApps: [], desktopShotEnabled: true });
  const listed = await mgr.listApps();
  const candidates = (listed.windows ?? []).filter((w) => w.title && Number.isFinite(Number(w.hwnd))).slice(0, 5);
  assert.ok(candidates.length > 0, '没找到可观察的顶层窗口——门B 至少需要一个有标题的窗口');

  let hit = null;
  let lastErr = null;
  for (const w of candidates) {
    try {
      const obs = await mgr.observe({ hwnd: Number(w.hwnd) });
      const r = await mgr.windowShot(obs.observation, { maxEdge: 600, quality: 70 });
      const size = jpegSize(r.buffer);
      const srcLong = Math.max(Number(r.window.width), Number(r.window.height));
      if (!size) { lastErr = new Error('JPEG 尺寸解不出来'); continue; }
      // 只接受"长边确实超过上限"的窗口，否则缩放分支根本不会被触发
      if (srcLong <= 600) { lastErr = new Error(`窗口 ${r.window.width}x${r.window.height} 太小，触发不了缩放`); continue; }
      hit = { r, size, srcLong };
      break;
    } catch (e) {
      lastErr = e; // PrintWindow 对个别窗口会返回空/全黑（helper 明确报 STALE_STATE）——换下一个窗口
    }
  }
  assert.ok(hit, `没能截到一个长边>600 的窗口：${lastErr?.message ?? '未知原因'}`);

  const { r, size, srcLong } = hit;
  const want = Math.round(Number(r.window.width) * 600 / srcLong);
  const oldIntegerDivisor = Math.round(Number(r.window.width) / Math.ceil(srcLong / 600));
  assert.equal(size.width, want,
    `源窗口 ${r.window.width}x${r.window.height}，max_edge=600 → 应为 ${want}px 宽（等比），实为 ${size.width}px`
    + `（整档除法会给 ${oldIntegerDivisor}px——这正是 0.5.35 要修的缺陷）`);
  assert.ok(size.width <= 600, `不得超过上限：${size.width} > 600`);
  assert.equal(size.height, Math.round(Number(r.window.height) * 600 / srcLong), '高也要等比');
});
