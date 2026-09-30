/**
 * 安全护栏：危险词识别 + 审批请求（fail-closed）。
 *
 * 证据（docs/DSH-SDK-CONTRACT.md）：
 * - approval.request({agent, toolName, callId?, reason, signal}) 返回
 *   'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'，'allowed-once' 是唯一许可
 *   （dsh-user-approval/lib/index.js:128-148 README"Requesting a decision"）；
 *   无应答器 → 'unavailable' fail-closed（README Summary）。
 * - 必须在 open turn 内调用（否则抛错）→ 这里 catch 后归一为 'unavailable'。
 * - 危险词表为通用中文语义（删除/支付/注销等），与观察快照中的元素名匹配——
 *   只对"预知目标语义"的动作有效（元素编号模式），坐标/物理路径靠审批兜底。
 */

export const DANGEROUS_PATTERNS = [
  /删除|移除|清空|清倒|格式化|卸载|永久/,
  /支付|付款|购买|下单|结账|转账|汇款|提交订单|确认交易/,
  /退出登录|注销|登出/,
];

export function isDangerousLabel(label) {
  const s = String(label ?? '');
  return DANGEROUS_PATTERNS.some((re) => re.test(s));
}

/**
 * 请求一次用户审批。
 * @returns {Promise<string>} outcome；仅 'allowed-once' 视为许可。
 */
export async function requestApproval(ctx, exec, toolName, reason) {
  const approval = ctx.get?.('approval');
  if (!approval || typeof approval.request !== 'function') return 'unavailable';
  try {
    return await approval.request({
      agent: exec?.agent,
      toolName,
      ...(exec?.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
    });
  } catch (err) {
    // open-turn 之外等场景：fail closed，绝不把异常当成许可。
    return 'unavailable';
  }
}

/** 审批统一的拒绝信息（模型可读、可自救）。 */
export function refusalMessage(outcome, what) {
  if (outcome === 'unavailable') {
    return `${what} 需要用户审批，但当前环境没有可用的审批应答器（fail-closed）。` +
      '请放弃该动作并向用户说明原因；不要绕过护栏。';
  }
  return `${what} 未获用户批准（${outcome}），已取消。请向用户说明；不要重试或绕过。`;
}
