'use strict';
/**
 * GlassHour · 桌面层钉死（Windows 10）
 *
 * 目标：把窗口挂到「壁纸层」——被其它窗口盖住、不进任务栏、不进 Alt+Tab。
 *
 * 首选用 koffi 调 user32.dll：
 *   FindWindowW('Progman') → SendMessageTimeoutW(0x052C) 让 Explorer 生成 WorkerW
 *   → 找到「挂着 SHELLDLL_DefView 的那个顶层窗口」的下一个 WorkerW 兄弟
 *   → SetParent(我们的窗口, 那个 WorkerW)
 *
 * 全部用 uint64_t 传句柄、GetWindow 链式遍历（不用 EnumWindows 回调），
 * 避免 koffi 回调在 64 位下的坑。失败一律返回 {ok:false}，由上层回退。
 */

const GW_CHILD = 5; // GetWindow: 第一个子窗口
const GW_HWNDNEXT = 2; // GetWindow: 下一个兄弟窗口
const SMTO_NORMAL = 0x0000;
const WM_SPAWN_WORKER = 0x052c; // 让 Progman 生成 WorkerW
const HWND_TOP = 0;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

let api = null;

function loadApi() {
  if (api) return api;
  if (process.platform !== 'win32') throw new Error('not-windows');
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  api = {
    koffi,
    FindWindowW: user32.func(
      '__stdcall uint64_t FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
    ),
    FindWindowExW: user32.func(
      '__stdcall uint64_t FindWindowExW(uint64_t hWndParent, uint64_t hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'
    ),
    GetDesktopWindow: user32.func('__stdcall uint64_t GetDesktopWindow()'),
    GetWindow: user32.func('__stdcall uint64_t GetWindow(uint64_t hWnd, uint32_t uCmd)'),
    SendMessageTimeoutW: user32.func(
      '__stdcall uint64_t SendMessageTimeoutW(uint64_t hWnd, uint32_t Msg, uint64_t wParam, int64_t lParam, uint32_t fuFlags, uint32_t uTimeout, uint64_t lpdwResult)'
    ),
    SetParent: user32.func('__stdcall uint64_t SetParent(uint64_t hWndChild, uint64_t hWndNewParent)'),
    GetParent: user32.func('__stdcall uint64_t GetParent(uint64_t hWnd)'),
    SetWindowPos: user32.func(
      '__stdcall int SetWindowPos(uint64_t hWnd, uint64_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    ),
    IsWindow: user32.func('__stdcall int IsWindow(uint64_t hWnd)'),
  };
  return api;
}

/** 取当前进程里某个 BrowserWindow 的 HWND（BigInt） */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  return BigInt(buf.readUInt32LE(0));
}

/** 找出「桌面壁纸 WorkerW」句柄 */
function findWallpaperWorkerW(a) {
  const progman = a.FindWindowW('Progman', null);
  if (progman) {
    // 让 Progman 派生出 WorkerW，并把 SHELLDLL_DefView 挪过去
    a.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0n, 0n, SMTO_NORMAL, 1000, 0n);
  }

  // 遍历顶层窗口：谁的子窗口里有 SHELLDLL_DefView，它的下一个 WorkerW 兄弟就是壁纸层
  let top = a.GetWindow(a.GetDesktopWindow(), GW_CHILD);
  let guard = 0;
  while (top && guard++ < 2000) {
    const defView = a.FindWindowExW(top, 0n, 'SHELLDLL_DefView', null);
    if (defView) {
      const workerw = a.FindWindowExW(0n, top, 'WorkerW', null);
      if (workerw) return workerw;
    }
    top = a.GetWindow(top, GW_HWNDNEXT);
  }

  // 退化路径 1：Win10 某些版本 WorkerW 直接挂在 Progman 下
  if (progman) {
    const w = a.FindWindowExW(progman, 0n, 'WorkerW', null);
    if (w) return w;
  }
  // 退化路径 2：直接认 Progman
  return progman || 0n;
}

/**
 * 把窗口钉到桌面壁纸层
 * @returns {{ok:boolean, via?:string, hwnd?:string, parent?:string, reason?:string}}
 */
function pinToDesktop(win) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-windows' };
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    const workerw = findWallpaperWorkerW(a);
    if (!workerw) return { ok: false, reason: 'workerw-not-found' };

    const ret = a.SetParent(hwnd, workerw);
    if (!ret) return { ok: false, reason: 'setparent-failed' };

    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    a.SetWindowPos(hwnd, BigInt(HWND_TOP), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);

    return { ok: true, via: 'workerw', hwnd: hwnd.toString(16), parent: workerw.toString(16) };
  } catch (err) {
    return { ok: false, reason: 'ffi-error: ' + (err && err.message) };
  }
}

/** 解除钉死（退出前调用，保证窗口能被正常销毁） */
function unpinFromDesktop(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return false;
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!a.IsWindow(hwnd)) return false;
    a.SetParent(hwnd, 0n);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { pinToDesktop, unpinFromDesktop, hwndOf };
