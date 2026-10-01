/**
 * 操控活动跟踪：Agent 正在动本机桌面时，客户端顶部要挂横幅告诉用户。
 *
 * 为什么要"宽限期"而不是纯 in-flight 标志：一次语义动作常常 0.2~1.5 秒就结束，
 * 纯 in-flight 会让横幅一闪而过、用户根本看不清；所以最后一次动作结束后
 * 仍保持 active 一小段时间（默认 2.5s），让"正在操控"在连续动作之间不闪烁。
 *
 * 只跟踪桌面半边（x_desktop_*）：浏览器半边驱动的是无头实例，不碰用户的屏幕，
 * 不该在用户桌面上弹横幅。
 */

/** 宽限期：最后一次动作结束后，横幅继续保持多久（毫秒）。 */
export const DEFAULT_GRACE_MS = 2500;

/**
 * @param {object} [options]
 * @param {number} [options.graceMs] 宽限期，默认 2500ms；0 = 动作一结束就撤销横幅。
 * @param {() => number} [options.now] 时钟注入（测试用）。
 */
export function createActivityTracker({ graceMs = DEFAULT_GRACE_MS, now = Date.now } = {}) {
  let inFlight = 0;
  let lastAt = 0;
  let lastTool = '';

  return {
    /** 动作开始。 */
    begin(tool) {
      inFlight += 1;
      lastAt = now();
      lastTool = typeof tool === 'string' ? tool : '';
    },
    /** 动作结束（无论成功失败都调用，保证横幅不会卡住）。 */
    end(tool) {
      inFlight = Math.max(0, inFlight - 1);
      lastAt = now();
      if (!lastTool && typeof tool === 'string') lastTool = tool;
    },
    /** 当前快照：客户端横幅据此显示/隐藏。 */
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
 * @param {(name: string) => boolean} [options.filter] 哪些工具算"操控桌面"，默认全部。
 */
export function withActivity(toolList, activity, { filter = () => true } = {}) {
  return toolList.map((tool) => {
    if (!filter(tool.name)) return tool;
    const inner = tool.execute;
    return {
      ...tool,
      async execute(args, exec) {
        activity.begin(tool.name);
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
