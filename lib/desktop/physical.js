/**
 * 物理输入路径（显式打扰，§6.7-4）：真实光标点击 / 键盘输入。
 *
 * 技术选型证据：koffi FFI 已在 M0 spike 验证（user32 出参调用）；此处用
 * mouse_event / keybd_event（user32 传统接口，参数平面、无需 INPUT 联合体封送，
 * Windows 内部将其转发到 SendInput）。调用方必须先过门控序列：
 *   用户空闲检测 → （危险词/显式打扰）审批 → 前置目标窗口 → 注入输入。
 * 每个结果都必须向模型明示"已前置窗口、已移动真实光标"（§6.7-4 结果明示要求）。
 */
import koffi from 'koffi';
import { ControlXError } from '../core/errors.js';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const LASTINPUTINFO = koffi.struct('CX_LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ CX_LASTINPUTINFO *plii)');
const GetTickCount64 = kernel32.func('uint64 __stdcall GetTickCount64()');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hWnd)');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hWnd, uintptr lpdwProcessId)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');

/** 同步 sleep（不引入定时器依赖，门控序列内的毫秒级等待）。 */
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const INPUT_KEYBOARD = 1;
const VK_SHIFT = 0x10;

// SendInput + INPUT 联合体：KEYEVENTF_UNICODE 的 Unicode 码点走 wScan（16 位）。
// 不能用 keybd_event——它的 bScan 只有 8 位，中文码点会被截断到低字节
// （实测「轩」U+8F69 → 0x69 = 'i'，2026-10-02 飞书任务「中文变字母」的根因）。
// 联合体必须收录 MOUSEINPUT：x64 上 INPUT 的真实大小是 40 字节，缺了它
// cbSize 对不上，SendInput 会整批拒绝。
const CX_MOUSEINPUT = koffi.struct('CX_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const CX_KEYBDINPUT = koffi.struct('CX_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
});
const CX_HARDWAREINPUT = koffi.struct('CX_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const CX_INPUT_UNION = koffi.union('CX_INPUT_UNION', { mi: CX_MOUSEINPUT, ki: CX_KEYBDINPUT, hi: CX_HARDWAREINPUT });
const CX_INPUT = koffi.struct('CX_INPUT', { type: 'uint32', u: CX_INPUT_UNION });
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, CX_INPUT *pInputs, int cbSize)');

/** 用户最近一次输入距今的毫秒数（活跃度感知，§6.7-7②）。 */
export function userIdleMs() {
  const lii = { cbSize: koffi.sizeof(LASTINPUTINFO), dwTime: 0 };
  if (!GetLastInputInfo(lii)) return null;
  return Number(GetTickCount64() - lii.dwTime);
}

/** 门控一：用户正在操作时拒绝物理输入（空闲阈值由配置给出，0 = 仅测试用）。 */
export function assertUserIdle(thresholdMs) {
  const idle = userIdleMs();
  if (idle === null) return; // 取不到就交给后续审批门
  if (idle < thresholdMs) {
    throw new ControlXError(
      `用户正在操作电脑（空闲仅 ${idle}ms < 阈值 ${thresholdMs}ms）。` +
        '物理输入会与其争用鼠键：请等待用户停下后再试，或改用语义动作（x_desktop_press/value）。',
      { code: 'FOREGROUND_REQUIRED' },
    );
  }
}

/** 门控三：前置目标窗口（真正的打扰动作，调用方必须在结果中明示）。 */
export function activateWindow(hwnd) {
  const h = Number(hwnd);
  let ok = SetForegroundWindow(h);
  if (!ok) {
    // Windows 前台锁绕行（自动化标准做法）：模拟 ALT 释放锁 +
    // 附加到前台窗口线程的输入队列后再前置。仍失败则 fail-closed。
    keybd_event(0x12, 0, 0, 0);
    keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0);
    const fgThread = GetWindowThreadProcessId(GetForegroundWindow(), 0);
    const curThread = GetCurrentThreadId();
    if (fgThread && Number(fgThread) !== Number(curThread)) {
      AttachThreadInput(Number(curThread), Number(fgThread), true);
      try {
        ok = SetForegroundWindow(h);
      } finally {
        AttachThreadInput(Number(curThread), Number(fgThread), false);
      }
    }
  }
  if (!ok) {
    throw new ControlXError(
      `前置窗口失败（hwnd=${hwnd}）。Windows 限制前台切换：请让用户点击一次该窗口，或改用语义动作。`,
      { code: 'FOREGROUND_REQUIRED' },
    );
  }
  // 前台切换是异步生效的：轮询确认目标窗口真正持有前台后再注入，
  // 否则点击会落在旧前台窗口上（M4 实测证据：SetForegroundWindow 成功但点击未生效）。
  const deadline = Date.now() + 1000;
  while (Number(GetForegroundWindow()) !== h) {
    if (Date.now() > deadline) {
      throw new ControlXError(
        `窗口 ${hwnd} 已发起前置但 1s 内未成为前台。请改用语义动作或让用户手动前置。`,
        { code: 'FOREGROUND_REQUIRED' },
      );
    }
    sleepSync(40);
  }
  // 激活后立即注入的输入可能被应用丢弃（M4 实测）：短稳定期再注入。
  sleepSync(120);
}

/** 真实光标点击（已前置窗口的前提下调用）。 */
export function clickAt(x, y, button = 'left') {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new ControlXError(`物理点击坐标必须是整数像素（收到 ${x}, ${y}）`, { code: 'INTERNAL' });
  }
  if (!SetCursorPos(x, y)) {
    throw new ControlXError(`移动光标失败（${x}, ${y}）`, { code: 'INTERNAL' });
  }
  const down = button === 'right' ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
  const up = button === 'right' ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
  mouse_event(down, 0, 0, 0, 0);
  mouse_event(up, 0, 0, 0, 0);
}

/** Unicode 文本注入（逐字符 SendInput，wScan 带 16 位完整码点，支持中文）。
 *  必须走 SendInput：keybd_event 的 bScan 是 8 位，中文码点会被截断到低字节
 *  （「轩」U+8F69 → 'i'，2026-10-02 飞书任务实测翻车）。已前置窗口的前提下调用。 */
export function typeUnicode(text) {
  for (const ch of String(text)) {
    const scan = ch.codePointAt(0);
    if (scan > 0xFFFF) throw new ControlXError('暂不支持代理对字符的物理输入', { code: 'INTERNAL' });
    const press = (flags) => {
      const sent = SendInput(1, {
        type: INPUT_KEYBOARD,
        u: { ki: { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
      }, koffi.sizeof(CX_INPUT));
      if (sent !== 1) {
        throw new ControlXError(`键盘注入失败（SendInput 返回 ${sent}，cbSize=${koffi.sizeof(CX_INPUT)}）`, { code: 'INTERNAL' });
      }
    };
    press(KEYEVENTF_UNICODE);
    press(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
  }
}

// ── 最小 VK 映射：物理按键路径只覆盖常用键，未收录的键明确拒绝 ──
const VK = {
  enter: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20, backspace: 0x08,
  delete: 0x2E, insert: 0x2D, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  ctrl: 0x11, alt: 0x12, shift: VK_SHIFT,
  a: 0x41, c: 0x43, v: 0x56, x: 0x58, y: 0x59, z: 0x5A, f5: 0x74,
};

/** 组合键注入（如 "ctrl+z"、"shift+delete"、"enter"）。 */
export function pressChord(chord) {
  const parts = String(chord).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new ControlXError('按键不能为空', { code: 'INTERNAL' });
  const vks = parts.map((p) => {
    if (!(p in VK)) {
      throw new ControlXError(
        `未收录的物理键 "${p}"（可用：${Object.keys(VK).join(' ')}）。文本输入请用 x_desktop_value。`,
        { code: 'ACTION_UNAVAILABLE' },
      );
    }
    return { name: p, vk: VK[p], isModifier: ['ctrl', 'alt', 'shift'].includes(p) };
  });
  const main = vks.filter((v) => !v.isModifier);
  const mods = vks.filter((v) => v.isModifier);
  if (main.length !== 1) {
    throw new ControlXError('组合键必须恰好包含一个非修饰键，如 ctrl+z', { code: 'INTERNAL' });
  }
  for (const m of mods) keybd_event(m.vk, 0, 0, 0);
  keybd_event(main[0].vk, 0, 0, 0);
  keybd_event(main[0].vk, 0, KEYEVENTF_KEYUP, 0);
  for (const m of mods.reverse()) keybd_event(m.vk, 0, KEYEVENTF_KEYUP, 0);
}
