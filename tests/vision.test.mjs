/**
 * 视觉模型服务：模型发现 / 选择策略 / 视觉调用。
 *
 * 背景（2026-10-01 实测）：宿主按模型**声明的** inputModalities 决定放不放图片，
 * space-bunny-free 的 profile 路由只声明了 [text]，所以 read_image 被拒。
 * 同一 profile 里 mimo-v2.6-flash / mimo-v2.5 声明了 [text, image]。
 * 本模块给"确实只能用纯文本模型"的会话准备一条兜底：代跑视觉模型，把结果转成文字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listVisionModels, pickModel, describeImage, isVisionModel,
  VISION_AUTO, VISION_RANDOM,
} from '../lib/vision.js';

const fakeLlm = (catalog) => ({
  async listProviders() { return Object.keys(catalog); },
  async listModels(provider) { return catalog[provider] ?? []; },
});

test('只列出声明了 image 的模型（inputModalities 是唯一判据）', async () => {
  const llm = fakeLlm({
    opencode: [
      { provider: 'opencode', id: 'space-bunny-free', name: 'Space Bunny Free', inputModalities: ['text'] },
      { provider: 'opencode', id: 'longcat', name: 'LongCat', inputModalities: ['text'] },
    ],
    mimo: [
      { provider: 'mimo', id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', inputModalities: ['text', 'image'] },
      { provider: 'mimo', id: 'mimo-v2.5', name: 'MiMo V2.5', inputModalities: ['text', 'image'] },
    ],
  });
  const models = await listVisionModels(llm);
  assert.deepEqual(models.map((m) => m.model), ['mimo-v2.6-flash', 'mimo-v2.5'],
    '纯文本模型不得出现在视觉模型列表里');
  assert.deepEqual(models[0], { provider: 'mimo', model: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash' });
});

test('单个 provider 取模型失败不影响其余 provider（设置页要能显示部分可用）', async () => {
  const llm = {
    async listProviders() { return ['broken', 'good']; },
    async listModels(provider) {
      if (provider === 'broken') throw new Error('gateway 502');
      return [{ provider: 'good', id: 'v1', name: 'V1', inputModalities: ['image'] }];
    },
  };
  const models = await listVisionModels(llm);
  assert.deepEqual(models.map((m) => m.model), ['v1']);
});

test('没有 llm 服务时返回空列表而不是抛错（宿主可能没挂）', async () => {
  assert.deepEqual(await listVisionModels(undefined), []);
  assert.deepEqual(await listVisionModels({}), []);
});

test('选择策略：系统推荐取第一个、随机可注入、指定要能在列表里找到', () => {
  const models = [
    { provider: 'mimo', model: 'a', name: 'A' },
    { provider: 'mimo', model: 'b', name: 'B' },
  ];
  assert.equal(pickModel(models, VISION_AUTO).model, 'a', '系统推荐 = 列表首个（宿主按适配器偏好排序）');
  assert.equal(pickModel(models, VISION_RANDOM, () => 0.99).model, 'b', '随机可复现');
  assert.equal(pickModel(models, VISION_RANDOM, () => 0).model, 'a', 'random=0 不得越界');
  assert.equal(pickModel(models, 'mimo/b').model, 'b', 'provider/model 形式');
  assert.equal(pickModel(models, 'b').model, 'b', '只写 model id 也认');
});

test('选择策略的失败要说人话：空列表 / 指定模型已消失', () => {
  assert.throws(() => pickModel([], VISION_AUTO), /没有可用的视觉模型/);
  assert.throws(() => pickModel([{ provider: 'p', model: 'm', name: 'M' }], 'gone/model'),
    /不在当前已添加的视觉模型列表/);
});

test('isVisionModel 只认显式声明 image 的（缺字段不算）', () => {
  assert.equal(isVisionModel({ inputModalities: ['image'] }), true);
  assert.equal(isVisionModel({ inputModalities: ['text', 'image'] }), true);
  assert.equal(isVisionModel({ inputModalities: ['text'] }), false);
  assert.equal(isVisionModel({}), false);
  assert.equal(isVisionModel(undefined), false);
});

test('describeImage：把图片作为附件引用交给宿主 llm，并收回文字', async () => {
  const seen = [];
  const llm = {
    async *stream(options) {
      seen.push(options);
      yield { type: 'block-start' };
      yield { type: 'text-delta', text: '页面上是 ' };
      yield { type: 'text-delta', text: 'Example Domain' };
      yield { type: 'usage' };
      yield { type: 'finish' };
    },
  };
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/jpeg', width: 1280, height: 800, bytes: 20978 };
  const out = await describeImage({ llm, target: { provider: 'mimo', model: 'v' }, attachment });
  assert.equal(out.text, '页面上是 Example Domain');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'mimo');
  assert.equal(seen[0].model, 'v');
  const content = seen[0].messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /描述/);
  assert.equal(content[1].type, 'image', '图片必须作为附件引用进 messages');
  assert.equal(content[1].attachment.attachmentId, 'sha256:abc');
});

test('describeImage：缺图片/缺 llm 时立刻报清楚，绝不静默返回空串', async () => {
  await assert.rejects(
    () => describeImage({ llm: { async *stream() {} }, target: { provider: 'p', model: 'm' }, attachment: null }),
    /缺少图片附件/,
  );
  await assert.rejects(
    () => describeImage({ llm: {}, target: { provider: 'p', model: 'm' }, attachment: { attachmentId: 'a' } }),
    /宿主未提供 llm 服务/,
  );
});

test('describeImage：宿主报错原样上抛并点名模型（图片块字段名对不对要看得见）', async () => {
  const llm = {
    async *stream() { throw new Error('UNSUPPORTED_CONTENT: block "image" not accepted'); },
  };
  await assert.rejects(
    () => describeImage({
      llm, target: { provider: 'p', model: 'm' }, attachment: { attachmentId: 'a' },
    }),
    /视觉模型调用失败（p\/m）：.*UNSUPPORTED_CONTENT/,
  );
});
