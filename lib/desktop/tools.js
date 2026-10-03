/**
 * x_desktop_* 工具组：Windows UIA 语义观察与动作。
 *
 * 教学集中在 description：先观察（编号树）→ 按编号动作 → 重新观察验证；
 * 所有动作经 UIA 模式执行，不注入键鼠事件、不抢前台焦点；
 * 键盘物理输入（SendInput）属"显式打扰"路径，M3 与审批集成后开放（§6.7-4）。
 */
import { defineXTool } from '../core/tool.js';
import { toToolResult, ControlXError } from '../core/errors.js';
import { isDangerousLabel, requestApproval, refusalMessage } from '../core/guard.js';
import { assertUserIdle, activateWindow, clickAt, typeUnicode, pressChord } from './physical.js';
import { DesktopManager } from './manager.js';

const WINDOW_TARGET_SCHEMA = {
  pid: { type: 'integer', description: '目标进程 pid（来自 x_desktop_apps）。' },
  title: { type: 'string', description: '窗口标题子串。pid 优先；两者都缺省时若命中多个窗口会被拒绝。' },
  hwnd: { type: 'integer', description: '窗口句柄（x_desktop_apps / x_desktop_tree 输出），最精确。' },
};

const windowInfoSchema = {
  type: 'object',
  properties: {
    pid: { type: 'integer' },
    title: { type: 'string' },
    className: { type: 'string' },
    hwnd: { type: 'integer' },
    processName: { type: 'string' },
  },
  required: true,
};

/**
 * @param {object} ctx cordis 上下文。
 * @param {object} cfg 归一配置（ttlMs/allowedApps）。
 */
/** 等待窗口（0.5.34）：单个动作里最多睡 10 秒——再久会把整轮任务吊住。 */
export const WAIT_MS_MIN = 100;
export const WAIT_MS_MAX = 10000;

/** 把 ms 夹进 [MIN, MAX]；非数字回 1000（测试钉住，免得改常量没人知道）。 */
export function clampWaitMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 1000;
  if (n < WAIT_MS_MIN) return WAIT_MS_MIN;
  if (n > WAIT_MS_MAX) return WAIT_MS_MAX;
  return Math.round(n);
}

export function buildDesktopTools(ctx, cfg, { manager: managerOverride, shotFlash = () => false, pointMarker = () => false } = {}) {
  // manager 可注入（测试用假 manager 走通 x_desktop_shot / x_desktop_click_at 的整条链路）；
  // shotFlash = 截图取景框、pointMarker = 坐标点击的点位标记（lib/shot-frame.js），
  // 两者都缺省 no-op——不传就不画。**两者都绝不 await**：提示是装饰，不能拖慢动作。
  const manager = managerOverride ?? new DesktopManager(cfg);
  const physicalIdleMs = Number.isFinite(cfg.physicalIdleMs) ? cfg.physicalIdleMs : 3000;

  /** 危险目标护栏：元素名命中危险词 → 审批（fail-closed）。 */
  const guardDangerous = async (exec, toolName, label) => {
    if (!isDangerousLabel(label)) return;
    const outcome = await requestApproval(
      ctx, exec, toolName,
      `即将对桌面元素"${label}"执行 ${toolName}——可能触发删除/支付/注销等不可逆操作，是否继续？`,
    );
    if (outcome !== 'allowed-once') {
      throw new ControlXError(refusalMessage(outcome, `对"${label}"的动作`), {
        code: outcome === 'unavailable' ? 'NOT_AUTHORIZED' : 'PERMISSION_DENIED',
        details: { outcome, label },
      });
    }
  };

  /**
   * 物理输入门控序列：空闲检测 → 审批（或显式确认 / 信任开关）→ 返回明示文案。
   *
   * `confirm` 之前是**收了但从不看**的：参数在 schema 与描述里都写成了"审批服务不可用时
   * 的出口"，可这里从来没用过它，于是真出问题时模型显式自认也救不了（实测 2026-10-01
   * 在审批被会话策略自动拒绝时，连传 confirm_disturbance 仍被挡）。
   *
   * 三种放行，互不重叠：
   *   1. trustPhysicalInput = true —— 用户在设置里明确授权"全权操控"，连审批都不问；
   *   2. outcome === 'allowed-once' —— 用户当场点了允许；
   *   3. outcome === 'unavailable' && confirm === true —— 没有审批应答器，模型显式自认。
   * 'rejected' 表示**确实有人点了拒绝**，这种情况永远不放行，自认也不行。
   * 注意危险目标（删除/支付/注销）走的是 guardDangerous，不受这个开关影响。
   *
   * 「全权操控」是**每次现读** cfg 的（2026-10-02 修）：原先在 buildDesktopTools 里
   * `const trustPhysicalInput = cfg.trustPhysicalInput === true;` 把它快照成了常量，
   * 于是用户在设置页打开这个开关后**必须重载插件才生效**——而同文件里所有其他设置
   * （physicalIdleMs 等）都是实时 getter 读的，行为不一致。实测：开关从 false 翻到 true
   * 之后工具仍在请求审批（PERMISSION_DENIED），而 cfg.trustPhysicalInput 确实已读到 true。
   */
  const guardPhysical = async (exec, toolName, label, confirm) => {
    assertUserIdle(physicalIdleMs);
    if (cfg.trustPhysicalInput === true) {
      return '用户已开启「全权操控」，本次不再逐次审批：';
    }
    const outcome = await requestApproval(
      ctx, exec, toolName,
      `物理输入将前置目标窗口并移动用户真实光标${label ? `（目标"${label}"）` : ''}——是否允许这次打扰？`,
    );
    if (outcome === 'allowed-once') {
      return '已获用户批准的显式打扰：';
    }
    if (outcome === 'unavailable') {
      // 审批服务不在：模型显式自认打扰（结果仍会向用户明示）即可继续。
      if (confirm === true) {
        return '显式打扰（审批服务不可用，已由动作参数确认）：';
      }
      throw new ControlXError(
        `${refusalMessage(outcome, '物理输入')}（如确需本次操作，请传 confirm_disturbance: true 显式自认打扰）`,
        { code: 'NOT_AUTHORIZED', details: { outcome } },
      );
    }
    throw new ControlXError(refusalMessage(outcome, '物理输入'), {
      code: 'PERMISSION_DENIED',
      details: { outcome },
    });
  };

  return [
    defineXTool({
      name: 'x_desktop_apps',
      description:
        '列出当前桌面上的顶层应用窗口（pid/进程名/标题/是否前台）。' +
        '要操作某个应用前先调用本工具确定目标，再对它 x_desktop_tree。',
      parameters: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                pid: { type: 'integer' }, processName: { type: 'string' }, title: { type: 'string' },
                className: { type: 'string' }, hwnd: { type: 'integer' }, focused: { type: 'boolean' },
              },
            },
          },
        },
        required: true,
      },
      isConcurrencySafe: true,
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async () => manager.listApps()),
    }),

    defineXTool({
      name: 'x_desktop_tree',
      description:
        '观察目标窗口：返回带编号的控件树（角色/名称/是否密码框/支持的语义模式）与观察 id。' +
        '之后用 x_desktop_press / x_desktop_value 传 observation+element 编号动作。' +
        '观察不产生任何输入、不抢焦点，后台窗口也可完整观察。' +
        'truncated=true 表示树在 max_elements 处被截断：控件"不存在"时先怀疑截断，' +
        '调大 max_elements 重观察，不要下结论。动作前必须先观察；界面变化后必须重新观察，绝不复用旧编号。',
      parameters: {
        type: 'object',
        properties: {
          ...WINDOW_TARGET_SCHEMA,
          max_elements: { type: 'integer', description: '最多返回的编号元素数，默认 400（复杂应用如飞书的完整树可达 400+）。' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          window: windowInfoSchema,
          observation: { type: 'string', required: true },
          ttlMs: { type: 'integer', required: true },
          tree: { type: 'string', required: true },
          elementCount: { type: 'integer', required: true },
          namedCount: { type: 'integer', required: true, description: '有可访问名称的元素个数——判断这棵树好不好用的关键指标。' },
          truncated: { type: 'boolean', required: true },
          degraded: {
            type: 'boolean', required: true,
            description: 'true = 这棵树不可作为主干（Electron/Chromium 未物化无障碍树）。'
              + '此时语义动作基本不可用，请改走 x_desktop_shot + x_desktop_click_at，或 x_desktop_key/type。',
          },
          degradedReason: { type: 'string', description: 'degraded=true 时给出原因与建议路径。' },
          elapsedMs: { type: 'integer' },
        },
        required: true,
      },
      isConcurrencySafe: true,
      render: (_a, v) => [{ type: 'text', text: JSON.stringify({ ...v, tree: v.tree }, null, 2) }],
      execute: toToolResult(async (args) => {
        const result = await manager.observe({
          pid: args.pid, title: args.title, hwnd: args.hwnd, maxElements: args.max_elements,
        });
        const namedCount = result.elements.filter((el) => typeof el.name === 'string' && el.name.trim() !== '').length;
        return {
          ...result,
          elementCount: result.elements.length,
          namedCount,
          truncated: result.truncated === true,
          degraded: result.degraded === true,
          ...(result.degraded ? { degradedReason: result.degradedReason } : {}),
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_press',
      description:
        '对观察到的元素执行语义动作（点击按钮/菜单项、切换开关、选中列表项等，经 UIA Invoke/Toggle/Select 模式）。' +
        '不注入鼠标事件、不移动真实光标、不抢前台焦点。' +
        '元素会按其通告的模式自动选择；不通告任何语义动作的元素会被拒绝（不要猜）。' +
        '动作后必须重新观察验证效果。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true, description: 'x_desktop_tree 返回的观察 id。' },
          element: { type: 'integer', required: true, description: '该次观察里的元素编号（#N）。' },
          action: { type: 'string', description: '默认 auto：按通告模式自动选择。可显式指定 Invoke/Toggle/SelectionItem/ExpandCollapse。' },
        },
        required: ['observation', 'element'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          used: { type: 'string' }, observation: { type: 'string' },
          revalidated: { type: 'boolean', description: '快照已过期但元素按 RuntimeId 重新定位且身份核对一致，动作照常执行。' },
          window: windowInfoSchema, hint: { type: 'string' },
        },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const { el } = manager.peek(args.observation, args.element);
        await guardDangerous(exec, 'x_desktop_press', el.name);
        return manager.press(args.observation, args.element, args.action ?? 'auto');
      }),
    }),

    defineXTool({
      name: 'x_desktop_value',
      description:
        '向观察到的可编辑元素直接写入值（UIA ValuePattern，等价于应用的"设值"接口）——' +
        '不通过键盘输入、不需要窗口在前台、不抢焦点。这是往输入框写文本的首选方式。' +
        '密码框一律拒绝。写入后必须重新观察验证内容已落地。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true, description: 'x_desktop_tree 返回的观察 id。' },
          element: { type: 'integer', required: true, description: '该次观察里的元素编号（#N）。' },
          value: { type: 'string', required: true, description: '要写入的完整文本（覆盖式）。' },
        },
        required: ['observation', 'element', 'value'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          used: { type: 'string' }, observation: { type: 'string' },
          revalidated: { type: 'boolean', description: '快照已过期但元素按 RuntimeId 重新定位且身份核对一致，写入照常执行。' },
          window: windowInfoSchema, hint: { type: 'string' },
        },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const { el } = manager.peek(args.observation, args.element);
        await guardDangerous(exec, 'x_desktop_value', el.name);
        return manager.setValue(args.observation, args.element, args.value);
      }),
    }),

    defineXTool({
      name: 'x_desktop_scroll',
      description: '对支持滚动模式的元素（列表/文档区）按方向滚动（UIA ScrollPattern，后台安全）。direction 为 up/down/left/right，amount 默认 3。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true },
          element: { type: 'integer', required: true },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', description: '滚动格数，默认 3。' },
        },
        required: ['observation', 'element'],
      },
      outputSchema: {
        type: 'object',
        properties: { used: { type: 'string' }, observation: { type: 'string' }, revalidated: { type: 'boolean' } },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult((args) => manager.scroll(args.observation, args.element, args.direction ?? 'down', args.amount)),
    }),

    defineXTool({
      name: 'x_desktop_shot',
      description:
        '窗口级截图（JPEG）并作为图片附件返回给多模态模型——**只截你已观察到的那一个窗口**，'
        + '不是全屏、也不是元素局部。'
        + '用途：当 x_desktop_tree 返回 degraded=true 时（Electron/Chromium 应用默认不物化'
        + '无障碍树，语义动作不可用），改用"看图"来理解界面。'
        + '用法：截图后把 image 引用传给 x_vision_describe，或自己看图后用 x_desktop_click_at 点坐标。'
        + '图像是**当前画面**的证据，但目标位置仍需你确认；截图本身不产生任何输入、不抢焦点。'
        + '⚠️ **该功能默认被用户关闭**（设置页「X-Agent操控 → 允许窗口截图」）。'
        + '关着的理由：树只给控件结构、写值对密码框硬拒绝，而像素没有这层保护。'
        + '若调用被拒，如实告诉用户这是用户的选择，请用户自己决定是否打开——'
        + '不要绕过，也不要改用别的方式偷偷获取画面。',
      parameters: {
        type: 'object',
        properties: {
          // 只认 observation，**故意不提供 pid/title/hwnd**：observation 是唯一凭据。
          // 给了窗口参数又不用，就是"文档说能用实际必失败"——模型会以为能凭 hwnd 截
          // 任意窗口，那等于把插件变成通用截图器。
          observation: { type: 'string', required: true, description: 'x_desktop_tree 返回的观察 id（决定截哪个窗口）。' },
          max_edge: { type: 'integer', description: '长边像素上限，超过则等比降采样。默认 1280。' },
          quality: { type: 'integer', description: 'JPEG 质量 1-95。默认 70。' },
        },
        required: ['observation'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          observation: { type: 'string', required: true },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
            required: true,
          },
          window: windowInfoSchema,
          degraded: { type: 'boolean', description: '本次观察的树是否被判定为不可用（与 x_desktop_tree 同一判定）。' },
          note: { type: 'string', required: true },
        },
        required: true,
      },
      render: (_a, v) => {
        const blocks = [{ type: 'text', text: JSON.stringify(v, null, 2) }];
        // ⚠️ 必须**整个** image 传给宿主，一个字段都不能少（2026-10-03 修，用户实测抓出）。
        //
        // 之前这里图省事写成 { attachmentId, mediaType } 两个字段，漏掉 bytes/width/height。
        // 宿主的 ImageAttachmentRef 五项全是必填，读回图片时会拿它们逐项与实际字节比对：
        //   dsh-attachment-local/lib/index.js:609
        //     metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
        //     || metadata.width !== ref.width || metadata.height !== ref.height
        // 缺字段就是 `undefined !== 738203`，于是抛
        // "Stored attachment metadata does not match its reference."
        //
        // 后果比"这次调用失败"严重得多：这个 image block 会**留在会话上下文里**，此后
        // 每次重新组装请求（切模型、压缩、续话）宿主都要重读这张图，于是一直崩——
        // 表现为"Agent 还没动手就失败"，很容易误判成宿主或网络问题。
        // 浏览器截图一直没这个毛病，因为 lib/browser/tools.js 的 renderTab 传的是
        // 完整的 value.image。**别再"精简"这里。**
        if (v.image?.attachmentId) blocks.push({ type: 'image', attachment: { ...v.image } });
        return blocks;
      },
      execute: toToolResult(async (args, exec) => {
        // 开关检查放在最前面，且**先于** attachments 检查：用户主动关掉的东西，
        // 不该因为"环境恰好也没挂 attachments"而报一个不相关的错。
        //
        // 工具**故意仍然注册**。不注册的话模型连这条路径存在都不知道，也就无法向用户
        // 解释"为什么这个应用看不了"——那才是真正的「文档说能用实际必失败」。
        if (cfg.desktopShotEnabled !== true) {
          throw new ControlXError(
            '窗口截图被用户在设置页「X-Agent操控 → 允许窗口截图」关闭了，我无法截图。'
            + '关掉的理由要说清：无障碍树只给控件结构，而写值对密码框是硬拒绝的；'
            + '截图是像素，这层保护不存在（自绘控件的密码框在树里可能压根没标出来）。'
            + '**请把这件事告诉用户，并让用户自己决定是否打开**，不要绕过、'
            + '不要改用别的方式偷偷获取画面。',
            { code: 'ACTION_UNAVAILABLE' },
          );
        }
        const attachments = ctx.get?.('attachments');
        if (!attachments || typeof attachments.saveImage !== 'function') {
          throw new ControlXError(
            '当前环境未挂载 attachments 服务，无法持久化窗口截图。'
            + '请改用 x_desktop_tree 的语义观察（若该窗口 degraded=true，则此窗口无法在当前环境用视觉方式观察）。',
            { code: 'ACTION_UNAVAILABLE' },
          );
        }
        const shot = await manager.windowShot(args.observation, {
          maxEdge: args.max_edge ?? 1280, quality: args.quality ?? 70,
        });
        // 截图取景框：在目标窗口外缘闪一下，告诉用户"刚截的是这里"（2026-10-03 用户提出）。
        // **绝不 await**：提示是装饰，拖慢截图本末倒置；画不出来就当没有。
        // 这里能安全触发是因为上面已经过 desktopShotEnabled 开关——开关关着时上面直接抛，
        // 一次框都不会闪（"跟截图开关走"由此天然成立，不需要额外配置项）。
        try { shotFlash?.(shot.window); } catch { /* 装饰失败不影响交付 */ }
        const ref = await attachments.saveImage({
          data: shot.buffer, mediaType: 'image/jpeg', name: `x-desktop-${Date.now()}.jpg`,
        });
        const snap = manager.observations.get(args.observation);
        return {
          ok: true,
          observation: args.observation,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType ?? 'image/jpeg',
            bytes: ref.bytes ?? shot.buffer.byteLength,
            width: ref.width, height: ref.height, name: ref.name,
          },
          window: shot.window,
          degraded: snap?.degraded === true,
          note: snap?.degraded === true
            ? '该窗口的无障碍树不可用（degraded），本截图是理解它的唯一途径。'
              + '看图后用 x_desktop_click_at 点坐标——注意这是兜底路径，精度低于语义动作，且必须向用户说明。'
            : '该窗口的语义树可用，优先用 x_desktop_press / value；截图仅在语义树表达不了目标时才需要。',
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_click_at',
      description:
        '按**窗口内坐标**点击（兜底路径，显式打扰）：前置目标窗口 → 移动用户真实光标 → 真实点击。'
        + 'x/y 是相对该窗口左上角的像素，来自 x_desktop_shot 截图上的位置（截图若被降采样，'
        + '请按比例换算成原窗口坐标）。'
        + '**仅当 x_desktop_tree 返回 degraded=true、或 x_desktop_mouse_click 找不到目标元素时使用**——'
        + '能走语义动作就必须走语义动作，这条路精度低、且会真实移动用户的光标。'
        + '三重门控与结果明示规则同 x_desktop_mouse_click。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true, description: 'x_desktop_tree 返回的观察 id。' },
          x: { type: 'integer', required: true, description: '窗口内 X 像素（左上角为 0）。' },
          y: { type: 'integer', required: true, description: '窗口内 Y 像素（顶部为 0）。' },
          button: { type: 'string', enum: ['left', 'right'], description: '默认 left。' },
          label: { type: 'string', description: '可选：你在截图上看到的这个目标叫什么（如"提交"）。仅用于向用户明示。' },
          confirm_disturbance: { type: 'boolean', description: '审批服务不可用时，显式确认接受打扰。' },
        },
        required: ['observation', 'x', 'y'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          disturbance: { type: 'string', required: true },
          clickedAt: { type: 'object', properties: { screenX: { type: 'integer' }, screenY: { type: 'integer' } }, required: true },
        },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const win = await manager.windowRect(args.observation);
        if (win.width <= 0 || win.height <= 0) {
          throw new ControlXError('目标窗口矩形为空（可能已最小化或关闭），无法换算坐标。', { code: 'STALE_STATE' });
        }
        if (args.x < 0 || args.y < 0 || args.x >= win.width || args.y >= win.height) {
          throw new ControlXError(
            `坐标 (${args.x}, ${args.y}) 超出窗口范围（${win.width}x${win.height}）。`
            + 'x/y 是窗口内坐标而非屏幕坐标；若截图被降采样过，请先按比例还原。',
            { code: 'INTERNAL' },
          );
        }
        const label = typeof args.label === 'string' ? args.label : '';
        const note = await guardPhysical(exec, 'x_desktop_click_at', label, args.confirm_disturbance);
        const screenX = win.x + args.x;
        const screenY = win.y + args.y;
        activateWindow(win.hwnd);
        clickAt(screenX, screenY, args.button ?? 'left');
        // 点位标记（0.5.34，借鉴 UI-TARS-desktop 的 setOfMarks）：在**点下去的那个屏幕坐标**
        // 闪一个短标记，让用户知道"agent 点了这里"。**绝不 await**，同取景框的纪律；
        // 且必须在点击成功之后才触发——没点到就不该提示用户"点了这里"。
        try { pointMarker?.({ x: screenX, y: screenY }); } catch { /* 装饰失败不影响动作 */ }
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${win.title}"并将真实光标移动到窗口内 (${args.x}, ${args.y})`
            + `${label ? `（目标"${label}"）` : ''}，已点击。已对用户产生可见打扰。`
            + '这是坐标兜底路径，精度低于语义动作——请在回复中如实说明这一点。',
          clickedAt: { screenX, screenY },
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_launch',
      description:
        '启动一个本地应用（给应用名即可，也可以给 exe 完整路径或 .lnk 路径）。' +
        '**按名字时会自动依次找**：完整路径 → 开始菜单（用户+公共）与桌面的快捷方式' +
        '（既按快捷方式文件名，也按它**指向的 exe 名**）→ 注册表 App Paths → PATH。' +
        '都找不到会报 APP_NOT_FOUND 并列出已尝试过哪些地方，那时再改用完整路径即可。' +
        '启动后会轮询定位真实顶层窗口并直接返回（窗口进程可能 ≠ 启动器 pid，插件已代为处理）；' +
        '注意：Windows 平台上启动未打包应用可能使目标窗口获得前台焦点（平台事实，无法避免）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', required: true, description: '应用名（中英文皆可，如 notepad）、exe 完整路径或 .lnk 路径——名字会自己去快捷方式/注册表/PATH 里找。' },
          args: { type: 'string', description: '可选：启动参数。' },
        },
        required: ['target'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          pid: { type: 'integer' },
          window: {
            type: 'object',
            properties: {
              pid: { type: 'integer' },
              title: { type: 'string' },
              className: { type: 'string' },
              hwnd: { type: 'integer' },
              processName: { type: 'string' },
            },
          },
          matched: { type: 'string' },
          note: { type: 'string', required: true },
        },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args) => {
        const result = await manager.launch(args.target, args.args);
        const found = result.matched === 'new';
        const existing = result.matched === 'existing';
        return {
          ok: true,
          pid: result.pid,
          ...(result.window ? { window: result.window } : {}),
          matched: result.matched,
          note: found
            ? '已启动并定位到新窗口（见 window）。直接对它 x_desktop_tree 观察。'
            : existing
              ? '没有出现新窗口，但找到了匹配进程名的既有窗口（应用可能已在运行）。'
              : '已发起启动，但 12 秒内未定位到窗口：应用可能在后台/托盘启动或启动较慢。请稍后用 x_desktop_apps 自行确认。',
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_wait',
      description:
        `等待固定毫秒后再继续（${WAIT_MS_MIN}–${WAIT_MS_MAX}ms）。用于"生成中 / 动画中 / 界面还没刷新"这类场景。` +
        '睡醒后**先重新 x_desktop_tree 拿新观察**，不要拿等待前的旧快照做动作（过期快照会被动作门拒绝）。' +
        `需要更久（如图片生成 30 秒）就分几次等，或先去做别的再回来——单次上限 ${WAIT_MS_MAX}ms，` +
        '因为一个动作里睡太久会把整轮任务吊住。等待期间用户可能仍在用电脑，醒来后的第一个动作照常过物理门控。',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'integer', description: `等待毫秒（${WAIT_MS_MIN}–${WAIT_MS_MAX}）。` },
        },
        required: ['ms'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          waited_ms: { type: 'integer', required: true },
          note: { type: 'string', required: true },
        },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args) => {
        if (args.ms === undefined || args.ms === null) {
          throw new ControlXError(
            `x_desktop_wait 需要 ms（${WAIT_MS_MIN}–${WAIT_MS_MAX}）。例：生成类任务先等 8000 再观察。`,
            { code: 'INTERNAL' },
          );
        }
        const wait = clampWaitMs(args.ms);
        await new Promise((resolve) => { setTimeout(resolve, wait); });
        return {
          ok: true,
          waited_ms: wait,
          note: `已等待 ${wait}ms。界面可能已经变化——下一步先重新 x_desktop_tree 拿新观察，`
            + '不要用等待前的快照做动作（快照过期会被动作门拒绝）。',
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_mouse_click',
      description:
        '物理鼠标点击（显式打扰路径，最后手段）：前置目标窗口 → 移动用户真实光标到元素中心 → 真实点击。' +
        '语义动作（x_desktop_press）不可用或元素通告无模式时才使用。' +
        '三重门控：用户空闲检测、审批（或 confirm_disturbance 显式自认）、前置窗口；' +
        '结果会向用户明示打扰。优先改用语义路径。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true, description: 'x_desktop_tree 的观察 id。' },
          element: { type: 'integer', required: true, description: '元素编号（#N）。' },
          button: { type: 'string', enum: ['left', 'right'], description: '默认 left。' },
          confirm_disturbance: { type: 'boolean', description: '审批服务不可用时，显式确认接受打扰。' },
        },
        required: ['observation', 'element'],
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean', required: true }, disturbance: { type: 'string', required: true }, clickedAt: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: true } },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        const { el } = manager.peek(args.observation, args.element);
        await guardDangerous(exec, 'x_desktop_mouse_click', el.name);
        const note = await guardPhysical(exec, 'x_desktop_mouse_click', el.name, args.confirm_disturbance);
        const rect = await manager.rect(args.observation, args.element);
        activateWindow(rect.window.hwnd);
        clickAt(rect.element.clickX, rect.element.clickY, args.button ?? 'left');
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${rect.window.title}"并将真实光标移动到 (${rect.element.clickX}, ${rect.element.clickY})。已对用户产生可见打扰。`,
          clickedAt: { x: rect.element.clickX, y: rect.element.clickY },
        };
      }),
    }),

    defineXTool({
      name: 'x_desktop_type',
      description:
        '物理键盘输入 Unicode 文本（显式打扰路径）：前置窗口 → （可选）点击目标元素获得焦点 → 逐字符注入。' +
        '仅当目标不支持 ValuePattern（x_desktop_value 不可用）时使用。门控与明示规则同 x_desktop_mouse_click。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true },
          element: { type: 'integer', description: '可选：先点击该元素获得焦点。' },
          text: { type: 'string', required: true },
          confirm_disturbance: { type: 'boolean' },
        },
        required: ['observation', 'text'],
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean', required: true }, disturbance: { type: 'string', required: true } },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        // element 可选：给了就先点它获得焦点；没给就打到当前焦点元素。
        // 两种路径都必须过物理输入门控，门控本身不依赖元素（guardPhysical）。
        const el = args.element !== undefined ? manager.peek(args.observation, args.element).el : null;
        if (el) await guardDangerous(exec, 'x_desktop_type', el.name);
        const note = await guardPhysical(exec, 'x_desktop_type', el?.name, args.confirm_disturbance);
        // 有元素走 rect（顺带拿到窗口句柄）；没元素只用观察快照里的窗口，不编造元素编号。
        const target = el
          ? await manager.rect(args.observation, args.element)
          : { ...manager.windowOf(args.observation), element: null };
        activateWindow(target.window.hwnd);
        if (target.element) clickAt(target.element.clickX, target.element.clickY, 'left');
        typeUnicode(args.text);
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${target.window.title}"并以物理键盘输入 ${args.text.length} 个字符。已对用户产生可见打扰。`
            + (el ? '' : '（未指定元素：输入打到该窗口当前焦点元素，且无法核对目标名称，危险词检查已跳过。）'),
        };
      }),    }),

    defineXTool({
      name: 'x_desktop_key',
      description:
        '物理按键/组合键（显式打扰路径）：前置窗口 → 注入按键（如 ctrl+z、enter、delete）。' +
        '门控与明示规则同 x_desktop_mouse_click。可用键：enter tab esc space backspace delete insert home end pageup pagedown up down left right ctrl alt shift a c v x y z f5。',
      parameters: {
        type: 'object',
        properties: {
          observation: { type: 'string', required: true },
          element: { type: 'integer', description: '可选：先点击该元素获得焦点。' },
          key: { type: 'string', required: true, description: '组合键，如 enter / ctrl+z / shift+delete。' },
          confirm_disturbance: { type: 'boolean' },
        },
        required: ['observation', 'key'],
      },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean', required: true }, disturbance: { type: 'string', required: true } },
        required: true,
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      execute: toToolResult(async (args, exec) => {
        // 与 x_desktop_type 同一条规则：element 可选，缺席时不编造编号（详见 manager.windowOf）。
        const el = args.element !== undefined ? manager.peek(args.observation, args.element).el : null;
        if (el) await guardDangerous(exec, 'x_desktop_key', el.name);
        const note = await guardPhysical(exec, 'x_desktop_key', el?.name, args.confirm_disturbance);
        const target = el
          ? await manager.rect(args.observation, args.element)
          : { ...manager.windowOf(args.observation), element: null };
        activateWindow(target.window.hwnd);
        if (target.element) clickAt(target.element.clickX, target.element.clickY, 'left');
        pressChord(args.key);
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${target.window.title}"并注入按键 ${args.key}。已对用户产生可见打扰。`
            + (el ? '' : '（未指定元素：按键发给该窗口当前焦点元素，且无法核对目标名称，危险词检查已跳过。）'),
        };
      }),
    }),
  ];
}
