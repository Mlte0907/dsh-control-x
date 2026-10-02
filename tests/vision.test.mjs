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
import { readFileSync } from 'node:fs';
import {
  listVisionModels, pickModel, describeImage, isVisionModel,
  candidateModels, describeImageWithFallback, describeAttempts, HOST_IMAGE_OMITTED_MARKER,
  classifyVisionError,
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
  assert.equal(pickModel(models, VISION_AUTO).model, 'a', '系统推荐 = 列表首个（宿主给的原顺序）');
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

// ── 2026-10-03：视觉链路在真实环境失效后的修复与防复发 ──
// 真机证据：本机宿主声称 3 个模型支持 image，而排在首位的 opencode-go/space-bunny-free
// 对图片返回空文本；宿主对「只吃文本的模型」会**静默**把图片块替换成一段说明文字
// （dsh-llm/lib/types/content.js 的 textOnlyImageText），插件侧原本无从分辨
// 「模型没话说」和「图片压根没送到」。旧实现只试 models[0] 就返回，用户看到的
// 只有一句「没有返回任何文字」，功能整条静默死掉。

test('回归：pickModel 的注释不许承诺代码里没有的选型策略', () => {
  const src = readFileSync(new URL('../lib/vision.js', import.meta.url), 'utf8');
  const i = src.indexOf('function pickModel');
  const body = src.slice(i, src.indexOf('\n}', i));
  // 只看"在陈述现状"的注释行：标明是历史/已移除的行不算承诺（那正是防复活的记录）。
  const live = body.split('\n')
    .filter((l) => !/此前|曾经|旧的|已移除|⚠/.test(l))
    .join('\n');
  const promises = /优先|偏好|最便宜/.test(live);
  const implementsIt = /shuffle|sort|score|cost/.test(live.replace(/\/\/.*$/gm, ''));
  assert.equal(promises && !implementsIt, false,
    '注释不许承诺代码里不存在的排序策略——那正是本次视觉静默失效的根因之一');
});

test('候选顺序：系统推荐=宿主原顺序；random=同一批但打乱；指定=只有它', () => {
  const models = [
    { provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }, { provider: 'p', model: 'c' },
  ];
  assert.deepEqual(candidateModels(models, '').map((m) => m.model), ['a', 'b', 'c'],
    '系统推荐必须保留宿主原顺序：插件没有任何依据去重排');
  const shuffled = candidateModels(models, 'random');
  assert.deepEqual([...shuffled].map((m) => m.model).sort(), ['a', 'b', 'c'], 'random 不得丢候选');
  assert.deepEqual(candidateModels(models, 'p/b').map((m) => m.model), ['b']);
  assert.throws(() => candidateModels(models, 'p/zz'), /不在当前接入的视觉模型里/);
  assert.throws(() => candidateModels([], ''), /没有找到任何支持图片输入的模型/);
});

/** 只按模型名回话的假 llm.stream。 */
const scriptedLlm = (behaviour) => ({
  stream: async function* (req) {
    for (const c of behaviour(`${req.provider}/${req.model}`, req) ?? []) yield c;
  },
});
const delta = (text) => ({ type: 'text-delta', index: 0, text });
const FIN = { type: 'finish', reason: { kind: 'stop' } };
const ATT = { attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: 1, width: 2, height: 2 };

test('自动回退：首个模型返回空就换下一个，且如实报告跳过了谁', async () => {
  const llm = scriptedLlm((n) => (n === 'p/good' ? [delta('屏幕上是豆包窗口'), FIN] : [delta(''), FIN]));
  const r = await describeImageWithFallback({
    llm,
    candidates: [{ provider: 'p', model: 'bad' }, { provider: 'p', model: 'good' }, { provider: 'p', model: 'never' }],
    attachment: ATT,
  });
  assert.equal(r.text, '屏幕上是豆包窗口');
  assert.equal(r.target.model, 'good');
  assert.deepEqual(r.attempts.map((a) => [a.model, a.ok]), [['bad', false], ['good', true]],
    '成功即停：不该白花后面的调用');
  assert.equal(r.attempts[0].reason, 'empty');
  assert.match(describeAttempts(r.attempts), /good 看图成功.*跳过.*bad/);
});

test('自动回退：宿主把图片替换成文字要单独报（"模型实际不吃图"的铁证）', async () => {
  const marker = `[${HOST_IMAGE_OMITTED_MARKER}; attachment sha256:deadbeef]`;
  const llm = scriptedLlm((n) => (n === 'p/textonly' ? [delta(marker), FIN] : [delta('一张猫'), FIN]));
  const r = await describeImageWithFallback({
    llm, candidates: [{ provider: 'p', model: 'textonly' }, { provider: 'p', model: 'vision' }], attachment: ATT,
  });
  assert.equal(r.text, '一张猫');
  assert.equal(r.attempts[0].reason, 'image-not-delivered',
    '必须能认出宿主静默替换了图片，否则用户永远不知道为什么看图看不到图');
  assert.match(describeAttempts(r.attempts), /实际不吃图/);
});

test('自动回退：某个候选抛错不阻断后面的候选，且宿主错误要带出来', async () => {
  const llm = scriptedLlm((n) => {
    if (n === 'p/boom') throw new Error('route exploded');
    return [delta('看到了'), FIN];
  });
  const r = await describeImageWithFallback({
    llm, candidates: [{ provider: 'p', model: 'boom' }, { provider: 'p', model: 'ok' }], attachment: ATT,
  });
  assert.equal(r.text, '看到了');
  assert.equal(r.attempts[0].reason, 'call-failed');
  assert.match(r.attempts[0].error, /route exploded/, '宿主错误不许吞掉');
});

test('自动回退：全部候选不可用时返回空 + 完整清单（绝不谎报成功）', async () => {
  const r = await describeImageWithFallback({
    llm: scriptedLlm(() => []),
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }], attachment: ATT,
  });
  assert.equal(r.text, '');
  assert.equal(r.attempts.length, 2);
  assert.match(describeAttempts(r.attempts), /全部/);
});

// ── 2026-10-03 真机复验撞上：宿主读回图片时校验元数据不通过 ──
// 真实报错："Stored attachment metadata does not match its reference."
// 抛出点 dsh-attachment-local/lib/index.js 的 readImageFile：digest 校验已过（字节是对的），
// 但 probeImage(data) 得到的 mediaType/bytes/width/height 与 ref 记录的对不上。
//
// 这类错误**与选哪个模型无关**，所以回退逻辑必须立刻停——否则会白花三次调用，
// 还会让用户误以为"多换几个模型说不定能行"。

test('错误分类：附件类错误必须与模型类错误分开', () => {
  assert.equal(classifyVisionError({ code: 'ATTACHMENT_CORRUPT', message: 'x' }), 'attachment');
  assert.equal(classifyVisionError({ code: 'ATTACHMENT_NOT_FOUND', message: 'x' }), 'attachment');
  assert.equal(classifyVisionError({ code: 'INVALID_IMAGE', message: 'x' }), 'attachment');
  assert.equal(classifyVisionError({ message: 'Stored attachment metadata does not match its reference.' }), 'attachment');
  assert.equal(classifyVisionError({ code: 'IMAGE_TYPE_MISMATCH', message: 'x' }), 'attachment');
  assert.equal(classifyVisionError({ code: 'ABORTED', message: 'aborted by signal' }), 'aborted');
  assert.equal(classifyVisionError(new Error('429 rate limited')), 'model');
  assert.equal(classifyVisionError({}), 'model');
});

test('附件坏了立刻停：只试一个候选，不白花另外两个的调用', async () => {
  let calls = 0;
  const llm = {
    stream: async function* () {
      calls += 1;
      const err = new Error('Stored attachment metadata does not match its reference.');
      err.code = 'ATTACHMENT_CORRUPT';
      throw err;
    },
  };
  const r = await describeImageWithFallback({
    llm,
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }, { provider: 'p', model: 'c' }],
    attachment: { ...ATT, width: 111, height: 222, bytes: 999 },
  });
  assert.equal(calls, 1, '附件级错误换模型不会有不同结果，必须只试一次');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].reason, 'attachment-invalid');
  assert.match(r.attempts[0].error, /Stored attachment metadata/);
  // 关键：把我们以为的元数据摊出来，才能和附件库实际值逐项比
  assert.deepEqual(r.attempts[0].attachmentClaim,
    { attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: 999, width: 111, height: 222 });
  const msg = describeAttempts(r.attempts);
  assert.match(msg, /与选哪个模型无关/, '必须说清这不是模型的锅，否则用户会去换模型');
  assert.match(msg, /width=111/, '必须把 claim 打出来');
  assert.match(msg, /height=222/);
  assert.match(msg, /bytes=999/);
});

test('模型类错误仍然继续试下一个候选（别把回退一起关掉）', async () => {
  const llm = scriptedLlm((n) => {
    if (n === 'p/boom') { const e = new Error('429 too many requests'); e.code = 'RATE_LIMITED'; throw e; }
    return [delta('看到了'), FIN];
  });
  const r = await describeImageWithFallback({
    llm, candidates: [{ provider: 'p', model: 'boom' }, { provider: 'p', model: 'ok' }], attachment: ATT,
  });
  assert.equal(r.text, '看到了', '限流/鉴权这类换个模型也许能成，必须继续试');
  assert.equal(r.attempts.length, 2);
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
