/**
 * Spike：koffi FFI 可用性（只读，无任何输入注入）。
 * 验证：① koffi 原生模块能加载；② user32 结构体/出参调用正确；
 * ③ GetLastInputInfo 可用于"用户活跃度感知"（§6.7-7②）。
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', {
  cbSize: 'uint32',
  dwTime: 'uint32',
});

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const GetLastInputInfo = user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)');
const GetTickCount64 = kernel32.func('uint64 __stdcall GetTickCount64()');

const pt = { x: 0, y: 0 };
const cursorOk = GetCursorPos(pt);

const lii = { cbSize: koffi.sizeof(LASTINPUTINFO), dwTime: 0 };
const idleOk = GetLastInputInfo(lii);
const idleMs = idleOk ? GetTickCount64() - lii.dwTime : null;

console.log(JSON.stringify({
  koffiVersion: koffi.version ?? 'unknown',
  cursor: { ok: cursorOk, ...pt },
  userIdleMs: idleMs,
}, null, 2));
