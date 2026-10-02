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
/**
 * degraded 判定的两个下限（2026-10-03）。用真机数据校准：
 *   Edge 152      499/461  DSH 空壳 13/4  OpenCode 48/33
 * 阈值取「明显低于正常窗口」而不是贴近任何一侧：13 与 33 之间有足够宽的间隔，
 * 而 461 更是远在另一档。任一条件命中即 degraded。
 */
export const DEGRADED_NAMED_MAX = 8;
export const DEGRADED_TOTAL_MIN = 20;

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
    // degraded 判定（2026-10-03）：这棵树能不能当主干用。
    //
    // 实测三档（本机真数据）：
    //   Edge 152 (Chromium)     499 元素 / 461 有名字 -> 现代 Chromium 默认开 UIA，无需处理
    //   OpenCode (Electron)       48 元素 /  33 有名字 -> 正常
    //   DSH 本体 (Electron)       13 元素 /   4 有名字 -> 空壳，语义动作全部用不了
    // Electron/Chromium 较老的内核默认不对外物化无障碍树，而本插件**不修改任何应用或宿主
    // 的启动配置**（2026-10-03 定案，见 CHANGELOG 0.5.19），所以这类窗口只能走
    // "看图 + 坐标点击"兜底。模型必须**机器可读地**知道这件事，而不是靠人去猜——
    // 这对应 ZCode 用 subrole 区分"可绑定的窗口"与"树不暴露的残留界面"。
    const namedCount = result.elements.filter((el) => typeof el.name === 'string' && el.name.trim() !== '').length;
    const degraded = namedCount < DEGRADED_NAMED_MAX || result.elements.length < DEGRADED_TOTAL_MIN;
    // 替代路径要**随截图开关变**：开关关着时如果照旧让模型去截图，就是"文档说能用
    // 实际必失败"——模型会在每个 degraded 窗口上撞一次 ACTION_UNAVAILABLE 才发现。
    // 所以这里直接按当前配置给不同的建议。
    const shotAllowed = this.cfg.desktopShotEnabled === true;
    const degradedAdvice = shotAllowed
      ? '改用 x_desktop_shot 看图 + x_desktop_click_at 坐标点击（兜底路径，精度低于语义动作），'
        + '或用 x_desktop_key / x_desktop_type 发按键。'
      : '**窗口截图当前被用户关闭**（设置页「X-Agent操控 → 允许窗口截图」），所以看图这条路走不通——'
        + '请把这件事告诉用户并让用户自己决定是否打开，不要绕过。此窗口能做的只有：'
        + '用 x_desktop_key / x_desktop_type 发按键，或请用户手动操作。'
        + '注意语义动作与截图的差别：树只给控件结构，而写值对密码框是硬拒绝的，'
        + '像素没有这层保护——这正是截图默认关的原因。';
    const degradedReason = degraded
      ? `该窗口只暴露出 ${result.elements.length} 个元素（其中 ${namedCount} 个有名字），`
        + '疑似 Electron/Chromium 内核未对外物化无障碍树。'
        + '**语义动作（x_desktop_press / value / scroll）在此窗口基本不可用**。'
        + degradedAdvice
        + '重试观察无用——这不是时序问题。'
      : '';
    this.observations.set(observationId, {
      expiresAt: Date.now() + ttlMs,
      processName,
      window: result.window,
      elements,
      degraded,
    });
    // 过期快照不立即清：宽限期内动作还可以按 RuntimeId + 身份核对重验（见 resolveTarget）。
    // 宽限过后才清，防长会话内存增长。
    const now = Date.now();
    for (const [id, snap] of this.observations) {
      if (snap.expiresAt + SNAPSHOT_GRACE_MS < now) this.observations.delete(id);
    }
    return {
      ...result, processName, observation: observationId, ttlMs,
      namedCount, degraded, degradedReason,
    };
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

  /**
   * 观察快照的窗口矩形 + 前台状态（纯坐标动作的前置取证，helper 内只读）。
   *
   * 不解析任何元素——这正是它在树空掉时唯一可用的原因。
   */
  async windowRect(observationId) {
    const snap = this.observations.get(observationId);
    if (!snap) {
      throw new ControlXError(
        `观察快照 ${observationId} 不存在。动作必须绑定一次 x_desktop_tree 的观察；请先观察。`,
        { code: 'STALE_STATE' },
      );
    }
    this.assertAllowed(snap.processName);
    const result = await this.runHelper('window_rect', { pid: snap.window.pid, hwnd: snap.window.hwnd });
    return result.window;
  }

  /**
   * 窗口级截图（2026-10-03）。返回 JPEG Buffer + 窗口元数据。
   *
   * 用 PrintWindow 而非抓屏幕：PrintWindow 让目标窗口自己画进我们给的 DC，**不受遮挡
   * 影响**（实测 DSH 在后台被压着时仍取到完整画面）。范围严格限于**已观察过的那一个
   * 窗口**——不能凭 hwnd 截任意窗口。
   */
  async windowShot(observationId, { maxEdge = 1280, quality = 70 } = {}) {
    const snap = this.observations.get(observationId);
    if (!snap) {
      throw new ControlXError(
        `观察快照 ${observationId} 不存在。截图必须绑定一次 x_desktop_tree 的观察；请先观察。`,
        { code: 'STALE_STATE' },
      );
    }
    this.assertAllowed(snap.processName);
    const result = await this.runHelper('window_shot', {
      pid: snap.window.pid, hwnd: snap.window.hwnd, maxEdge, quality,
    });
    const buffer = Buffer.from(result.imageBase64, 'base64');
    if (buffer.length === 0 || buffer.length !== result.bytes) {
      throw new ControlXError('窗口截图解码长度与字节数不一致，已拒绝使用该结果。', { code: 'INTERNAL' });
    }
    return { buffer, window: result.window, bytes: result.bytes };
  }

  /**
   * 只取观察快照里的窗口信息，不解析任何元素。
   *
   * 2026-10-02 新增：`x_desktop_type` / `x_desktop_key` 的 `element` 是**可选**参数
   * （"可选：先点击该元素获得焦点"），此前它们用 `args.element ?? 0` 去查元素，而
   * 观察树里**根本不存在编号 0**——uia-helper.ps1 的 Observe-Tree 第一轮 `if ($index -gt 0)`
   * 把窗口自身（index 0）排除在 elements 之外，实测真机返回的编号是 1..N。
   * 结果：不传 element 必然撞 `ELEMENT_UNAVAILABLE: 元素 #0 不在观察快照…请重新观察；
   * 不要猜编号`——一条把参数默认值取错、却把模型引向"再观察一遍"的误导性报错。
   * 参照实现 988hj7tczd-oss/dsh-computer-use 的 guard.js:64 也是在 element 缺席时
   * **跳过**元素级检查，而不是拿 0 去顶。
   *
   * 代价要说清楚：没有元素就**无法核对目标名称**，所以危险词检查在这种情况下会被跳过。
   * 调用方必须在返回文案里如实告知用户这一点（Anionex 的做法是"策略不可由模型参数改变"，
   * 但它的物理输入本来就是 per-pid 投递、不需要这个折衷）。
   */
  windowOf(observationId) {
    const snap = this.observations.get(observationId);
    if (!snap) {
      throw new ControlXError(
        `观察快照 ${observationId} 不存在。动作必须绑定一次 x_desktop_tree 的观察；请先观察。`,
        { code: 'STALE_STATE' },
      );
    }
    this.assertAllowed(snap.processName);
    return { window: snap.window, processName: snap.processName };
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
