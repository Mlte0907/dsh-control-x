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

/**
 * 宿主把图片投递给"只吃文本"的模型时，会**静默**把图片块换成一段说明文字
 * （dsh-llm/lib/types/content.js 的 textOnlyImageText）：
 *   `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`
 * 插件侧看不到这次替换发生过，只能从返回文本里认出来——所以这里留个常量。
 * 认出来才能报"图片根本没送到"，而不是含糊地说"模型没返回文字"。
 */
export const HOST_IMAGE_OMITTED_MARKER = 'image omitted because this model accepts text only';

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
  // 「系统推荐」：**按宿主给出的顺序**逐个尝试，第一个真能看图的那个胜出。
  //
  // ⚠️ 这里此前写着「宁可多花 token 也优先选便宜快的模型；本次偏好日韩/二次元」——
  // 那是**一段根本不存在的选型逻辑**（代码只有 return models[0]）。注释在撒谎，
  // 而后果不是"选得不够优"，是"选中的那个可能根本不能看图，然后整条功能静默死掉"。
  // 2026-10-03 改为真顺序 + describeImageWithFallback 的自动回退：注释写什么就做什么。
  return models[0];
}

/**
 * 按设置排出候选视觉模型，**顺序即尝试顺序**。
 *
 * 与 pickModel 的区别：pickModel 只给一个（保持既有调用方与测试的语义），
 * 这里给全部候选，让 describeImageWithFallback 能在前者返回空时自动往下试。
 */
export function candidateModels(models, setting, random = Math.random) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('没有找到任何支持图片输入的模型：请在模型设置里检查 vision 字段。');
  }
  const value = typeof setting === 'string' ? setting.trim() : '';
  if (value !== VISION_AUTO && value !== VISION_RANDOM && value !== '') {
    const hit = models.find((m) => `${m.provider}/${m.model}` === value || m.model === value);
    if (hit) return [hit];
    throw new Error(`设置指定的视觉模型 ${value} 不在当前接入的视觉模型里，请到设置页改一下。`);
  }
  if (value === VISION_RANDOM) {
    const rest = [...models];
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return rest;
  }
  return [...models];
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

/**
 * 依次尝试候选模型，返回**第一个真能看图的**那个的结果。
 *
 * 为什么必须有这个（2026-10-03 实测）：宿主声称支持 image 的模型里，可能有实际
 * 不能用的——本机 `opencode-go/space-bunny-free` 就在其列，x_vision_describe
 * 对它返回空。而宿主把「只吃文本的模型」的图片**静默替换**成一段文字（见
 * HOST_IMAGE_OMITTED_MARKER），插件无从区分"模型没话说"和"图片压根没送到"。
 * 若只试一个，一个坏条目就永久废掉整条功能，而用户只看到一句"没有返回任何文字"，
 * 完全不知道还能换谁。
 *
 * @returns {Promise<{text: string, chunks: number, target: object, attempts: Array}>}
 */
export async function describeImageWithFallback({
  llm, candidates, attachment, prompt = DEFAULT_VISION_PROMPT, signal,
}) {
  const attempts = [];
  let last = null;
  for (const target of candidates) {
    try {
      const r = await describeImage({ llm, target, attachment, prompt, signal });
      last = { ...r, target };
      // ⚠️ 顺序要紧：占位符检查必须在"非空即成功"**之前**。
      // 宿主把图片换成文字后，模型会把那段占位符当正文回出来——那是**非空**的，
      // 若先判非空就会当成"看图成功"，用户拿到一段 [image omitted...] 还以为是真的。
      if (r.text.includes(HOST_IMAGE_OMITTED_MARKER)) {
        attempts.push({
          provider: target.provider, model: target.model, ok: false, reason: 'image-not-delivered',
        });
        continue;
      }
      if (r.text !== '') {
        attempts.push({ provider: target.provider, model: target.model, ok: true, chars: r.text.length });
        return { ...r, target, attempts };
      }
      attempts.push({
        provider: target.provider, model: target.model, ok: false, reason: 'empty',
      });
    } catch (err) {
      attempts.push({
        provider: target.provider,
        model: target.model,
        ok: false,
        reason: 'call-failed',
        error: String(err?.message ?? err).slice(0, 160),
      });
    }
  }
  return {
    text: last?.text ?? '',
    chunks: last?.chunks ?? 0,
    target: last?.target ?? candidates[0],
    attempts,
  };
}

const ATTEMPT_REASON = {
  'image-not-delivered': '宿主把图片替换成了文字，该模型实际不吃图',
  empty: '返回空',
  'call-failed': '调用失败',
};

/** 把 attempts 压成一句人能读的话，供 note 使用。 */
export function describeAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  const bad = (a) => `${a.model}（${ATTEMPT_REASON[a.reason] ?? a.reason}${a.error ? `：${a.error}` : ''}）`;
  const ok = attempts.find((a) => a.ok === true);
  const skipped = attempts.filter((a) => a.ok !== true).map(bad);
  if (!ok) return `试过的视觉模型全部不可用：${skipped.join('、')}。`;
  return skipped.length === 0
    ? `由 ${ok.model} 看图。`
    : `${ok.model} 看图成功；已自动跳过 ${skipped.join('、')}。`;
}
