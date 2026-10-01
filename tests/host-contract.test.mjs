/**
 * 宿主契约测试：每个工具的 parameters / output.schema 必须落在宿主 raw JSON Schema 子集内。
 *
 * 为什么单独一个文件（2026-10-01 事故的直接产物）：
 * 之前的 m1/m2/m3 验收脚本全部用「来者不拒」的 mock ctx.tools.register，
 * 于是 21 个工具的 output.schema 全部违反宿主子集、被 register 拒收，
 * 三套验收依然 5/5 全绿，而真实会话里一个工具都看不到。
 * 这个测试把「宿主会拒绝的形态」钉死在单测里，反向对照写在最后一项。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { checkHostSchema, toHostSchema } from '../lib/core/host-schema.js';

/** 注册常驻 + 激活后的完整工具面（走真实 apply()，与宿主同一段注册代码）。 */
async function allTools() {
  const registered = new Map();
  const disposers = [];
  const ctx = {
    tools: { register: (t) => registered.set(t.name, t) },
    get: () => undefined,
    logger: { info() {}, warn() {} },
    // 没有 effect 的话 apply() 注册的销毁钩子永远不会被调用，浮窗的临时目录
    // 就留在 %TEMP% 里没人删（实测本文件每次跑漏 4 个）。
    effect: (fn) => { disposers.push(fn()); },
    inject: (services, cb) => {
      if (services.includes('skills')) cb({ skills: { register() {} }, logger: { info() {}, warn() {} } });
    },
  };
  apply(ctx, { headless: true, ttlMs: 30000, allowedApps: [], browserEnabled: true, desktopEnabled: true });
  await registered.get('x_activate').execute({}, {});
  return {
    registered,
    dispose() { disposers.splice(0).forEach((fn) => { try { fn(); } catch { /* 已卸载 */ } }); },
  };
}

test('常驻门控：只有 x_status + x_activate，且激活后共 21 个工具', async (t) => {
  const before = new Map();
  const disposers = [];
  apply({
    tools: { register: (t) => before.set(t.name, t) },
    logger: { info() {}, warn() {} },
    effect: (fn) => { disposers.push(fn()); },
  }, { headless: true });
  t.after(() => { disposers.splice(0).forEach((fn) => { try { fn(); } catch { /* 已卸载 */ } }); });
  assert.deepEqual([...before.keys()], ['x_status', 'x_activate']);

  const { registered, dispose } = await allTools();
  t.after(dispose);
  assert.equal(registered.size, 22, '激活后工具总数（常驻 2 + 能力 20，含 x_vision_describe）');
});

test('全部 22 个工具的 schema 满足宿主 raw JSON Schema 子集', async (t) => {
  const { registered, dispose } = await allTools();
  t.after(dispose);
  const failures = [];
  for (const tool of registered.values()) {
    for (const [field, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
      for (const violation of checkHostSchema(schema)) failures.push(`${tool.name}.${field}: ${violation}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);

  // 反向保证：规范化不是空转。x_browser_open 源码里 tab/ok 写的是属性级 required:true，
  // 注册给宿主的 output.schema 必须变成根级字符串数组，否则等于什么都没修。
  const open = registered.get('x_browser_open');
  assert.ok(Array.isArray(open.output.schema.required), 'x_browser_open 的根级 required 是数组');
  for (const name of ['ok', 'tab']) {
    assert.ok(open.output.schema.required.includes(name), `x_browser_open.required 含 ${name}`);
  }
});

test('无副作用工具的返回值必须满足自己的 output.schema（宿主会校验，缺一个键就判失败）', async (t) => {
  // 背景：2026-10-01 真机 E2E 实测，宿主拿 output.schema 校验工具返回值，
  // x_browser_tabs 返回 {tabs} 而 schema 要求 {ok,tabs}，调用被直接判
  // "missing required property value.ok"。此前所有测试都直接调 execute()、
  // 绕过宿主校验，这类不匹配全被放过——注册失败把它一起遮住了。
  const { registered, dispose } = await allTools();
  t.after(dispose);
  for (const name of ['x_browser_tabs']) {
    const tool = registered.get(name);
    const value = await tool.execute({}, { signal: AbortSignal.timeout(15000) });
    const need = tool.output.schema.required ?? [];
    const have = Object.keys(value ?? {});
    const missing = need.filter((key) => !have.includes(key));
    assert.deepEqual(missing, [], `${name} 返回缺 ${missing.join(',')}（实际键：${have.join(',')}）`);
  }
});

test('反向对照：property-map 旧写法必须被自检判红（否则上面的绿是假绿）', async () => {
  const oldStyle = {
    type: 'object',
    properties: { ok: { type: 'boolean', required: true }, tab: { type: 'object', required: true } },
    required: true,
  };
  const violations = checkHostSchema(oldStyle);
  assert.ok(violations.length >= 2, `旧写法应至少触发两条违规，实际 ${violations.length}：${violations.join('；')}`);
  assert.ok(violations.some((v) => v.includes('字符串数组')), '根级 required: true 被拦下');
  assert.ok(violations.some((v) => v.includes('type "boolean"')), '标量属性上的 required 被拦下');

  // 规范化后必须干净，且 required 名字与 properties 对得上
  const fixed = toHostSchema(oldStyle);
  assert.deepEqual(checkHostSchema(fixed), []);
  assert.deepEqual(fixed.required.sort(), ['ok', 'tab']);
  assert.equal(fixed.properties.ok.required, undefined, '属性上的布尔 required 被提升走了');
});

test('规范化不改动非 required 的内容（description/items/enum 原样保留）', () => {
  const schema = {
    type: 'object',
    description: '面板状态',
    properties: {
      tabs: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string', required: true } }, required: true },
        required: true,
      },
      mode: { type: 'string', enum: ['a', 'b'], description: '模式' },
    },
    required: true,
  };
  const fixed = toHostSchema(schema);
  assert.equal(fixed.description, '面板状态');
  assert.equal(fixed.properties.mode.description, '模式');
  assert.deepEqual(fixed.properties.mode.enum, ['a', 'b']);
  assert.equal(fixed.properties.tabs.items.properties.id.required, undefined, '属性上的布尔 required 被提升走了');
  // 提升是「就地」的：id 是 items 对象的属性，所以进的是 items 的 required，不是外层的。
  assert.deepEqual(fixed.properties.tabs.items.required, ['id']);
  // 节点自己身上的 required:true 只是「这个对象必填」的 DSL 记法，
  // raw JSON Schema 无对应关键字；它的名字已由父级记进父级的 required，这里丢弃。
  assert.equal(fixed.properties.tabs.required, undefined);
  assert.deepEqual(fixed.required, ['tabs'], '只有当前对象上「属性必填」的才汇入本级 required');
  assert.deepEqual(checkHostSchema(fixed), []);
});
