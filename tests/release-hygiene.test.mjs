/**
 * 发布卫生门（2026-10-03 加）。
 *
 * 为什么要有这个门：**本项目已经两次栽在「发布状态不自洽」上，而且两次都是静默的。**
 *
 *   ① 0.5.5：插件市场在 0.5.5 上静默卡住——用户点「更新并重启」后 profile 的 pin 与盘上
 *      版本都还停在 0.5.5，市场日志里连一条 0.5.6 都没有。
 *   ② 0.5.21：写完 CHANGELOG 忘了改 package.json 的 version。因为自更新的 REF='main'
 *      直接读远端 package.json，compareVersions('0.5.20','0.5.20') 返回 0，
 *      面板于是显示「已是最新」——**修复永远送不到用户手上，且没有任何报错**。
 *
 * 这类问题的共同点：代码是对的、测试是绿的、发出去也"成功"了，只有用户拿不到。
 * 所以它必须是**测试失败**，而不是等用户撞。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const pkgVersion = readJson('package.json').version;
const manifestVersion = readJson('dsh-plugin.json').version;
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

/** CHANGELOG 里所有 `## x.y.z（日期）` 标题，按出现顺序。 */
const headings = [...changelog.matchAll(/^## (\S+?)\s*(?:（|\()/gm)].map((m) => m[1]);

test('package.json 与 dsh-plugin.json 的版本必须一致', () => {
  assert.equal(manifestVersion, pkgVersion,
    `dsh-plugin.json 是 ${manifestVersion} 而 package.json 是 ${pkgVersion}：`
    + '宿主认前者、自更新读后者，不一致会出现"面板说一个版本、更新读另一个版本"');
});

test('CHANGELOG 最新一节必须就是当前版本', () => {
  assert.ok(headings.length > 0, 'CHANGELOG 一节都没有');
  assert.equal(headings[0], pkgVersion,
    `CHANGELOG 最新是 ${headings[0]} 而盘上是 ${pkgVersion}。`
    + '**这类不一致是静默的**：自更新 REF=main 直接读远端 package.json，'
    + '版本相等时 compareVersions 返回 0、面板显示"已是最新"，'
    + '于是新代码永远送不到用户手上且不报错。');
});

test('版本号必须是纯数字点分——字母后缀会被 compareVersions 塌成同一个数', () => {
  // lib/core/updater.js 的 compareVersions 按 '-' 切预发布后缀，剩下按 '.' 取
  // parseInt：parseInt('20b') === 20。所以 "0.5.20b" 与 "0.5.20" 比较结果相等。
  for (const v of [pkgVersion, manifestVersion, ...headings]) {
    assert.match(v, /^\d+(\.\d+)*$/,
      `版本 "${v}" 必须是纯数字点分。像 0.5.20b 这种字母后缀在 compareVersions 里`
      + '会和 0.5.20 判为相等，等于隐形——用它发版等于没发。');
  }
});

test('CHANGELOG 版本序列必须唯一且严格递减（新版本在最前）', () => {
  const seen = new Map();
  for (const v of headings) seen.set(v, (seen.get(v) ?? 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([v]) => v);
  assert.deepEqual(dup, [], `CHANGELOG 里这些版本各出现多次：${dup.join('、')}`);

  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  for (let i = 1; i < headings.length; i += 1) {
    assert.ok(cmp(headings[i - 1], headings[i]) > 0,
      `CHANGELOG 版本顺序不对：${headings[i - 1]} 之后是 ${headings[i]}，`
      + '必须新版本在最前、严格递减');
  }
});

test('compareVersions 必须把 0.5.20b 与 0.5.20 判为相等（钉住上面那条推断）', async () => {
  const { compareVersions } = await import('../lib/core/updater.js');
  // 这条测试的用意是**提醒**：一旦哪天有人"改进"了 compareVersions 让它认字母后缀，
  // 上面那条禁止字母后缀的理由就不成立了——那时可以放开，但要有意识地改。
  assert.equal(compareVersions('0.5.20b', '0.5.20'), 0,
    'compareVersions 仍然把字母后缀塌成同一个版本（这是禁止字母后缀的原因）');
  assert.equal(compareVersions('0.5.21', '0.5.20'), 1, '正常递增必须能被认出来');
  assert.equal(compareVersions('0.5.20', '0.5.21'), -1);
});

test('改了 lib/ 就必须同时改过版本号（补上"文件自洽"查不出的那道门）', async () => {
  // 上面所有测试查的都是**文件之间是否自洽**（两个 json 一致、CHANGELOG 对得上）。
  // 但真正咬过人的第三种形态是：**代码改了、CHANGELOG 也写了、唯独版本号没动**——
  // 文件之间依然自洽（两个 json 都停在同一个旧版本），所以上面全绿，
  // 而自更新 REF='main' 读到的还是旧版本号 compareVersions 返回 0，
  // 面板显示"已是最新"，**新代码永远送不到用户手上**。
  //
  // 2026-10-03 已发生两次（0.5.20 一次、b2c6477/7268e77 又一次）。这道门用 git 历史判定：
  // 最后一次改动 lib/ 的提交，必须被"最后一次改动版本号"的提交包含进去。
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => {
    try {
      return execFileSync('git', args, {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; } // 不是 git 仓库 / 没装 git -> 跳过
  };
  if (git('rev-parse', '--git-dir') === null) {
    return; // 非 git 环境，本门不适用
  }
  const lastLib = git('log', '-1', '--format=%H', '--', 'lib');
  const lastVersion = git('log', '-1', '--format=%H', '--', 'package.json', 'dsh-plugin.json');
  if (!lastLib || !lastVersion) return;

  const covered = git('merge-base', '--is-ancestor', lastLib, lastVersion) === '';
  assert.equal(covered, true,
    `lib/ 最后一次改动是 ${lastLib.slice(0, 8)}，而版本号最后一次改动是 ${lastVersion.slice(0, 8)}：`
    + '代码改动没被任何一次版本号改动覆盖。自更新读的是远端 package.json 的 version，'
    + '版本没变 -> compareVersions 返回 0 -> 面板显示"已是最新" -> 用户拿不到这些代码。'
    + '本项目已被这个形态咬过三次（0.5.5 市场卡住、0.5.20、b2c6477/7268e77）。');
});