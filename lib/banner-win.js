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
 * 由活动快照 + 主题色算出浮窗该显示什么。
 * @param {ReturnType<import('./desktop/activity.js').createActivityTracker>['snapshot']} snap
 * @param {{bg?: string, fg?: string}} [theme]
 */
export function bannerState(snap, theme) {
  const bg = typeof theme?.bg === 'string' && theme.bg.trim() !== '' ? theme.bg : DEFAULT_THEME.bg;
  const fg = typeof theme?.fg === 'string' && theme.fg.trim() !== '' ? theme.fg : DEFAULT_THEME.fg;
  const active = snap?.active === true;
  const kind = active ? (snap.kind || ACTIVITY_KIND.DESKTOP) : '';
  const base = kind === ACTIVITY_KIND.BROWSER ? 'X-Agent 正在使用浏览器…' : 'X-Agent 正在操控桌面…';
  const tool = active && typeof snap.tool === 'string' && snap.tool !== '' ? snap.tool : '';
  return { active, kind, tool, text: active ? (tool === '' ? base : `${base}（${tool}）`) : '', bg, fg };
}

/**
 * 变化签名：只含"变了才值得重画"的字段。
 * since/idleMs 每毫秒都在变，若纳入签名会变成每秒写文件。
 * @param {ReturnType<typeof bannerState>} state
 */
export function stateSignature(state) {
  return [state.active ? 1 : 0, state.kind, state.tool, state.bg, state.fg].join('');
}

/**
 * 启动桌面浮窗。
 * @param {object} args
 * @param {object} args.activity 活动跟踪器（提供 snapshot()）。
 * @param {() => {bg?: string, fg?: string}} [args.getTheme] 主题色提供者（来自客户端上报）。
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {(file: string, args: string[]) => object} [args.spawnImpl] 进程拉起（测试替换）。
 * @param {(ms: number, fn: () => void) => object} [args.setIntervalImpl]
 * @param {(h: object) => void} [args.clearIntervalImpl]
 */
export function createDesktopBanner({
  activity,
  getTheme,
  env = process.env,
  spawnImpl = spawn,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const isWindows = process.platform === 'win32';
  const script = require_.resolve('../lib/banner-overlay.ps1');
  const dir = isWindows ? mkdtempSync(join(tmpdir(), 'dsh-control-x-')) : null;
  const statePath = dir === null ? null : join(dir, 'banner.json');

  let child = null;
  let timer = null;
  let lastSig = null;

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
    }
  };

  const start = () => {
    if (!isWindows || dir === null) return false;
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
    /** 供测试/排障：当前写出的状态。 */
    statePath,
    tick,
  };
}