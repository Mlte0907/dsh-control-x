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
import { createRequire } from 'node:module';
import { defineXTool } from './core/tool.js';
import { ControlXError } from './core/errors.js';
import { buildBrowserTools } from './browser/tools.js';
import { buildDesktopTools } from './desktop/tools.js';
import { BrowserManager } from './browser/manager.js';
import { WatchServer, readConfigOverrides } from './browser/watch.js';
import { createActivityTracker, withActivity, ACTIVITY_KIND } from './desktop/activity.js';
import { createDesktopBanner } from './banner-win.js';
import { buildVisionTools } from './vision/tools.js';
import { listVisionModels } from './vision.js';
import { CONTROL_X_SKILL } from './skill.js';
import { createUpdateController } from './core/updater.js';
import { createHostAccessibilityController } from './core/host-accessibility.js';

export const name = 'dsh-control-x';

/** 包版本：真读自己的 package.json。
 *
 * 此前这里写死 '0.0.1'，于是 x_status 报出来的版本永远与实际安装的包对不上——
 * 「装的是哪版」这种第一手事实被谎报，会把排障带偏（2026-10-01 实测踩到）。
 * 用 createRequire 而非 JSON import attribute：宿主直接以 ESM 跑本文件，
 * 不经过打包器，createRequire 在任何 Node ≥ 22 上都稳。
 */
export const version = createRequire(import.meta.url)('../package.json').version ?? 'unknown';

/** tools 必需；skills 机会性消费（不进 inject 声明，见 apply 内 ctx.inject）。 */
export const inject = ['tools'];

/** 插件配置（schemastery）。
 *
 * 关键契约（dsh-context 主机侧注释 + schemastery 实现）：宿主 Config-form generation
 * 只把标记 `.volatile()` 的字段服务到插件页表单并可编辑；普通字段不进表单。
 * volatile 更新是原地提交（不重挂载），所以运行期必须用 getter 实时读取，
 * 不能在 apply 时缓存成普通对象。
 */
export const Config = z.object({
  /** 浏览器是否以无头模式运行（不打扰原则：默认 true）。 */
  headless: z.boolean().default(true).volatile(),
  /** 浏览器可执行文件路径；空 = 自动发现 Chrome/Edge。 */
  browserPath: z.string().default('').volatile(),
  /** 观察快照有效期（毫秒）。过期后动作不直接拒绝：按 RuntimeId 在当前窗口树重新
   *  定位元素并核对身份（角色+名称一致才执行，返回带 revalidated=true），失败才要求
   *  重新观察。TTL 越小越保守；0.5.15 起"观察后思考再动作"不再撞墙。 */
  ttlMs: z.number().default(30000).volatile(),
  /** 桌面操作白名单（应用名）；空 = 不限制。 */
  allowedApps: z.array(z.string()).default([]).volatile(),
  /** 物理输入的用户空闲阈值（毫秒）：用户活跃时拒绝显式打扰路径。0 = 关闭检测（仅测试）。 */
  physicalIdleMs: z.number().default(3000).volatile(),
  /** 「全权操控」：开启后物理键鼠不再逐次请求审批（2026-10-01 用户要求 Agent 能直接按键执行指令）。
   *  空闲检测仍然生效；危险目标（删除/支付/注销）仍然要审批——这个开关不放行不可逆操作。 */
  trustPhysicalInput: z.boolean().default(false).volatile(),
  /** 内置浏览器控制总开关（设置页「X-Agent操控」）；关闭后 x_browser_* 拒绝执行。 */
  browserEnabled: z.boolean().default(true).volatile(),
  /** 忽略 HTTPS 证书校验（仅影响内置浏览器；下次启动浏览器生效）。 */
  ignoreCertErrors: z.boolean().default(false).volatile(),
  /** 内置浏览器空闲回收（毫秒）：无人使用（工具与面板都停）超过此时长即关闭实例并释放内存；0 = 不回收。 */
  browserIdleMs: z.number().default(300000).volatile(),
  /** 电脑控制总开关；关闭后 x_desktop_* 拒绝执行。 */
  desktopEnabled: z.boolean().default(true).volatile(),
  /** 在会话输入框显示 X-Agent 按钮（点击打开右侧浏览器面板）。 */
  inputButtonEnabled: z.boolean().default(true).volatile(),
  /** 视觉模型：'' = 系统推荐，'random' = 每次随机挑一个，或 'provider/model' 指定。
   *  只用于「截图 → 视觉模型 → 文字描述」，给不支持图片输入的会话模型补眼睛。 */
  visionModel: z.string().default('').volatile(),
  // Windows 原生置顶横幅；关掉后只剩 DSH 窗口内的网页横幅。
  desktopBanner: z.boolean().default(true).volatile(),
  /** 横幅浮窗进程停手多久后自动退出（毫秒），下次操控再拉起；0 = 用过一次就不再退出。 */
  bannerIdleExitMs: z.number().default(120000).volatile(),
  /** 自更新的镜像前缀（URL），只在直连失败时兜底；'' = 只走直连。
   *  实测本机直连 GitHub 中位 78ms/523ms，比镜像快 1.4~3 倍，所以默认不开——
   *  它解决的是"直连卡住"而不是"直连慢"。 */
  updateMirror: z.string().default('').volatile(),
  /** 启动时就把 20 个工具全部注册（默认 true）。
   *  关掉可省 20 份工具 schema 的常驻上下文，代价是只能在模型主动调 x_activate
   *  之后才注册——而实测那条路走不到模型面前（2026-10-02）。 */
  eagerRegister: z.boolean().default(true).volatile(),
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
            trustPhysicalInput: { type: 'boolean' },
            browserEnabled: { type: 'boolean' },
            ignoreCertErrors: { type: 'boolean' },
            browserIdleMs: { type: 'number' },
            desktopEnabled: { type: 'boolean' },
            inputButtonEnabled: { type: 'boolean' },
            desktopBanner: { type: 'boolean' },
            bannerIdleExitMs: { type: 'number' },
            visionModel: { type: 'string' },
            updateMirror: { type: 'string' },
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
      version,
      platform: process.platform,
      node: process.version,
      activated: cfg._activated === true,
      config: {
        headless: cfg.headless,
        ttlMs: cfg.ttlMs,
        allowedApps: cfg.allowedApps,
        physicalIdleMs: cfg.physicalIdleMs,
        trustPhysicalInput: cfg.trustPhysicalInput,
        browserEnabled: cfg.browserEnabled,
        ignoreCertErrors: cfg.ignoreCertErrors,
        desktopEnabled: cfg.desktopEnabled,
        inputButtonEnabled: cfg.inputButtonEnabled,
        desktopBanner: cfg.desktopBanner,
        bannerIdleExitMs: cfg.bannerIdleExitMs,
        visionModel: cfg.visionModel,
        updateMirror: cfg.updateMirror,
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
  // volatile 字段在运行期是 Volatile 引用（.get() 取值），且宿主提交编辑是
  // 原地更新、不重挂载插件——因此 cfg 用 getter 实时读取，不能拷贝快照。
  const read = (key) => {
    const raw = config?.[key];
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
    return value;
  };
  const fileOverrides = readConfigOverrides();
  const pick = (key, fallback) => {
    const live = read(key);
    if (live !== undefined) return live;
    return fileOverrides[key] !== undefined ? fileOverrides[key] : fallback;
  };
  const cfg = {
    get headless() { return pick('headless', true) !== false; },
    get browserPath() { const v = pick('browserPath', ''); return typeof v === 'string' ? v : ''; },
    get ttlMs() { const v = pick('ttlMs', 30000); return Number.isFinite(v) ? v : 30000; },
    get allowedApps() { const v = pick('allowedApps', []); return Array.isArray(v) ? v : []; },
    get physicalIdleMs() { const v = pick('physicalIdleMs', 3000); return Number.isFinite(v) ? v : 3000; },
    get trustPhysicalInput() { return pick('trustPhysicalInput', false) === true; },
    get browserEnabled() { return pick('browserEnabled', true) !== false; },
    get ignoreCertErrors() { return pick('ignoreCertErrors', false) === true; },
    get browserIdleMs() { const v = pick('browserIdleMs', 300000); return Number.isFinite(v) && v >= 0 ? v : 300000; },
    get desktopEnabled() { return pick('desktopEnabled', true) !== false; },
    get inputButtonEnabled() { return pick('inputButtonEnabled', true) !== false; },
    get visionModel() { const v = pick('visionModel', ''); return typeof v === 'string' ? v : ''; },
    /** 自更新镜像前缀（可选）：直连失败时兜底。 */
    get updateMirror() { const v = pick('updateMirror', ''); return typeof v === 'string' ? v.trim() : ''; },
    /** 启动即注册全部工具（否则只在 x_activate 之后注册，而实测那条路到不了模型）。 */
    get eagerRegister() { return pick('eagerRegister', true) !== false; },
    // 桌面置顶横幅（Windows 原生浮窗）。关掉后只剩网页内横幅。
    get desktopBanner() { return pick('desktopBanner', true) !== false; },
    // 横幅浮窗空闲退出阈值。0.5.9 及之前漏了这个 getter，cfg.bannerIdleExitMs 恒为
    // undefined：不仅设置页改了不生效（banner-win 拿默认值 120000 兜底），还让
    // x_status 的返回值带上 undefined 字段、被宿主判「value is not lossless JSON」。
    get bannerIdleExitMs() { const v = pick('bannerIdleExitMs', 120000); return Number.isFinite(v) && v >= 0 ? v : 120000; },
    // 内部状态（非配置面）。
    _activated: false,
  };
  const browserManager = new BrowserManager(cfg);
  // 桌面操控活动：x_desktop_* 每次起止都记一笔，客户端顶部横幅据此显示。
  // 桌面置顶横幅（Windows 原生浮窗）。
  // 网页内横幅只画在 DSH 窗口的渲染层：Agent 操控记事本时用户盯着记事本，DSH 窗口在后面，
  // 横幅被压在下面——2026-10-01 实测这就是"横幅没提示"的真因（截图证明横幅本身正常）。
  // 要在任何应用之上被看见，只能起一个真正的置顶窗口。
  //
  // 按需拉起（2026-10-01）：原来这里直接 start()，浮窗随 DSH 启动就常驻，
  // 即使从头到尾没操控过也留一个 powershell 进程在轮询。改成由活动钩子触发——
  // 第一次真的动手时才起，浮窗再自己按 idleExitMs 退掉。
  const bannerTheme = { bg: '', fg: '' };
  let banner = null;
  const activity = createActivityTracker({
    onBegin: () => {
      if (!cfg.desktopBanner || banner === null) return;
      if (banner.start()) ctx.logger?.info?.('dsh-control-x: 桌面置顶横幅已按需拉起（原生置顶浮窗）');
    },
  });
  banner = createDesktopBanner({
    activity,
    getTheme: () => bannerTheme,
    idleExitMs: cfg.bannerIdleExitMs,
  });
  ctx.effect?.(() => () => banner.stop());

  // 插件卸载/重载（含设置页 toggle）时释放浏览器实例：
  // headless 实例是 9 个进程、数百 MB 的常驻树，不释放会在关掉插件后继续跑。
  ctx.effect?.(() => () => { browserManager.shutdown().catch(() => undefined); });

  /** 总开关门控：设置页关闭后工具拒绝执行（getter 实时生效，无需重启）。 */
  const gate = (tool, flagKey, message) => {
    const inner = tool.execute;
    return {
      ...tool,
      execute: async (args, exec) => {
        if (cfg[flagKey] === false) {
          throw new ControlXError(message, { code: 'ACTION_UNAVAILABLE' });
        }
        return inner(args, exec);
      },
    };
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
    // 工具与面板共用同一个 BrowserManager（否则面板看不到工具打开的标签页）。
    // 浏览器动作也记活动（kind='browser'）：它不碰用户屏幕，但用户必须知道
    // Agent 正在网上跑腿，否则侧栏/横幅毫无反应、看起来像卡死。
    for (const tool of withActivity(buildBrowserTools(ctx, cfg, browserManager), activity, { kind: ACTIVITY_KIND.BROWSER })) {
      safeRegister(gate(tool, 'browserEnabled', '浏览器控制已关闭：在设置页「X-Agent操控」开启“开启内置浏览器控制”后重试。'));
    }
    for (const tool of withActivity(buildDesktopTools(ctx, cfg), activity, { kind: ACTIVITY_KIND.DESKTOP })) {
      safeRegister(gate(tool, 'desktopEnabled', '电脑控制已关闭：在设置页「X-Agent操控」开启“启用电脑控制”后重试。'));
    }
    // 视觉工具：截图 → 视觉模型 → 文字。不设总开关门控——它是给"看不见图"的会话模型
    // 补能力的最后一段路，浏览器面/桌面面关掉时它依然有意义。
    for (const tool of buildVisionTools(ctx, cfg, { browserManager })) {
      safeRegister(tool);
    }
    cfg._activated = true;
    const delta = registered.length - baseline;
    baseline = registered.length;
    ctx.logger?.info?.(`dsh-control-x: 已激活，新注册 ${delta} 个工具`);
    return delta;
  };

  safeRegister(buildActivateTool(ctx, cfg, registerCapabilities));

  // 启动即注册（2026-10-02 用户实测逼出来的）。
  //
  // 现象：把 20 个工具藏在 x_activate 后面，宿主侧注册是成功的
  // （x_activate 返回 toolCount=20），但**模型这一侧的工具表里始终没有它们**——
  // 重启过、新开会话过、连调 x_activate 都不行；而 apply() 时就注册的两个
  // 工具（x_status / x_activate）一直都在。
  //
  // 最合理的解释：宿主在**会话建立时**给模型发一份工具清单，之后注册的工具不再补发。
  // 于是"运行期注册"等于"注册了个寂寞"。这不是审批门、也不是总开关的问题——
  // 那是两道完全不同的关，排查时别混。
  //
  // 代价是 20 份工具 schema 的常驻上下文。eagerRegister=false 可以退回旧行为
  // （省上下文，但工具要等模型主动调 x_activate 才会注册——而那条路现在看是走不通的）。
  if (cfg.eagerRegister) {
    registerCapabilities();
    ctx.logger?.info?.('dsh-control-x: 已在启动时注册全部工具（eagerRegister）');
  }

  // control-x skill 机会性注册：宿主挂了 dsh-skill 才有 ctx.skills。
  ctx.inject?.(['skills'], (sctx) => {
    try {
      sctx.skills.register(CONTROL_X_SKILL);
      sctx.logger?.info?.('dsh-control-x: control-x skill 已注册');
    } catch (err) {
      sctx.logger?.warn?.(`dsh-control-x: skill 注册失败: ${err?.message}`);
    }
  });

  // 面板（官方原生右侧面板 + 设置页）的数据面：webServer 路由。
  ctx.inject?.(['webServer'], (wctx) => {
    try {
      const webServer = wctx.get?.('webServer') ?? wctx.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      // 自更新控制器：设置页「版本与更新」卡片的数据源与执行器。
      // 换装会替换掉本进程正在用的代码目录，所以换装后必须重启宿主才生效——
      // 这一点由返回值 restartRequired 如实带给用户，不假装热更新。
      // mirror 传函数：设置页改镜像后即时生效，不必重启插件。
      // runningVersion 告诉客户端「现在真正在跑哪版」：换装后磁盘版本立刻变新，
      // 客户端靠两者的差值持续显示「重启生效」，不会被 60s 后的例行检查冲掉。
      const updater = createUpdateController({ logger: ctx.logger, mirror: () => cfg.updateMirror, runningVersion: version });
      // 桌面观察开关的后端：检测/写入宿主快捷方式的无障碍旗标。
      // 只在设置页用户显式点击（POST）时才写；detect 只读。
      const hostAccessibility = createHostAccessibilityController();
      // cfg 是 getter（读取 volatile/文件覆盖）；面板保存只更新文件覆盖层。
      const watch = new WatchServer(browserManager, (patch, saved) => {
        Object.assign(fileOverrides, patch);
        return saved;
      }, activity, () => listVisionModels(ctx.get?.('llm')), {
        info: () => ({ overlay: banner.available, theme: bannerTheme }),
        theme: bannerTheme,
      }, updater, hostAccessibility);
      wctx.effect?.(() => watch.attach(webServer)) ?? watch.attach(webServer);
      wctx.logger?.info?.('dsh-control-x: 面板路由已注册（/api/x-control/*）');
    } catch (err) {
      wctx.logger?.warn?.(`dsh-control-x: 面板路由注册失败: ${err?.message}`);
    }
  });

  ctx.logger?.info?.(`dsh-control-x: 已注册 ${registered.length} 个常驻工具（${registered.join(', ')}）`);
}

export default { name, inject, Config, apply };
