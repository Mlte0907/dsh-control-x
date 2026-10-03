/**
 * 视觉工具：把截图交给视觉模型，换回一段文字给 Agent 读。
 *
 * 存在的理由（2026-10-01 真机实测）：会话模型 space-bunny-free 不支持图片输入，
 * 宿主对 read_image 的原话是「model "space-bunny-free" does not declare image input」。
 * 截图工具能拍出真图，但图片内容到不了模型——所以由插件代跑一次视觉模型，
 * 把结果转成**文字**再交回去。不支持视觉的会话模型也能用。
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { defineXTool } from '../core/tool.js';
import { toToolResult, ControlXError } from '../core/errors.js';
import {
  listVisionModels, candidateModels, describeImageWithFallback, describeAttempts, pickModel,
  DEFAULT_VISION_PROMPT, VISION_AUTO, VISION_RANDOM,
} from '../vision.js';

/** 文件头嗅探（比扩展名可信：用户可能拿到 `.png` 后缀的 JPEG）。 */
const MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mediaType: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mediaType: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mediaType: 'image/gif' },
];
const BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

function sniffImageMediaType(data) {
  for (const m of MAGIC) {
    if (data.length >= m.bytes.length && m.bytes.every((b, i) => data[i] === b)) return m.mediaType;
  }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/**
 * `file_path` 入参的实现：读本机图片 → 存进宿主 attachments → 变成合法引用。
 *
 * 为什么需要它（2026-10-03 真机会话 238eddfb step33-36）：会话模型只吃文本，
 * 宿主 read_image 拒（model does not declare image input），而本工具此前**只收
 * attachment 引用/ tab_id**——模型生成完图片想验收，三次都拿旧截图的 attachmentId
 * 硬凑，视觉模型反复答"我看到的是豆包界面截图，不是那张长图"，最后只能用 PowerShell
 * 解析 PNG 头+数颜色来"验图"。纯文本模型 + 图落在工作区 = 没有验图通道。
 */
async function attachmentFromFilePath(ctx, filePath) {
  const attachments = ctx.get?.('attachments');
  if (!attachments || typeof attachments.saveImage !== 'function') {
    throw new ControlXError(
      `当前环境未挂载 attachments 服务，无法把本地图片交给视觉模型：${filePath}`,
      { code: 'ACTION_UNAVAILABLE' },
    );
  }
  let data;
  try {
    data = await readFile(filePath);
  } catch (err) {
    // 必须点名路径：模型要能据此自己发现是路径写错了，而不是被一句"缺少图片附件"指错方向。
    throw new ControlXError(
      `读不到图片文件：${filePath}（${err?.code ?? err?.message ?? String(err)}）`,
      { code: 'APP_NOT_FOUND' },
    );
  }
  const mediaType = sniffImageMediaType(data) ?? BY_EXT[extname(filePath).toLowerCase()];
  if (!mediaType) {
    throw new ControlXError(
      `不是可识别的图片文件（只认 PNG/JPEG/WebP/GIF）：${filePath}`,
      { code: 'ACTION_UNAVAILABLE' },
    );
  }
  const name = basename(filePath);
  const ref = await attachments.saveImage({ data, mediaType, name });
  // 宿主 ImageAttachmentRef 五个字段全必填，读图时逐项与实际字节比对
  // （少一个就报 "Stored attachment metadata does not match its reference"，0.5.22 踩过）。
  const out = {
    attachmentId: ref?.attachmentId, mediaType: ref?.mediaType ?? mediaType,
    bytes: ref?.bytes ?? data.length, width: ref?.width, height: ref?.height, name: ref?.name ?? name,
  };
  const missing = ['attachmentId', 'mediaType', 'bytes', 'width', 'height'].filter((k) => out[k] === undefined);
  if (missing.length > 0) {
    throw new ControlXError(
      `attachments 服务返回的引用缺字段 ${missing.join('、')}（文件：${filePath}）——`
      + '宿主读图要逐项核对元数据，缺字段会被整单拒绝。',
      { code: 'INTERNAL' },
    );
  }
  return out;
}

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
        '让视觉模型看一张图片并返回文字描述。**会话模型只吃文本、看不见图片时**用它"看懂"画面。' +
        '传图三种方式：① 把 x_browser_shot **或 x_desktop_shot** 返回的 image 字段整个传进 attachment'
        + '（桌面窗口只能走这条——degraded 应用的无障碍树是空的）；② 给 tab_id 让本工具现拍一张浏览器标签页；'
        + '③ 给 file_path 让它读本机图片文件——**生成/下载到工作区的图用这条验收**'
        + '（图不在会话里时，attachment 和 tab_id 都拿不到它）。' +
        '⚠️ 传 attachment 时**必须把 image 对象原样整个传进来**，一个字段都别删——' +
        '少字段会被参数校验拒绝。' +
        '模型按设置页「视觉模型」选择（系统推荐 / 随机 / 指定）。' +
        '系统推荐会按宿主给出的顺序逐个尝试，第一个真能看图的那个胜出——' +
        '因为宿主声称支持图片的模型里可能有实际不能用的（宿主对这类模型会**静默**' +
        '把图片替换成文字、不报错）。返回的 attempts 会告诉你每个模型的结果。',
      parameters: {
        type: 'object',
        properties: {
          // ⚠️ 必须把五个字段**逐个列出**，不能只写裸 {type:'object'}（2026-10-03 修）。
          //
          // 之前这里只声明 `attachment: { type: 'object', required: true }`。在严格模式的
          // 函数调用校验下，「没声明 properties」等于「没有字段被定义」，于是模型传进来的
          // 引用被拒——2026-10-03 真机压测（会话 DzjC8UU32GL7）里 Agent 反复撞这一条：
          //   seq 256「schema 报错，不传 attachment 也报错。这是工具的 bug」
          //   seq 311「这回传 attachment 对象里某些字段不让传」
          // 它自己最后改了调用方式绕过去，而那句"这是工具的 bug"判得没错。
          //
          // 字段集与宿主 ImageAttachmentRef 一致（dsh-agent-preset-registry 的类型声明）。
          attachment: {
            type: 'object',
            // ⚠️ 这里**不能**写 `required: true`（2026-10-03 修）：
            // toHostSchema 会把它提升成宿主实际收到的 `parameters.required = ["attachment"]`，
            // 等于对模型宣布"必填"，而 tab_id 捷径与工具自拍（execute 里的 shot 兜底）
            // 都是合法替代——真机 session-32c83987 只传 tab_id 两次成功，证明它不是必填。
            // "必填"还会把模型每次都推向 attachment 校验那条路（曾崩在 core/tool.js:77）。
            properties: {
              attachmentId: { type: 'string', description: '形如 sha256:<64位十六进制>。' },
              mediaType: { type: 'string', description: 'image/png | image/jpeg | image/webp | image/gif。' },
              bytes: { type: 'integer', description: '图片字节数。' },
              width: { type: 'integer', description: '像素宽。' },
              height: { type: 'integer', description: '像素高。' },
              name: { type: 'string', description: '可选，原始文件名。' },
            },
            description:
              '图片引用。**x_browser_shot 或 x_desktop_shot 返回的 image 字段，原样整个传进来**'
              + '（attachmentId / mediaType / bytes / width / height，name 可选）。'
              + '桌面截图用 x_desktop_shot——degraded 窗口只能靠这条路。',
          },
          tab_id: {
            type: 'string',
            description:
              '可选：给**浏览器标签页** id 则先现拍一张再识别（比先截图再识别少一次往返）。'
              + '桌面窗口没有 tab_id，桌面截图请用 attachment。',
          },
          file_path: {
            type: 'string',
            description:
              '可选：**本机图片文件的完整路径**（刚生成/下载到工作区的那张图）。'
              + '会读文件字节交给视觉模型——用来验收「图已经落盘、但不在会话里」的场景。'
              + '与 attachment 二选一（都没给、也没给 tab_id 时会报错说明缺图）。',
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
          attempts: {
            type: 'array',
            required: true,
            description: '每个候选视觉模型的尝试结果（哪个看图成功、哪个被跳过及原因）。',
          },
          note: { type: 'string', required: true },
        },
        required: true,
      },
      isConcurrencySafe: false,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const models = await listVisionModels(llm());
        const candidates = candidateModels(models, cfg.visionModel);
        let attachment = args.attachment;
        if (attachment === undefined && typeof args.file_path === 'string' && args.file_path.trim() !== '') {
          attachment = await attachmentFromFilePath(ctx, args.file_path.trim());
        }
        if (args.tab_id !== undefined && browserManager) {
          // attachments 必须传：manager.shot() 拿不到它就直接抛「未挂载 attachments 服务」
          // （lib/browser/manager.js 的 shot()）。2026-10-02 修——此前这里传的是 `{}`，
          // 于是本工具 description 明确宣传的「或直接给 tab_id 让本工具现拍一张」那条
          // 捷径**必然失败**，且报错信息（说环境没挂 attachments）完全指错了方向。
          const shot = await browserManager.shot(browserManager.requireTabId(args.tab_id), {
            attachments: ctx.get?.('attachments'),
          });
          attachment = shot?.image ?? shot;
        }
        const { text, chunks, target, attempts } = await describeImageWithFallback({
          llm: llm(),
          candidates,
          attachment,
          prompt: args.prompt ?? DEFAULT_VISION_PROMPT,
          signal: exec?.signal,
        });
        const trail = describeAttempts(attempts);
        return {
          ok: true,
          provider: target.provider,
          model: target.model,
          text,
          chars: text.length,
          attempts,
          note: text === ''
            ? `视觉模型全部没返回文字。${trail}换模型或换个问法；若宿主只接了一个候选，`
              + '那多半是这个模型实际不吃图（宿主会把图片替换成文字且不报错）。'
            : `视觉模型 ${target.model} 的描述（${chunks} 个流式块）。${trail}图片已转述完毕，勿再据此猜测画面。`,
        };
      }),
    }),
  ];
}

export { listVisionModels, pickModel, candidateModels, VISION_AUTO, VISION_RANDOM };
