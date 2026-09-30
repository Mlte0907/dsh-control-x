/**
 * 浏览器可执行文件发现（Windows 优先，证据：spikes/browser-probe 实测 Edge 位于
 * Program Files (x86)；Chrome 常见路径一并枚举）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  // 用户显式配置最优先（由调用方传入）
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

/** @returns {string|null} 浏览器可执行文件绝对路径。 */
export function findBrowserExecutable(configuredPath) {
  if (configuredPath && existsSync(configuredPath)) return configuredPath;
  return CANDIDATES.find((p) => p && existsSync(p)) ?? null;
}
