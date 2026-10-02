/**
 * 宿主无障碍旗标控制器：设置页「桌面观察」开关的后端。
 *
 * 解决的问题：Electron/Chromium 应用（含 DSH 本体）默认不向 UIA 物化渲染器
 * 无障碍树，桌面观察只能看到十几个无名空壳；给宿主启动命令加
 * --force-renderer-accessibility 后恢复完整树（实测 14 → 599 元素，
 * 见 docs/DSH-SDK-CONTRACT.md §11）。旗标必须在宿主启动时就在场，插件无法
 * 对运行中的宿主生效，所以唯一诚实的做法是：写入宿主的启动快捷方式，
 * 由用户重启后生效——这也是为什么它必须是一个用户显式点击的开关。
 *
 * 信任边界（2026-10-02 与用户定案）：这是插件唯一会写宿主启动配置的代码，
 * 且只在设置页 POST（用户点击开关）时发生；detect（GET）只读。默认状态
 * = 快捷方式不带旗标。它永远不修改 DSH 程序本体，也永远不碰其他应用的
 * 快捷方式——其他 Electron 软件由 agent 提示用户自行处理（lib/skill.js）。
 *
 * 实现经 PowerShell + WScript.Shell COM（lib/host-shortcuts.ps1），参数走
 * base64 单参数传递，绕开 PS 命令行的引号地狱；输出带 sentinel 单行 JSON。
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCESSIBILITY_FLAG = '--force-renderer-accessibility';
const SENTINEL = '__X_CONTROL_RESULT__';

/** 宿主 exe 的快捷方式可能出现的目录（用户级 + 公共级 + 任务栏固定）。 */
export function shortcutDirs(env = process.env, home = homedir()) {
  return [
    join(env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(home, 'Desktop'),
    join(env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop'),
    join(env.APPDATA ?? '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ].filter((d) => d.length > 0 && !d.startsWith('\\'));
}

/** 快捷方式数组的形状归一：PS 5.1 的 ConvertTo-Json 会把单元素数组退化为单对象。 */
function normalizeShortcuts(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

export function createHostAccessibilityController({
  scriptPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'host-shortcuts.ps1'),
  execFileImpl = execFile,
  platform = process.platform,
  exePath = process.env.DHCX_HOST_EXE ?? process.execPath,
  dirs = shortcutDirs(),
  timeoutMs = 20000,
} = {}) {
  const unavailable = platform !== 'win32'
    ? { ok: false, available: false, error: '仅 Windows 支持（其他平台没有快捷方式旗标一说）' }
    : null;

  async function run(action) {
    if (unavailable) return unavailable;
    const payload = Buffer.from(JSON.stringify({ exe: exePath, dirs, action }), 'utf8').toString('base64');
    const stdout = await new Promise((resolve, reject) => {
      execFileImpl('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-PayloadB64', payload],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message).split('\n')[0];
            reject(new Error(`执行 host-shortcuts.ps1 失败：${detail.slice(0, 160)}`));
          } else {
            resolve(String(stdout));
          }
        });
    });
    const line = stdout.split('\n').find((l) => l.includes(SENTINEL));
    if (line === undefined) throw new Error('host-shortcuts.ps1 没有返回结果哨兵');
    const parsed = JSON.parse(line.slice(line.indexOf(SENTINEL) + SENTINEL.length));
    return {
      ...parsed,
      shortcuts: normalizeShortcuts(parsed.shortcuts),
      errors: normalizeShortcuts(parsed.errors),
      exePath,
      restartRequired: true,
    };
  }

  return {
    /** 只读检测：宿主的哪些快捷方式带旗标。不写任何文件。 */
    detect: () => run('detect'),
    /** 写入（enabled=true）或移除（false）旗标。结果里的 restartRequired 恒为 true：改的是启动方式，重启才生效。 */
    set: (enabled) => run(enabled === true ? 'patch' : 'restore'),
  };
}
