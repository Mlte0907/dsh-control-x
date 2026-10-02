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
export function buildDesktopTools(ctx, cfg) {
  const manager = new DesktopManager(cfg);
  const physicalIdleMs = Number.isFinite(cfg.physicalIdleMs) ? cfg.physicalIdleMs : 3000;
  // 「全权操控」开关：信任 Agent 的物理键鼠，跳过审批请求。默认关闭。
  const trustPhysicalInput = cfg.trustPhysicalInput === true;

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
   */
  const guardPhysical = async (exec, toolName, label, confirm) => {
    assertUserIdle(physicalIdleMs);
    if (trustPhysicalInput) {
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
          truncated: { type: 'boolean', required: true },
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
        return {
          ...result,
          elementCount: result.elements.length,
          truncated: result.truncated === true,
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
      name: 'x_desktop_launch',
      description:
        '启动一个本地应用（应用名走开始菜单注册名，或完整路径/.lnk）。' +
        '启动后会轮询定位真实顶层窗口并直接返回（窗口进程可能 ≠ 启动器 pid，插件已代为处理）；' +
        '注意：Windows 平台上启动未打包应用可能使目标窗口获得前台焦点（平台事实，无法避免）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', required: true, description: '应用名（如 notepad、calc）、exe 完整路径或 .lnk 路径。' },
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
        const { el } = manager.peek(args.observation, args.element ?? 0);
        await guardDangerous(exec, 'x_desktop_type', el.name);
        const note = await guardPhysical(exec, 'x_desktop_type', el.name, args.confirm_disturbance);
        const rect = await manager.rect(args.observation, args.element ?? 0);
        activateWindow(rect.window.hwnd);
        if (args.element !== undefined) {
          clickAt(rect.element.clickX, rect.element.clickY, 'left');
        }
        typeUnicode(args.text);
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${rect.window.title}"并以物理键盘输入 ${args.text.length} 个字符。已对用户产生可见打扰。`,
        };
      }),
    }),

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
        const { el } = manager.peek(args.observation, args.element ?? 0);
        await guardDangerous(exec, 'x_desktop_key', el.name);
        const note = await guardPhysical(exec, 'x_desktop_key', el.name, args.confirm_disturbance);
        const rect = await manager.rect(args.observation, args.element ?? 0);
        activateWindow(rect.window.hwnd);
        if (args.element !== undefined) {
          clickAt(rect.element.clickX, rect.element.clickY, 'left');
        }
        pressChord(args.key);
        return {
          ok: true,
          disturbance: `${note}已前置窗口"${rect.window.title}"并注入按键 ${args.key}。已对用户产生可见打扰。`,
        };
      }),
    }),
  ];
}
