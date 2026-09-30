/**
 * dsh-control-x 插件入口。
 *
 * 形态依据（docs/DSH-SDK-CONTRACT.md）：
 * - cordis 插件：ESM 导出 name / inject / Config / apply(ctx, config)。
 * - 工具经 ctx.tools.register(definition) 注册；definition 是普通对象 +
 *   原生 JSON Schema（宿主 register 源码 :2878-2887 证实无身份检查）。
 * - 刻意不 import 任何 @deepseek-ai/dsh-* 模块（§9：版本漂移与解析不可达）。
 *
 * Skill 门控（M3，Anionex 先例）：常驻只注册 x_status + x_activate，
 * 模型调用 x_activate 后才注册完整工具词汇表；control-x skill 经
 * ctx.skills.register 注册（dsh-skill/lib/index.js:193），机会性注入——
 * 宿主没挂 dsh-skill 时插件其余功能不受影响。
 *
 * 失败边界：apply 内任何初始化错误都被捕获，最坏情况只注册 x_status。
 */
import z from '@deepseek-ai/schemastery';
import { defineXTool } from './core/tool.js';
import { buildBrowserTools } from './browser/tools.js';
import { buildDesktopTools } from './desktop/tools.js';
import { CONTROL_X_SKILL } from './skill.js';

export const name = 'dsh-control-x';

/** tools 必需；skills 机会性消费（不进 inject 声明，见 apply 内 ctx.inject）。 */
export const inject = ['tools'];

/** 插件配置（schemastery）。 */
export const Config = z.object({
  /** 浏览器是否以无头模式运行（不打扰原则：默认 true）。 */
  headless: z.boolean().default(true),
  /** 浏览器可执行文件路径；空 = 自动发现 Chrome/Edge。 */
  browserPath: z.string().default(''),
  /** 观察快照有效期（毫秒），过期后动作拒绝并要求重新观察。 */
  ttlMs: z.number().default(30000),
  /** 桌面操作白名单（应用名）；空 = 不限制。 */
  allowedApps: z.array(z.string()).default([]),
  /** 物理输入的用户空闲阈值（毫秒）：用户活跃时拒绝显式打扰路径。0 = 关闭检测（仅测试）。 */
  physicalIdleMs: z.number().default(3000),
});

/** 状态工具：报告门控状态，只返回确定性事实。 */
function buildStatusTool(cfg) {
  return defineXTool({
    name: 'x_status',
    description:
      '查看 dsh-control-x 插件状态：能力面是否已激活、关键配置。' +
      '若 capabilities 均为 false，先调用 x_activate。',
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        plugin: { type: 'string' },
        version: { type: 'string' },
        platform: { type: 'string' },
        node: { type: 'string' },
        activated: { type: 'boolean', description: '完整工具词汇表是否已注册' },
        config: {
          type: 'object',
          properties: {
            headless: { type: 'boolean' },
            ttlMs: { type: 'number' },
            allowedApps: { type: 'array', items: { type: 'string' } },
            physicalIdleMs: { type: 'number' },
          },
          required: true,
        },
      },
      required: true,
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isConcurrencySafe: true,
    execute: async () => ({
      ok: true,
      plugin: name,
      version: '0.0.1',
      platform: process.platform,
      node: process.version,
      activated: cfg._activated === true,
      config: {
        headless: cfg.headless,
        ttlMs: cfg.ttlMs,
        allowedApps: cfg.allowedApps,
        physicalIdleMs: cfg.physicalIdleMs,
      },
    }),
  });
}

/** 门控入口：调用后注册完整工具词汇表（幂等）。 */
function buildActivateTool(ctx, cfg, registerCapabilities) {
  return defineXTool({
    name: 'x_activate',
    description:
      '激活 dsh-control-x 的完整能力面（浏览器 10 工具 + 桌面 9 工具）。' +
      '幂等：重复调用安全。激活后请加载 control-x skill 并按其循环操作。',
    parameters: {},
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', required: true },
        activated: { type: 'boolean', required: true },
        skill: { type: 'string', required: true },
        toolCount: { type: 'integer', required: true },
      },
      required: true,
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isConcurrencySafe: true,
    execute: async () => {
      const count = registerCapabilities();
      return { ok: true, activated: true, skill: CONTROL_X_SKILL.name, toolCount: count };
    },
  });
}

export function apply(ctx, config) {
  const cfg = {
    headless: config?.headless !== false,
    browserPath: typeof config?.browserPath === 'string' ? config.browserPath : '',
    ttlMs: Number.isFinite(config?.ttlMs) ? config.ttlMs : 30000,
    allowedApps: Array.isArray(config?.allowedApps) ? config.allowedApps : [],
    physicalIdleMs: Number.isFinite(config?.physicalIdleMs) ? config.physicalIdleMs : 3000,
    // 内部状态（非配置面）。
    _activated: false,
  };

  const registered = [];
  const safeRegister = (tool) => {
    try {
      ctx.tools.register(tool);
      registered.push(tool.name);
      return true;
    } catch (err) {
      ctx.logger?.warn?.(`dsh-control-x: 注册 ${tool?.name ?? '未知工具'} 失败: ${err?.message}`);
      return false;
    }
  };

  safeRegister(buildStatusTool(cfg));

  let registeredCount = registered.length;
  let baseline = registeredCount; // 激活注册的基准线：幂等调用返回"本次新增数"
  const registerCapabilities = () => {
    if (cfg._activated) {
      const delta = registered.length - baseline;
      baseline = registered.length;
      return delta;
    }
    baseline = registered.length;
    for (const tool of buildBrowserTools(ctx, cfg)) safeRegister(tool);
    for (const tool of buildDesktopTools(ctx, cfg)) safeRegister(tool);
    cfg._activated = true;
    const delta = registered.length - baseline;
    baseline = registered.length;
    ctx.logger?.info?.(`dsh-control-x: 已激活，新注册 ${delta} 个工具`);
    return delta;
  };

  safeRegister(buildActivateTool(ctx, cfg, registerCapabilities));

  // control-x skill 机会性注册：宿主挂了 dsh-skill 才有 ctx.skills。
  ctx.inject?.(['skills'], (sctx) => {
    try {
      sctx.skills.register(CONTROL_X_SKILL);
      sctx.logger?.info?.('dsh-control-x: control-x skill 已注册');
    } catch (err) {
      sctx.logger?.warn?.(`dsh-control-x: skill 注册失败: ${err?.message}`);
    }
  });

  ctx.logger?.info?.(`dsh-control-x: 已注册 ${registered.length} 个常驻工具（${registered.join(', ')}）`);
}

export default { name, inject, Config, apply };
