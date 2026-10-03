/**
 * 截图取景框的 Node 侧：把目标窗口矩形交给一个**短命自毁**的 PowerShell 进程去描边。
 *
 * 分工与理由（2026-10-03 用户提出「截图时闪个框，告诉用户截的是哪儿」）：
 * - **fire-and-forget**：`shotFlash(rect)` 同步返回、绝不 await。提示是装饰，拖慢截图本末倒置；
 *   画不出来就当没有——**装饰失败不得影响交付**，所以一切异常都在这里吞掉、返回 false。
 * - **独立进程**，不复用横幅浮窗：横幅可能被用户关掉（desktopBanner=false）、可能还没被
 *   活动钩子拉起、可能已按 idleExitMs 自退；取景框必须在这三种情况下照常工作。反过来
 *   取景框崩了也不能牵连横幅或截图。代价是每次截图多一个 ~1s 的短命进程——而截图本身
 *   每次已经在 spawn uia-helper（同一个 powershell），模式一致。
 * - 坐标**原样透传**，外扩（-Border）在 ps1 里做：框画在目标矩形外缘，
 *   因此即使它在 BitBlt 进行时出现，也不会被截进图片里污染交付物。
 *
 * 框的颜色/时长在 ps1 里定（#4a7dff、350ms 淡出）；这里只负责"把矩形安全地送过去"。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/**
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(cmd: string, args: string[], opts: object) => object} [deps.spawnImpl] 测试替换
 * @param {string} [deps.script]
 * @returns {(rect: {x:number,y:number,width:number,height:number}|null) => boolean}
 *   是否已发出；false = 没发（矩形非法 / spawn 失败），且**不会抛**。
 */
export function createShotFlash({
  env = process.env,
  spawnImpl = spawn,
  script = require_.resolve('../lib/shot-frame.ps1'),
} = {}) {
  return function shotFlash(rect) {
    try {
      if (!rect || typeof rect !== 'object') return false;
      const { x, y, width, height } = rect;
      // x/y 允许为负：Windows 虚拟屏里主屏左侧的副屏就是负坐标。
      if (![x, y, width, height].every((n) => Number.isFinite(n))) return false;
      if (width < 2 || height < 2) return false;
      const shell = env.DSH_CONTROL_X_SHOT_FRAME_SHELL || 'powershell.exe';
      const child = spawnImpl(shell, [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass', '-File', script,
        '-X', String(Math.round(x)), '-Y', String(Math.round(y)),
        '-W', String(Math.round(width)), '-H', String(Math.round(height)),
      ], { detached: false, windowsHide: true, stdio: 'ignore' });
      // 不 unref 会把宿主的事件循环吊住（banner-win 踩过：插件卸载后进程不退）。
      child?.unref?.();
      child?.on?.('error', () => { /* 拉不起来就当没有框 */ });
      return true;
    } catch {
      return false; // 装饰失败静默：绝不影响截图本身
    }
  };
}
