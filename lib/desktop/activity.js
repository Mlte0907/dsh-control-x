/**
 * 操控活动跟踪：Agent 正在动本机桌面/内置浏览器时，横幅要告诉用户。
 *
 * 为什么要"宽限期"而不是纯 in-flight 标志：一次语义动作常常 0.2~1.5 秒就结束，
 * 纯 in-flight 会让横幅一闪而过、用户根本看不清；所以最后一次动作结束后
 * 仍保持 active 一小段时间（默认 2.5s），让"正在操控"在连续动作之间不闪烁。
 *
 * 两类活动用 kind 区分（2026-10-01 起）：
 *   - 'desktop'：x_desktop_*，真的在动用户屏幕上的窗口，必须明示；
 *   - 'browser'：x_browser_*，驱动的是无头实例，**不碰用户屏幕**，但用户仍需要知道
 *     Agent 正在网上替它跑腿（否则侧栏/横幅毫无反应，像卡死）。
 * 原先只跟踪桌面半边，浏览器活动对用户完全不可见——这是实测出来的缺口。
 */

/**
 * 宽限期：最后一次动作结束后，横幅继续保持多久（毫秒）。
 * 5000 而非更短：用户要求横幅「Agent 操作时常驻、停止操作才消失」（2026-10-01）。
 * 2.5s 在真实节奏下会一闪一闪——思考、调工具、看结果之间的间隔常常就超过 2.5 秒，
 * 横幅断断续续反闪比不显示更糟。
 */
export const DEFAULT_GRACE_MS = 5000;

/** 活动种类。 */
export const ACTIVITY_KIND = Object.freeze({ DESKTOP: 'desktop', BROWSER: 'browser' });

/**
 * @param {object} [options]
 * @param {number} [options.graceMs] 宽限期，默认 2500ms；0 = 动作一结束就撤销横幅。
 * @param {() => number} [options.now] 时钟注入（测试用）。
 * @param {(tool: string, kind: string) => void} [options.onBegin]
 *   每次动作开始时触发（begin 内部、状态已更新之后）。横幅浮窗靠它做到按需拉起：
 *   Node 侧在第一次操控发生的那一刻就知道该起进程，不需要自己轮询。
 */
export function createActivityTracker({ graceMs = DEFAULT_GRACE_MS, now = Date.now, onBegin } = {}) {
  let inFlight = 0;
  let lastAt = 0;
  let lastTool = '';
  let lastKind = '';

  return {
    /** 动作开始。 */
    begin(tool, kind) {
      inFlight += 1;
      lastAt = now();
      lastTool = typeof tool === 'string' ? tool : '';
      if (typeof kind === 'string' && kind !== '') lastKind = kind;
      // 放在最后：订阅者读 snapshot() 时看到的是已经"活跃"的状态，
      // 浮窗启动第一帧就能画出横幅，而不是先空一帧再补上。
      if (typeof onBegin === 'function') onBegin(lastTool, lastKind);
    },
    /** 动作结束（无论成功失败都调用，保证横幅不会卡住）。 */
    end(tool) {
      inFlight = Math.max(0, inFlight - 1);
      lastAt = now();
      if (!lastTool && typeof tool === 'string') lastTool = tool;
    },
    /** 当前快照：横幅与侧栏自动弹出据此决定显示/隐藏。 */
    snapshot() {
      const t = now();
      const since = lastAt;
      const running = inFlight > 0;
      // running 时无论上次动作多久以前都算活跃；空闲时靠宽限期续命。
      const active = running || (lastAt > 0 && t - lastAt < graceMs);
      return {
        active,
        running,
        tool: active ? lastTool : '',
        kind: active ? lastKind : '',
        since,
        idleMs: active ? Math.max(0, t - since) : null,
        graceMs,
      };
    },
  };
}

/**
 * 给一批工具套上活动标记（不改它们原本的 execute 语义与返回值）。
 * @param {object[]} tools defineXTool 产物
 * @param {ReturnType<createActivityTracker>} activity
 * @param {object} [options]
 * @param {(name: string) => boolean} [options.filter] 哪些工具算"操控"，默认全部。
 * @param {string} [options.kind] 归到哪一类（ACTIVITY_KIND 之一）。
 */
export function withActivity(toolList, activity, { filter = () => true, kind = ACTIVITY_KIND.DESKTOP } = {}) {
  return toolList.map((tool) => {
    if (!filter(tool.name)) return tool;
    const inner = tool.execute;
    return {
      ...tool,
      async execute(args, exec) {
        activity.begin(tool.name, kind);
        try {
          return await inner(args, exec);
        } finally {
          // 失败也必须 end：否则一次抛错的工具会把横幅永久钉在屏幕上。
          activity.end(tool.name);
        }
      },
    };
  });
}
