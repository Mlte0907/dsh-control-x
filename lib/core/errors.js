/**
 * 统一结构化错误：错误码 + actionSent + retry 语义。
 *
 * 设计约束（PROPOSAL.md §6.5-6）：
 * - actionSent 默认 false（保守方向）：只有证据表明动作可能已下发才置 true，
 *   否则模型会对从未生效的动作放弃重试。
 * - 未知码归 INTERNAL，绝不静默成功。
 */

/** 重试语义：reobserve = 先重新观察；never = 不可重试；retry = 可重试同一动作。 */
const REOBSERVE_CODES = new Set([
  'ELEMENT_UNAVAILABLE',
  'STALE_STATE',
  'TREE_UNAVAILABLE',
]);

const NEVER_RETRY_CODES = new Set([
  'CONTROLLER_BUSY',
  'CONTROL_STOPPED',
  'PERMISSION_DENIED',
  'NOT_AUTHORIZED',
  'APP_NOT_FOUND',
  'VERSION_MISMATCH',
  'ACTION_UNAVAILABLE',
  'NOT_SETTABLE',
  'NOT_SELECTABLE',
  'DISTURBANCE_DENIED',
]);

export class ControlXError extends Error {
  /**
   * @param {string} message 面向模型的可读信息；缺什么字段必须写进消息（可诊断性）。
   * @param {{code?: string, actionSent?: boolean, details?: object}} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlXError';
    this.code = options.code ?? 'INTERNAL';
    this.actionSent = options.actionSent === true;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.retry = this.actionSent
      ? 'reobserve'
      : NEVER_RETRY_CODES.has(this.code)
        ? 'never'
        : REOBSERVE_CODES.has(this.code)
          ? 'reobserve'
          : 'retry';
  }
}

/** 工具 execute 的统一出口：ControlXError 之外的一切也归一为 INTERNAL，不静默。 */
export function toToolResult(run) {
  return async (args, exec) => {
    try {
      return await run(args, exec);
    } catch (err) {
      if (err instanceof ControlXError) throw err;
      throw new ControlXError(err?.message ?? String(err), {
        code: 'INTERNAL',
        details: { cause: err?.name ?? 'Error' },
      });
    }
  };
}
