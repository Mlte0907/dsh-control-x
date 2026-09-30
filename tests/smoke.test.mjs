/**
 * 宿主外冒烟测试：mock ctx.tools 验证 apply() 注册与参数校验。
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('x_status 报的版本等于 package.json 的真实版本（防再写死）', async () => {
  const { ctx, registered } = makeMockCtx();
  apply(ctx, { headless: true });
  const value = await registered.get('x_status').execute({}, {});
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(value.version, declared, `x_status 报 ${value.version}，package.json 是 ${declared}`);
  assert.match(value.version, /^\d+\.\d+\.\d+/, '版本形如 x.y.z，不允许再出现 0.0.1 这类占位值');
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

test('总开关门控：browserEnabled/desktopEnabled 关闭后工具拒绝执行', async () => {
  const { ctx, registered } = makeMockCtx();
  const config = {
    headless: true, ttlMs: 30000, allowedApps: [],
    browserEnabled: true, desktopEnabled: true,
  };
  apply(ctx, config);
  await registered.get('x_activate').execute({}, {});
  assert.ok(registered.has('x_browser_open'), '激活后注册浏览器工具');
  assert.ok(registered.has('x_desktop_apps'), '激活后注册桌面工具');

  config.browserEnabled = false;
  await assert.rejects(
    () => registered.get('x_browser_open').execute({ url: 'https://example.com/' }, {}),
    (err) => err.code === 'ACTION_UNAVAILABLE' && err.retry === 'never',
    '浏览器总开关关闭后拒绝',
  );
  config.browserEnabled = true;
  config.desktopEnabled = false;
  await assert.rejects(
    () => registered.get('x_desktop_apps').execute({}, {}),
    (err) => err.code === 'ACTION_UNAVAILABLE',
    '电脑控制总开关关闭后拒绝',
  );
  config.desktopEnabled = true;
});

test('control-x skill 满足宿主 dsh-skill 的 validateDefinition 契约', async () => {
  const { CONTROL_X_SKILL } = await import('../lib/skill.js');
  // 宿主校验（dsh-skill/lib/index.js）：name 符合 kebab-case、description 非空、
  // source/provider/content 必须是字符串；runtime provider 的 get() 原样返回注册对象，
  // 缺 source 会在会话加载 skill 时抛 "source must be a string"，整轮运行失败。
  assert.match(CONTROL_X_SKILL.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(typeof CONTROL_X_SKILL.description, 'string');
  assert.ok(CONTROL_X_SKILL.description.length > 0);
  assert.equal(typeof CONTROL_X_SKILL.source, 'string', 'source 必须是字符串（宿主加载期校验）');
  assert.equal(typeof CONTROL_X_SKILL.content, 'string');
  assert.ok(CONTROL_X_SKILL.content.length > 0);
  if (CONTROL_X_SKILL.whenToUse !== undefined) {
    assert.equal(typeof CONTROL_X_SKILL.whenToUse, 'string');
  }
});
