/**
 * 视觉模型：给纯文本模型补一双眼睛。
 *
 * 为什么需要（2026-10-01 实测）：本会话模型 space-bunny-free 明确不支持图片输入——
 * 宿主对 read_image 的原话是「model "space-bunny-free" does not declare image input」。
 * 截图工具能拍出真图（实测 1280×800、9274 种颜色的真实渲染），但图片内容到不了模型，
 * 所以必须由插件**代跑视觉模型、把结果转成文字**再交回给 Agent。
 *
 * 宿主契约（@deepseek-ai/dsh-llm@0.2.0-rc.2 的 README 原文，非猜测）：
 *   ctx.llm.listProviders()                      → 已注册的 provider 路由
 *   ctx.llm.listModels(provider)                 → [{provider,id,name,inputModalities?}]
 *   for await (const chunk of ctx.llm.stream({   // async iterable
 *     provider, model,
 *     messages: [{ role: 'user', content: [{ type: 'text', text: '…' }] }],
 *   }))                                          // chunk: block-start/text-delta/…/usage/finish
 * `inputModalities` 是"这个模型吃不吃图"的判据——设置页要列的"已添加的视觉模型"就是
 * 拿它过滤出来的，不另造探测逻辑。
 *
 * 图片怎么进 messages：宿主 README 说「An image-capable adapter projects durable
 * references」，即用**持久化附件引用**——与本插件 x_browser_shot 的 render 返回同一种
 * 引用（那条路径已被真机验证过：宿主收下后落盘成 ~/.dsh/attachments/v1/objects/…）。
 * 这里是唯一带推断成分的一处，故所有失败都原样抛出宿主错误，不做静默降级。
 */

/** 设置值：系统推荐（不写死，由 pickModel 决定）。 */
export const VISION_AUTO = '';
/** 设置值：每次调用重新随机挑一个视觉模型。 */
export const VISION_RANDOM = 'random';

export const DEFAULT_VISION_PROMPT = '用简洁的中文描述这张截图里的内容。重点说明屏幕上有什么、当前状态如何。';

/** 一个模型是否声明吃图片。 */
export function isVisionModel(entry) {
  const modalities = entry?.inputModalities;
  return Array.isArray(modalities) && modalities.includes('image');
}

/**
 * 从宿主列出全部"已添加且支持视觉"的模型。
 * @param {{listProviders: Function, listModels: Function}} llm
 * @returns {Promise<Array<{provider: string, model: string, name: string}>>}
 */
export async function listVisionModels(llm) {
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return [];
  }
  const providers = await llm.listProviders();
  const ids = (providers ?? []).map((p) => (typeof p === 'string' ? p : p?.id)).filter((id) => typeof id === 'string' && id !== '');
  const out = [];
  for (const provider of ids) {
    let models = [];
    try {
      models = await llm.listModels(provider);
    } catch {
      // 单个 provider 取不到模型不该让整个列表失败：设置页据此显示"部分不可用"即可。
      continue;
    }
    for (const entry of models ?? []) {
      if (!isVisionModel(entry) || typeof entry.id !== 'string' || entry.id === '') continue;
      out.push({
        provider: typeof entry.provider === 'string' ? entry.provider : provider,
        model: entry.id,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      });
    }
  }
  return out;
}

/**
 * 挑一个视觉模型。
 * @param {Array<{provider: string, model: string, name: string}>} models
 * @param {string} setting '' = 系统推荐 / 'random' = 随机 / 'provider/model' = 指定
 * @param {() => number} [random] 随机源（测试可注入）
 */
export function pickModel(models, setting, random = Math.random) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('没有可用的视觉模型：请先在宿主里添加一个支持图片输入的模型（设置页会列出它们）。');
  }
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (value !== VISION_AUTO && value !== VISION_RANDOM && value !== '') {
    const hit = models.find((m) => `${m.provider}/${m.model}` === value || m.model === value);
    if (hit) return hit;
    throw new Error(`设置里指定的视觉模型 ${value} 不在当前已添加的视觉模型列表中（可能已删除）。`);
  }
  if (value === VISION_RANDOM) {
    // 每次重新摇：某个模型抽风时不会一直卡在它身上。
    return models[Math.floor(random() * models.length) % models.length];
  }
  // 系统推荐：取第一个（宿主按适配器偏好顺序返回，稳定的适配器排在前面）。
  return models[0];
}

/** 从流式 chunk 里取出文本增量（chunk 形状：block-start / text-delta / usage / finish）。 */
function collectText(chunk, sink) {
  if (chunk === null || typeof chunk !== 'object') return;
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    sink.text += chunk.text;
    return;
  }
  // 兜底：不同适配器可能用别的字段名带增量文本。
  if (typeof chunk.text === 'string' && typeof chunk.type === 'string' && chunk.type.includes('delta')) {
    sink.text += chunk.text;
  }
}

/**
 * 让一个视觉模型看图并返回文字。
 * @param {object} args
 * @param {object} args.llm 宿主 llm 服务
 * @param {{provider: string, model: string}} args.target 选中的模型
 * @param {object} args.attachment 持久化附件引用（x_browser_shot 的 image 字段）
 * @param {string} [args.prompt]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{text: string, chunks: number}>}
 */
export async function describeImage({ llm, target, attachment, prompt = DEFAULT_VISION_PROMPT, signal }) {
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('宿主未提供 llm 服务，无法调用视觉模型。');
  }
  if (!attachment || typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') {
    throw new Error('缺少图片附件：先用 x_browser_shot 截图，把返回的 image 引用传进来。');
  }
  const sink = { text: '' };
  let chunks = 0;
  const content = [
    { type: 'text', text: prompt },
    // 图片块形状与本插件 render 的 image block 同源（宿主已实测接受过那条路径）。
    { type: 'image', attachment: { ...attachment } },
  ];
  try {
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [{ role: 'user', content }],
    })) {
      chunks += 1;
      collectText(chunk, sink);
    }
  } catch (err) {
    // 宿主错误原样上抛：图片块字段名若与推断不符，这里会给出可直接定位的真话，
    // 而不是被我们包装成"识别失败"。
    throw new Error(`视觉模型调用失败（${target.provider}/${target.model}）：${err?.message ?? String(err)}`);
  }
  return { text: sink.text.trim(), chunks };
}
