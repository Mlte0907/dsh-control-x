/**
 * 桌面控制管理器：UIA helper 子进程封装 + 观察快照账本。
 *
 * 证据与约束：
 * - 每次调用 spawn 固定 argv 的 powershell（非 shell），JSON 走 stdin——988 的
 *   lib/cua.js 已验证该模式在 DSH 插件内可行；观察/动作实测 ~0.4s（M0 spike）。
 * - 动作全部走 UIA 模式（不注入输入事件，零焦点抢占，§6.7-3）。
 * - 动作必须绑定观察快照（§6.5-1/2）。TTL 过期**不直接拒绝**：动作按 RuntimeId 在当前
 *   窗口树重新解析，helper 附带身份核对（角色+名称与观察时一致才执行）——元素还在原位
 *   就继续（revalidated=true），界面真变了才 STALE_STATE，绝不盲放旧状态（"No blind replay"
 *   依然成立：核对失败即拒绝）。宽限期内快照保留供重验，之后清理。
 * - 密码框保护在 helper 内 fail-closed（§6.5-5）。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ControlXError } from '../core/errors.js';

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'uia-helper.ps1');
const SENTINEL = '__X_CONTROL_RESULT__';
const HELPER_TIMEOUT_MS = 20000;
/** 过期快照的保留宽限：期内动作可按 RuntimeId + 身份核对重验（TTL 软化，2026-10-02）。 */
const SNAPSHOT_GRACE_MS = 30 * 60 * 1000;

export class DesktopManager {
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, {expiresAt:number, processName:string, window:object, elements:Map<number,object>}>} */
    this.observations = new Map();
  }

  /** 单次调用 helper：固定 argv + JSON stdin + 哨兵行解析。 */
  runHelper(command, args = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new ControlXError(`UIA helper 超时（${HELPER_TIMEOUT_MS}ms）：${command}`, { code: 'TIMEOUT' }));
      }, HELPER_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ControlXError(`UIA helper 无法启动：${e.message}`, { code: 'HELPER_UNAVAILABLE' }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.split(/\r?\n/).find((l) => l.startsWith(SENTINEL));
        if (!line) {
          reject(new ControlXError(
            `UIA helper 未返回结果（exit ${code}）${err ? `：${err.trim().slice(0, 300)}` : ''}`,
            { code: 'INTERNAL' },
          ));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(line.slice(SENTINEL.length));
        } catch {
          reject(new ControlXError(`UIA helper 返回无法解析：${line.slice(0, 200)}`, { code: 'INTERNAL' }));
          return;
        }
        if (payload.error) {
          reject(new ControlXError(payload.error.message, { code: payload.error.code ?? 'INTERNAL' }));
          return;
        }
        resolve(payload);
      });
      child.stdin.write(JSON.stringify({ command, ...args }));
      child.stdin.end();
    });
  }

  assertAllowed(processName) {
    const allowed = this.cfg.allowedApps ?? [];
    if (allowed.length > 0 && !allowed.includes(processName)) {
      throw new ControlXError(
        `区域限制：应用 "${processName}" 不在允许列表（${allowed.join(' / ')}）中，已拒绝。`,
        { code: 'NOT_AUTHORIZED' },
      );
    }
  }

  /** 观察并建立快照账本（观察只读，不产生输入）。 */
  async observe(spec) {
    const result = await this.runHelper('observe', spec);
    const observationId = randomUUID().slice(0, 8);
    const ttlMs = Number.isFinite(this.cfg.ttlMs) ? this.cfg.ttlMs : 30000;
    const processName = result.window.processName ?? '';
    const elements = new Map();
    for (const el of result.elements) {
      elements.set(el.index, { runtimeId: el.runtimeId, role: el.role, name: el.name, isPassword: el.isPassword, patterns: el.patterns });
    }
    this.observations.set(observationId, {
      expiresAt: Date.now() + ttlMs,
      processName,
      window: result.window,
      elements,
    });
    // 过期快照不立即清：宽限期内动作还可以按 RuntimeId + 身份核对重验（见 resolveTarget）。
    // 宽限过后才清，防长会话内存增长。
    const now = Date.now();
    for (const [id, snap] of this.observations) {
      if (snap.expiresAt + SNAPSHOT_GRACE_MS < now) this.observations.delete(id);
    }
    return { ...result, processName, observation: observationId, ttlMs };
  }

  async listApps() {
    const result = await this.runHelper('list_windows');
    return result;
  }

  /** 动作前置守卫：快照存在、白名单、元素存在且非密码框（value 时）。
   *  TTL 过期**不再硬拒**（2026-10-02 飞书任务定案：30 秒 TTL 对"观察后要思考"的
   *  agent 是必死墙，10 分钟耗在反复撞墙上）：动作本来就按 RuntimeId 在**当前**
   *  窗口树里重新解析，过期时附带 expect 身份核对（角色+名称必须与观察时一致，
   *  由 helper 在动作前执行）——元素还在原位就继续执行（revalidated=true），
   *  界面真变了才 STALE_STATE。不猜、不盲动，但也不惩罚慢思考。 */
  resolveTarget(observationId, elementIndex, { forValue = false } = {}) {
    const snap = this.observations.get(observationId);
    if (!snap) {
      throw new ControlXError(
        `观察快照 ${observationId} 不存在。动作必须绑定一次 x_desktop_tree 的观察；请先观察。`,
        { code: 'STALE_STATE' },
      );
    }
    const expired = snap.expiresAt < Date.now();
    const el = snap.elements.get(elementIndex);
    if (!el) {
      throw new ControlXError(
        `元素 #${elementIndex} 不在观察快照 ${observationId} 中。请重新观察；不要猜编号。`,
        { code: 'ELEMENT_UNAVAILABLE' },
      );
    }
    if (forValue && el.isPassword) {
      throw new ControlXError(
        '敏感输入保护：密码框拒绝自动写入——密码必须由用户本人输入。',
        { code: 'NOT_SETTABLE' },
      );
    }
    this.assertAllowed(snap.processName);
    return { snap, el, expired };
  }

  /** 只读解析：护栏在动作前需要元素身份（危险词匹配）而不触发任何 IO。 */
  peek(observationId, elementIndex) {
    return this.resolveTarget(observationId, elementIndex);
  }

  /** 元素矩形 + 窗口前台状态（物理点击门控的前置取证，helper 内只读）。 */
  async rect(observationId, elementIndex) {
    const { el, snap, expired } = this.resolveTarget(observationId, elementIndex);
    return this.runHelper('rect', {
      pid: snap.window.pid, hwnd: snap.window.hwnd, runtimeId: el.runtimeId,
      expect: { role: el.role, name: el.name },
    });
  }

  async press(observationId, elementIndex, action = 'auto') {
    const { el, snap, expired } = this.resolveTarget(observationId, elementIndex);
    const result = await this.runHelper('press', {
      pid: snap.window.pid, hwnd: snap.window.hwnd, runtimeId: el.runtimeId, action,
      expect: { role: el.role, name: el.name },
    });
    return {
      ...result,
      observation: observationId,
      ...(expired ? { revalidated: true } : {}),
      hint: '动作效果需重新观察验证：再调用 x_desktop_tree。',
    };
  }

  async setValue(observationId, elementIndex, value) {
    const { el, snap, expired } = this.resolveTarget(observationId, elementIndex, { forValue: true });
    const result = await this.runHelper('set_value', {
      pid: snap.window.pid, hwnd: snap.window.hwnd, runtimeId: el.runtimeId, value,
      expect: { role: el.role, name: el.name },
    });
    return {
      ...result,
      observation: observationId,
      ...(expired ? { revalidated: true } : {}),
      hint: '写入效果需重新观察验证：再调用 x_desktop_tree。',
    };
  }

  async scroll(observationId, elementIndex, direction, amount) {
    const { el, snap, expired } = this.resolveTarget(observationId, elementIndex);
    const result = await this.runHelper('scroll', {
      pid: snap.window.pid, hwnd: snap.window.hwnd, runtimeId: el.runtimeId, direction, amount,
      expect: { role: el.role, name: el.name },
    });
    return {
      ...result,
      observation: observationId,
      ...(expired ? { revalidated: true } : {}),
    };
  }

  /** 启动应用并轮询定位真实窗口（helper 内单次完成；窗口进程可能 ≠ 启动器 pid）。 */
  async launch(target, args) {
    return this.runHelper('launch', { target, args: args ?? '' });
  }
}
