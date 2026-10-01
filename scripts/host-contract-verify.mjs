#!/usr/bin/env node
/**
 * 宿主契约验收：用**运行中宿主**的真校验器判本插件每一个工具能不能注册成功。
 *
 * 这是 2026-10-01 那次静默断链唯一真正抓住它的检查：m1/m2/m3 都用 mock ctx.tools.register，
 * 来者不拒，所以 output.schema 全错也照样全绿。本脚本按 app.asar 内
 * @deepseek-ai/dsh-tools 0.2.0-rc.2 的真实规则判定：
 *   - register(definition)（lib/index.js:2878-2890）逐条照抄，含 assertSupportedJsonSchema(output.schema)
 *   - assertSupportedJsonSchema 是宿主原模块（从 app.asar 抽出后 import，未改写一行）
 *
 * 用法：npm run verify:contract
 *   DHCX_ASAR=<app.asar 路径> 可指定非默认安装位置。
 * 找不到 app.asar（非本机/未装桌面端）时退回仓库内镜像规则，并在输出里注明「未经真宿主校验」。
 */
import { mkdtempSync, mkdirSync, writeFileSync, openSync, readSync, closeSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../lib/index.js';
import { checkHostSchema } from '../lib/core/host-schema.js';

const ASAR = process.env.DHCX_ASAR ?? 'D:/Programs/DeepSeek Harness/resources/app.asar';
const pkgRoot = mkdtempSync(join(tmpdir(), 'dsh-control-x-contract-'));
// 这里会把宿主真包解出来，是整个脚本最大的一块临时产物；不收掉的话每跑一次
// 就在 %TEMP% 留一份（实测已堆到 3 份）。退出时清，异常退出也清。
process.on('exit', () => { try { rmSync(pkgRoot, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const modulesRoot = join(pkgRoot, 'node_modules');

function assert(cond, message) {
  if (!cond) throw new Error(`验收失败: ${message}`);
  console.log(`  ✔ ${message}`);
}

/** 读取 asar 目录表；返回 path → entry 的索引。 */
function readAsarIndex(asarPath) {
  const fd = openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonLen);
  readSync(fd, json, 0, jsonLen, 16);
  closeSync(fd);
  const header = JSON.parse(json.toString('utf8'));
  const index = new Map();
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, p);
      else index.set(p, entry);
    }
  })(header, '');
  return { index, dataBase: 8 + headerPickleSize };
}

/** 递归抽出一个 @deepseek-ai 包及其 import 闭包，供本机直接 import 宿主真函数。 */
function extractClosure(asarPath, roots) {
  const { index, dataBase } = readAsarIndex(asarPath);
  const read = (entry) => {
    const fd = openSync(asarPath, 'r');
    const buf = Buffer.alloc(entry.size);
    readSync(fd, buf, 0, entry.size, dataBase + Number(entry.offset));
    closeSync(fd);
    return buf;
  };
  const done = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (done.has(pkg)) continue;
    done.add(pkg);
    const prefix = `dsh/node_modules/${pkg}/`;
    const deps = new Set();
    for (const path of [...index.keys()].filter((p) => p.startsWith(prefix))) {
      const rel = path.slice(prefix.length);
      const dest = join(modulesRoot, pkg, rel);
      const buf = read(index.get(path));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      if (/\.m?js$/.test(rel)) {
        for (const m of buf.toString('utf8').matchAll(/from ["'](@deepseek-ai\/[^"']+)["']/g)) {
          deps.add(m[1].replace(/\/lib(\/index\.js)?$/, ''));
        }
      }
    }
    for (const d of deps) if (!done.has(d)) queue.push(d);
  }
}

let assertSupportedJsonSchema = null;
let source = '仓库内镜像规则（未经真宿主校验）';
if (existsSync(ASAR)) {
  try {
    extractClosure(ASAR, ['@deepseek-ai/dsh-tools']);
    const mod = await import(pathToFileURL(join(modulesRoot, '@deepseek-ai/dsh-tools/lib/types/json-schema.js')).href);
    assertSupportedJsonSchema = mod.assertSupportedJsonSchema;
    source = `宿主真校验器（${ASAR} 内 @deepseek-ai/dsh-tools）`;
  } catch (err) {
    console.log(`  – 抽取宿主包失败：${String(err?.message ?? err).slice(0, 120)}`);
  }
} else {
  console.log(`  – 未找到 ${ASAR}，跳过真宿主校验`);
}
console.log(`判定依据：${source}\n`);

/** 宿主 register(definition) 的门控（app.asar: dsh-tools/lib/index.js:2878-2890，逐行照抄）。 */
function hostGate(definition) {
  const name = definition.name;
  const output = definition.output;
  if (output === void 0 || typeof output !== 'object' || typeof output.render !== 'function'
    || (output.presentationMeta !== void 0 && typeof output.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  (assertSupportedJsonSchema ?? checkHostSchema)(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  }
  if (name === 'run_code') throw new Error('tool name "run_code" is reserved');
}

const accepted = [];
const rejected = [];
const tools = new Map();
const disposers = [];
const ctx = {
  tools: {
    register: (t) => {
      try {
        hostGate(t);
        accepted.push(t.name);
      } catch (err) {
        rejected.push(`${t.name}: ${String(err?.message ?? err).split('\n')[0]}`);
      }
      tools.set(t.name, t);
    },
  },
  get: () => undefined,
  logger: { info() {}, warn() {} },
  // 收集销毁钩子：apply() 里的 ctx.effect(() => () => banner.stop()) 必须真的被
  // 收走，否则每次验收都在 %TEMP% 留一个孤儿目录。
  effect: (fn) => { disposers.push(fn()); },
  inject: (services, cb) => {
    if (services.includes('skills')) cb({ skills: { register() {} }, logger: { info() {}, warn() {} } });
  },
};
process.on('exit', () => disposers.splice(0).forEach((fn) => { try { fn(); } catch { /* 已卸载 */ } }));

apply(ctx, { headless: true, ttlMs: 30000, allowedApps: [], browserEnabled: true, desktopEnabled: true });
assert(tools.get('x_activate') !== undefined, 'x_activate 通过宿主注册门');
await tools.get('x_activate').execute({}, {});

assert(rejected.length === 0, `全部工具通过宿主注册门（拒绝 ${rejected.length} 个）`);
for (const line of rejected) console.log(`      ✘ ${line}`);
// 期望的工具名逐个点名，而不是只比一个总数：加了工具忘了改数字会红，
// 但删了某个工具只改数字也能混过去——点名让"少一个"和"多一个"都看得见。
const EXPECTED = [
  'x_status', 'x_activate',
  'x_browser_tabs', 'x_browser_open', 'x_browser_read', 'x_browser_click', 'x_browser_fill',
  'x_browser_press', 'x_browser_scroll', 'x_browser_shot', 'x_browser_wait', 'x_browser_close',
  'x_desktop_apps', 'x_desktop_tree', 'x_desktop_press', 'x_desktop_value', 'x_desktop_scroll',
  'x_desktop_launch', 'x_desktop_mouse_click', 'x_desktop_type', 'x_desktop_key',
  'x_vision_describe',
];
assert(accepted.length === EXPECTED.length, `注册工具总数 = ${accepted.length}（期望 ${EXPECTED.length}）`);
const missing = EXPECTED.filter((name) => !accepted.includes(name));
assert(missing.length === 0, `缺席的工具：${missing.join(', ') || '无'}`);
console.log(`\n宿主契约验收通过：${accepted.join(', ')}`);
