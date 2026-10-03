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

/**
 * CHANGELOG 里所有版本标题，按出现顺序。
 *
 * ⚠️ 必须**先过滤成纯数字点分**再用——2026-10-03 踩过：原来用
 * `/^## (\S+?)\s*(?:（|\()/gm`，结果把「## 桌面与浏览器：两条路的事实（不给处方）」
 * 这类小节标题也当成版本抓了进来，于是「版本号必须是纯数字」那条测试对着一个中文
 * 小节名报错——**测试自己坏了，看起来像代码坏了**。
 * 现在只收「## 后面紧跟数字点分」的那种：不合版本形态的一律不是版本标题。
 */
const headings = [...changelog.matchAll(/^## (\d+(?:\.\d+)*)\s*(?:（|\()/gm)].map((m) => m[1]);

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

test('参数 schema 不得出现裸 {type:object}（没声明 properties = 没定义字段）', async () => {
  // 2026-10-03 真机压测（会话 DzjC8UU32GL7）暴露：x_vision_describe 的 attachment
  // 声明成裸 { type: 'object', required: true }，Agent 传引用时被参数校验拒绝，它反复
  // 撞这一条并自己下了判断——「这是工具的 bug。我换个调用方式」。**它判对了。**
  //
  // 之所以没被任何既有测试抓到，是因为宿主契约门只校验 output.schema
  // （scripts/host-contract-verify.mjs 的 hostGate），parameters 从来没被校验过。
  // 而裸 type:'object' 在严格模式的函数调用校验下等于"没有字段被定义"。
  const { buildVisionTools } = await import('../lib/vision/tools.js');
  const tools = buildVisionTools({ get: () => undefined }, { visionModel: '' }, { browserManager: null });
  const walk = (node, path, hits) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, hits)); return; }
    // 走到"某个对象的 schema 节点"：type 为 object 却既无 properties 也无 additionalProperties
    if (node.type === 'object' && node.properties === undefined
      && node.additionalProperties === undefined && !Array.isArray(node.required)) {
      hits.push(path);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, hits);
  };
  for (const tool of tools) {
    const hits = [];
    walk(tool.parameters, `${tool.name}.parameters`, hits);
    assert.deepEqual(hits, [],
      `${tool.name} 的参数里有裸 {type:'object'} 没声明 properties：${hits.join('、')}。`
      + '模型按 schema 生成调用参数，没声明 properties 等于"没有字段被定义"，'
      + '传实际字段会被校验拒绝——真机上已因此让 Agent 反复撞墙并绕路。');
  }
});

test('x_vision_describe 必须同时提到 x_browser_shot 与 x_desktop_shot', async () => {
  // 之前 description 只写「x_browser_shot 返回的 image 引用」，而 desktop 路径才是
  // degraded 场景下唯一的图片来源。描述漏了它等于把模型往错方向带。
  const { buildVisionTools } = await import('../lib/vision/tools.js');
  const tool = buildVisionTools({ get: () => undefined }, { visionModel: '' }, { browserManager: null })
    .find((t) => t.name === 'x_vision_describe');
  assert.ok(tool, 'x_vision_describe 必须存在');
  assert.match(tool.description, /x_browser_shot/, '必须提到浏览器截图来源');
  assert.match(tool.description, /x_desktop_shot/, '必须提到桌面截图来源——degraded 场景只有这一条');
  const att = tool.parameters.properties.attachment;
  for (const f of ['attachmentId', 'mediaType', 'bytes', 'width', 'height']) {
    assert.ok(att.properties?.[f], `attachment 必须声明 ${f}，否则模型不知道要传什么`);
  }
  assert.match(att.description, /原样|整个传/, '必须说明要原样整个传，否则模型会挑字段传');
});

test('x_vision_describe 不得把 attachment 对模型声明成必填（tab_id 是合法替代）', async () => {
  // 2026-10-03 实测：attachment 节点写了 `required: true`，toHostSchema 把它提升成
  // 宿主实际收到的 `parameters.required = ["attachment"]` —— 等于告诉模型"必须传 attachment"。
  // 两处事实证明它是错的：
  //   ① tab_id 捷径合法：session-32c83987 14:15:36 / 14:21:04 两次只传 tab_id 就成功返回；
  //   ② 工具自己还有第三条路（vision/tools.js execute：没 attachment 时自拍一张）。
  // 而且"必填 attachment"恰好把模型推向那条**会崩**的路径（见 p1-fixes 的门）。
  const { buildVisionTools } = await import('../lib/vision/tools.js');
  const tool = buildVisionTools({ get: () => undefined }, { visionModel: '' }, { browserManager: null })
    .find((t) => t.name === 'x_vision_describe');
  assert.deepEqual(tool.parameters.required ?? [], [],
    'attachment / tab_id / 自拍三选一，任何一个都不该被声明成必填；'
    + '声明成必填会让模型每次都走上 attachment 校验，而那正是真机上崩掉的那条');
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