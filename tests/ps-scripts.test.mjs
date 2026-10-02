/**
 * PowerShell 脚本语法门：lib 下每个 .ps1 必须通过官方 Parser 解析（0 错误）且带 UTF-8 BOM。
 *
 * 背景（2026-10-02 血泪）：0.5.14 在 uia-helper.ps1 的 throw 里用了「字符串 + 换行 + 字符串」
 * 的续接写法——PS 5.1 方法调用参数列表内换行等于参数列表结束，整个脚本解析失败，
 * 桌面层全部工具瘫痪，而仓库内没有任何测试解析 .ps1，连发两版无人察觉，直到真机验收。
 * 本文件就是那道一直缺的门。注意 node --check 只管 .js，管不了 .ps1。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

function listPs1(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPs1(full));
    else if (entry.name.toLowerCase().endsWith('.ps1')) out.push(full);
  }
  return out;
}

test('lib 下每个 .ps1 编码无歧义：带 UTF-8 BOM，或整个文件纯 ASCII（含中文必须带 BOM）', () => {
  for (const file of listPs1(libDir)) {
    const b = readFileSync(file);
    const hasBom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    const asciiOnly = b.every((x) => x < 0x80);
    assert.ok(hasBom || asciiOnly, `${file} 含非 ASCII 字节但没有 UTF-8 BOM（PS 5.1 会按 ANSI 读，中文必乱码）`);
  }
});

test('lib 下每个 .ps1 通过官方 Parser 解析（0 错误）', { skip: process.platform !== 'win32' }, async () => {
  const files = listPs1(libDir);
  assert.ok(files.length >= 2, '至少应覆盖 uia-helper.ps1 与 host-shortcuts.ps1');
  for (const file of files) {
    // 解析即完整语法检查，不执行任何语句（脚本本体是 stdin 死循环，不能真跑）。
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$t=$null;$e=$null;` +
      `[System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$t,[ref]$e)|Out-Null;` +
      `if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output ("{0}:{1} {2}" -f $_.Extent.StartLineNumber,$_.Extent.StartColumnNumber,$_.Message) }; exit 1 } else { Write-Output OK }`,
    ], { timeout: 30000, windowsHide: true });
    assert.match(stdout.trim(), /^OK/, `${file} 存在语法错误：${stdout}`);
  }
});
