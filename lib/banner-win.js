/**
 * 桌面置顶横幅（Windows 原生浮窗）。
 *
 * 为什么必须离开网页：网页里的 position:fixed 横幅只存在于 DSH 窗口的渲染层。
 * Agent 操控记事本时用户盯着记事本，DSH 窗口在后面，横幅被压在下面——2026-10-01
 * 实测就是这样"横幅没提示"的（截图证明横幅本身工作正常，只是没人看得见）。
 * 要在任何应用之上都被看见，只能用一个真正的置顶窗口。
 *
 * 分工：
 *   - Node（本模块）持有活动快照与主题色，**只在状态变化时**写一个 JSON 状态文件；
 *   - banner-overlay.ps1 起一个 WinForms 无边框窗，TopMost + 穿透点击，
 *     以 ~120ms 轮询该文件负责打字动画与显隐。
 * 不用 HTTP：浮窗是独立进程，走本地文件比它在 UI 线程里发同步请求轻得多，
 * 也避免把宿主端口/token 的知识复制进 PowerShell。
 *
 * 非 Windows 或 PowerShell 起不来时 {@link createDesktopBanner} 的 available=false，
 * 调用方回退到网页内的横幅——绝不留一个"以为在提示其实没提示"的假象。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITY_KIND } from './desktop/activity.js';

const require_ = createRequire(import.meta.url);

/** 浮窗状态轮询间隔（毫秒）。只影响"状态变化到写文件"的延迟，不影响动画。 */
export const POLL_MS = 400;

const DEFAULT_THEME = Object.freeze({ bg: '#23242a', fg: '#eeeeee' });

/**
 * 横幅文案：**固定一句话，不带工具名**（2026-10-01 用户明确要求「不要给我多加字」）。
 * 桌面与浏览器活动共用同一句。后半句是在告知用户「我随时可能抢你的键鼠」，
 * 让他在被 Agent 打断时知道原因，而不是以为系统抽风。
 * 末尾三个点是唯一的文字动画，由浮窗逐个打出。
 */
export const BANNER_TEXT = 'X-Agent正在控制电脑，操控键鼠会打断操作';
export const BANNER_DOTS = '...';

/**
 * 状态点三色循环：红 → 黄 → 蓝，每 DOT_CYCLE_MS 换一个。
 * 放在 Node 侧是为了让「浮窗」与「网页内横幅」用同一份定义，不会各写一套。
 */
export const DOT_COLORS = Object.freeze(['#ef4444', '#eab308', '#3b82f6']);
export const DOT_CYCLE_MS = 2000;

/**
 * 由活动快照 + 主题色算出浮窗该显示什么。
 * @param {ReturnType<import('./desktop/activity.js').createActivityTracker>['snapshot']} snap
 * @param {{bg?: string, fg?: string}} [theme]
 */
export function bannerState(snap, theme) {
  const bg = typeof theme?.bg === 'string' && theme.bg.trim() !== '' ? theme.bg : DEFAULT_THEME.bg;
  const fg = typeof theme?.fg === 'string' && theme.fg.trim() !== '' ? theme.fg : DEFAULT_THEME.fg;
  const active = snap?.active === true;
  const kind = active ? (snap.kind || ACTIVITY_KIND.DESKTOP) : '';
  return {
    active,
    kind,
    tool: active && typeof snap.tool === 'string' ? snap.tool : '',
    // 浮窗立即显示 text，并逐个打出 dots。
    text: active ? BANNER_TEXT : '',
    dots: active ? BANNER_DOTS : '',
    bg,
    fg,
  };
}

/**
 * 变化签名：只含"变了才值得重画"的字段。
 * since/idleMs 每毫秒都在变，若纳入签名会变成每秒写文件。
 * 注意 **不能** 纳入 tool：文案已不带工具名，而工具名每次动作都在变，
 * 纳入会导致每一步都重置打字动画。
 * @param {ReturnType<typeof bannerState>} state
 */
export function stateSignature(state) {
  return [state.active ? 1 : 0, state.text, state.dots, state.bg, state.fg].join('');
}

/**
 * 启动桌面浮窗。
 *
 * 按需拉起（2026-10-01）：不再随 DSH 启动就常驻。第一次 Agent 真正动手时
 * 由 activity 的 onBegin 钩子调 start()，停手超过 idleExitMs 后自己退出，
 * 下次操控再拉。代价是每次冷启动横幅会晚 PowerShell 起进程的那点时间（几百毫秒），
 * 换来的是"不操控就零进程"。
 *
 * @param {object} args
 * @param {object} args.activity 活动跟踪器（提供 snapshot()）。
 * @param {() => {bg?: string, fg?: string}} [args.getTheme] 主题色提供者（来自客户端上报）。
 * @param {number} [args.idleExitMs] 停手多久后退出浮窗进程；0 = 永不自动退出。
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {(file: string, args: string[]) => object} [args.spawnImpl] 进程拉起（测试替换）。
 * @param {(ms: number, fn: () => void) => object} [args.setIntervalImpl]
 * @param {(h: object) => void} [args.clearIntervalImpl]
 * @param {() => number} [args.now] 时钟注入（测试用）。
 */
export function createDesktopBanner({
  activity,
  getTheme,
  idleExitMs = 120000,
  env = process.env,
  spawnImpl = spawn,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = Date.now,
} = {}) {
  const isWindows = process.platform === 'win32';
  const script = require_.resolve('../lib/banner-overlay.ps1');
  // 临时目录是 start() 才建的，不是这里建的：每次 createDesktopBanner() 就 mkdtemp
  // 的话，任何没走到 stop() 的调用方（宿主契约检查、自检、m2/m3 直接调 apply）
  // 都会在 %TEMP% 留下一个孤儿目录。实测堆到 62 个、16.3 MB。
  let dir = null;
  let statePath = null;

  let child = null;
  let timer = null;
  let lastSig = null;
  let lastActiveAt = now();

  const write = (state) => {
    if (statePath === null) return;
    try {
      writeFileSync(statePath, JSON.stringify(state), 'utf8');
    } catch {
      /* 临时目录被清理等情况：浮窗读不到旧文件，保持上一帧，不抛给 Agent */
    }
  };

  const tick = () => {
    if (activity === null || activity === undefined || typeof activity.snapshot !== 'function') return;
    const state = bannerState(activity.snapshot(), getTheme?.() ?? undefined);
    if (state.active) {
      lastActiveAt = now();
    } else if (child !== null && idleExitMs > 0 && now() - lastActiveAt > idleExitMs) {
      // 停手够久：自己退掉，让"没在操控"时机器上不留任何进程。
      stop();
      return;
    }
    const sig = stateSignature(state);
    if (sig === lastSig) return;
    lastSig = sig;
    write(state);
  };

  const stop = () => {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
    if (child !== null) {
      try { child.kill(); } catch { /* 已退出 */ }
      child = null;
    }
    if (dir !== null) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      dir = null;
      statePath = null;
    }
  };

  const start = () => {
    if (!isWindows) return false;
    // 按需拉起意味着 start() 会被反复调用（每次操控动作都调一次）。没有这道闸，
    // 第二次调用会再 spawn 一个 powershell 进程，界面上就变成两个横幅叠在一起。
    if (child !== null) return true;
    if (dir === null) {
      dir = mkdtempSync(join(tmpdir(), 'dsh-control-x-'));
      statePath = join(dir, 'banner.json');
    }
    // 重新拉起时 lastActiveAt 要重置，否则一个久未活动的横幅起来立刻又自杀。
    lastActiveAt = now();
    // 先落一份初始状态，浮窗起来第一帧就有内容可读（而不是等第一次变化）。
    lastSig = null;
    tick();
    const shell = env.DSH_CONTROL_X_BANNER_SHELL || 'powershell.exe';
    try {
      child = spawnImpl(shell, [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-File', script, '-StatePath', statePath,
      ], { detached: false, windowsHide: true, stdio: 'ignore' });
      // 不 unref 的话这个子进程会把 Node 事件循环一直吊住：宿主里表现为插件卸载后
      // 进程不退出，测试里表现为 node --test 永不结束（实测卡死过一次）。
      child.unref?.();
      child.on?.('error', () => { child = null; });
    } catch {
      child = null;
      return false;
    }
    timer = setIntervalImpl(tick, POLL_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    return true;
  };

  return {
    /** 起得来就有原生浮窗。 */
    get available() { return isWindows && child !== null; },
    start,
    stop,
    /** 供测试/排障：当前写出的状态；未 start() 前为 null（此时也没有目录）。 */
    get statePath() { return statePath; },
    tick,
  };
}