/**
 * 宿主外冒烟测试：mock ctx.tools 验证 apply() 注册与参数校验。
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name as pluginName } from '../lib/index.js';
import { validateAgainstSchema } from '../lib/core/tool.js';

function makeMockCtx() {
  const registered = new Map();
  return {
    ctx: {
      tools: { register: (t) => registered.set(t.name, t) },
      logger: { info() {}, warn() {} },
    },
    registered,
  };
}

test('apply 注册 x_status 且 execute 返回契约形状', async () => {
  const { ctx, registered } = makeMockCtx();
  apply(ctx, { headless: true, ttlMs: 30000, allowedApps: [] });
  assert.ok(registered.has('x_status'), 'x_status 未注册');
  const tool = registered.get('x_status');
  assert.equal(tool.name, 'x_status');
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.equal(value.ok, true);
  assert.equal(value.plugin, pluginName);
  assert.equal(typeof value.activated, 'boolean');
  // render 产出 content block 数组（register 契约）
  const blocks = tool.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
});

test('参数校验：必填缺失与类型错误都能拦下', () => {
  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string' },
      count: { type: 'integer' },
    },
    required: ['url'],
  };
  assert.deepEqual(validateAgainstSchema(schema, {}), ['args.url 是必填项']);
  assert.deepEqual(
    validateAgainstSchema(schema, { url: 'x', count: 1.5 }),
    ['args.count 需要 integer 类型，实际是 number'],
  );
  assert.deepEqual(validateAgainstSchema(schema, { url: 'x', count: 2 }), []);
});

test('execute 抛错归一为带 retry 语义的 ControlXError', async () => {
  const { defineXTool } = await import('../lib/core/tool.js');
  const { ControlXError } = await import('../lib/core/errors.js');
  const tool = defineXTool({
    name: 'x_boom',
    description: 'test',
    outputSchema: { type: 'object', properties: {} },
    render: () => [{ type: 'text', text: '' }],
    execute: async () => {
      throw new ControlXError('目标不见了', { code: 'ELEMENT_UNAVAILABLE' });
    },
  });
  await assert.rejects(
    () => tool.execute({}, {}),
    (err) => err.code === 'ELEMENT_UNAVAILABLE' && err.retry === 'reobserve',
  );
});
