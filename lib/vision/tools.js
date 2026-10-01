/**
 * 视觉工具：把截图交给视觉模型，换回一段文字给 Agent 读。
 *
 * 存在的理由（2026-10-01 真机实测）：会话模型 space-bunny-free 不支持图片输入，
 * 宿主对 read_image 的原话是「model "space-bunny-free" does not declare image input」。
 * 截图工具能拍出真图，但图片内容到不了模型——所以由插件代跑一次视觉模型，
 * 把结果转成**文字**再交回去。不支持视觉的会话模型也能用。
 */
import { defineXTool } from '../core/tool.js';
import { toToolResult } from '../core/errors.js';
import {
  listVisionModels, pickModel, describeImage,
  DEFAULT_VISION_PROMPT, VISION_AUTO, VISION_RANDOM,
} from '../vision.js';

/**
 * @param {object} ctx cordis 上下文（需要 get('llm')）
 * @param {object} cfg 归一配置（含 visionModel）
 * @param {object} deps { browserManager } 用于 tab_id 便捷截图
 */
export function buildVisionTools(ctx, cfg, { browserManager } = {}) {
  const llm = () => ctx.get?.('llm');

  return [
    defineXTool({
      name: 'x_vision_describe',
      description:
        '让视觉模型看一张截图并返回文字描述。当会话模型不支持图片输入时用它"看懂"画面：' +
        '先 x_browser_shot 拿到 image 引用，再把该引用传进来；或直接给 tab_id 让本工具现拍一张。' +
        '模型按设置页「视觉模型」选择（系统推荐 / 随机 / 指定）。',
      parameters: {
        type: 'object',
        properties: {
          attachment: {
            type: 'object',
            required: true,
            description: 'x_browser_shot 返回的 image 引用（attachmentId/mediaType/width/height 等）。',
          },
          tab_id: {
            type: 'string',
            description: '可选：给标签页 id 则先现拍一张再识别（比先截图再识别少一次往返）。',
          },
          prompt: {
            type: 'string',
            description: `可选：想看什么。默认：${DEFAULT_VISION_PROMPT}`,
          },
        },
        required: [],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          text: { type: 'string', required: true },
          chars: { type: 'integer', required: true },
          note: { type: 'string', required: true },
        },
        required: true,
      },
      isConcurrencySafe: false,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const models = await listVisionModels(llm());
        const target = pickModel(models, cfg.visionModel);
        let attachment = args.attachment;
        if (args.tab_id !== undefined && browserManager) {
          const shot = await browserManager.shot(browserManager.requireTabId(args.tab_id), {});
          attachment = shot?.image ?? shot;
        }
        const { text, chunks } = await describeImage({
          llm: llm(),
          target,
          attachment,
          prompt: args.prompt ?? DEFAULT_VISION_PROMPT,
          signal: exec?.signal,
        });
        return {
          ok: true,
          provider: target.provider,
          model: target.model,
          text,
          chars: text.length,
          note: text === ''
            ? `视觉模型 ${target.model} 没有返回任何文字（收到 ${chunks} 个流式块）。可换模型或换个问法。`
            : `视觉模型 ${target.model} 的描述（${chunks} 个流式块）。图片已转述完毕，勿再据此猜测画面。`,
        };
      }),
    }),
  ];
}

export { listVisionModels, pickModel, VISION_AUTO, VISION_RANDOM };
