/**
 * 宿主 CSS 变量名核对门（2026-10-03 加）。
 *
 * 为什么必须有：桌面横幅主题色连续两次翻车，两次都**静默**，而且都不是逻辑错——是**变量名错**：
 *   ① 0.5.30 之前：客户端读 `--dsw-alias-bg-elevated`，而宿主从没定义过它（app.asar 里共
 *      107 个 `--dsw-alias-*`，没有这一个）→ `bg` 永远是空串 → 浮窗底色永远停在默认深色，
 *      用户看到的只是「横幅不随宿主主题变化」，没有任何报错；
 *   ② 0.5.30 修了 rgb()→#RRGGBB 折算（fg 确实因此活了），但那个 bg 变量名**依然不存在**，
 *      所以现象一模一样。真机上是靠 `GET /api/x-control/activity → theme.bg === ""` 才看穿的。
 *
 * 变量名只有宿主本体能裁决，所以这道门直接扫 app.asar：
 *   1. 从 app.asar 收集所有形如 `--xxx:` 的**定义**；
 *   2. 从 lib/client.js 收集所有**代码里**引用的 `--dsw-*`（注释行丢掉——案底要留在注释里，
 *      但不能让案底把门判红）；
 *   3. 引用的名字只要有一个不在定义集里 → 失败并点名。
 *
 * 用法：npm run verify:host-css    （DHCX_ASAR=<path> 可指定非默认安装位置）
 * 找不到 app.asar（非本机/未装桌面端）时跳过并注明，与 verify:contract 同一约定。
 */
import { readFileSync, existsSync } from 'node:fs';

const ASAR = process.env.DHCX_ASAR ?? 'D:/Programs/DeepSeek Harness/resources/app.asar';
const CLIENT = new URL('../lib/client.js', import.meta.url);

if (!existsSync(ASAR)) {
  console.log(`SKIP：找不到宿主 ${ASAR}（本机未装桌面端？），本门不适用。`);
  console.log('      设置 DHCX_ASAR=<app.asar 路径> 可指定位置。');
  process.exit(0);
}

/** 1) 宿主定义了哪些变量（`--name:` 才是定义；用 latin1 读可避开多字节切割，只匹配 ASCII）。 */
const host = readFileSync(ASAR).toString('latin1');
const defined = new Set();
for (const m of host.matchAll(/--[a-zA-Z0-9-]+(?=\s*:)/g)) defined.add(m[0]);

/** 2) 客户端代码里引用了哪些（丢掉注释行：案底留在注释里，但不该判红）。 */
const code = readFileSync(CLIENT, 'utf8');
const referenced = new Set();
for (const line of code.split('\n')) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
  for (const m of line.matchAll(/--[a-zA-Z0-9-]+/g)) referenced.add(m[0]);
}

const missing = [...referenced].filter((n) => !defined.has(n)).sort();

console.log(`宿主定义的 CSS 变量：${defined.size} 个（${ASAR}）`);
console.log(`lib/client.js 代码引用：${[...referenced].sort().join(', ') || '（无）'}`);

if (referenced.size === 0) {
  console.log('FAIL：代码里一个变量都没引用到——取色逻辑可能被改坏了，本门拒绝假装通过。');
  process.exit(1);
}

if (missing.length > 0) {
  console.log(`\nFAIL：以下变量在宿主里**没有定义**（${missing.length} 个）：`);
  for (const n of missing) console.log(`  - ${n}`);
  console.log('\n后果（真机已发生两次）：取不到颜色 → 客户端发空串 → 服务端保持空 → 浮窗用默认色，');
  console.log('用户只看到「横幅不随主题变化」，没有任何报错。改名前先在宿主样式表里确认它真的存在。');
  process.exit(1);
}

console.log('\nPASS：代码引用的每个变量宿主都定义了。');
