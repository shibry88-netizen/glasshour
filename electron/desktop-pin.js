'use strict';
/**
 * GlassHour · 窗口层级（Windows 10，koffi 直调 user32.dll）
 *
 * 四种落位方式：
 *   workerw —— SetParent 到「壁纸层」WorkerW：被所有窗口盖住、不进任务栏/Alt+Tab，
 *              Win+D 显示桌面也不会消失（最强，但部分机器上鼠标点不到窗口）
 *   progman —— SetParent 到桌面窗口 Progman：语义同上，命中测试通常更宽松
 *   sink    —— 不挂父窗口，用 SetWindowPos 把自己压在「桌面图标层之上、所有普通窗口之下」：
 *              一定可点击，被其它窗口盖住
 *   normal  —— 完全不动层级
 *
 * 坐标单位约定（重要，别混）：
 *   · 本文件里所有 FFI 调用一律用 **物理像素**（GetWindowRect / SetWindowPos / WindowFromPoint），
 *     而且窗口的这些调用都是「读出来原样还回去」，所以不管有没有 DPI 缩放都自洽；
 *   · Electron 的 getPosition/setPosition 一律是 **DIP**，只在上层 main.js 里使用。
 *   两边只在「钉层 / 解除钉层」的瞬间交接，且此时窗口逻辑位置不变，因此不需要做单位换算。
 *
 * 所有函数失败都返回 {ok:false, reason} / false，绝不抛异常打断组件运行。
 */

const GW_CHILD = 5; // GetWindow: 第一个子窗口（z 序最顶）
const GW_HWNDNEXT = 2; // GetWindow: 下一个兄弟窗口（z 序更靠下）
const SMTO_NORMAL = 0x0000;
const WM_SPAWN_WORKER = 0x052c; // 让 Progman 派生 WorkerW
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0n;

let api = null;

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return 0n;
}

function loadApi() {
  if (api) return api;
  if (!supported()) throw new Error('not-windows');
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const RECT = koffi.struct('GH_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const POINT = koffi.struct('GH_POINT', { x: 'int32_t', y: 'int32_t' });
  api = {
    koffi,
    _RECT: RECT,
    _POINT: POINT,
    FindWindowW: user32.func(
      '__stdcall uint64_t FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
    ),
    FindWindowExW: user32.func(
      '__stdcall uint64_t FindWindowExW(uint64_t hWndParent, uint64_t hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'
    ),
    GetDesktopWindow: user32.func('__stdcall uint64_t GetDesktopWindow()'),
    GetWindow: user32.func('__stdcall uint64_t GetWindow(uint64_t hWnd, uint32_t uCmd)'),
    GetParent: user32.func('__stdcall uint64_t GetParent(uint64_t hWnd)'),
    IsWindow: user32.func('__stdcall int IsWindow(uint64_t hWnd)'),
    IsChild: user32.func('__stdcall int IsChild(uint64_t hWndParent, uint64_t hWnd)'),
    GetWindowRect: user32.func('__stdcall int GetWindowRect(uint64_t hWnd, _Out_ GH_RECT *lprc)'),
    WindowFromPoint: user32.func('__stdcall uint64_t WindowFromPoint(GH_POINT pt)'),
    SendMessageTimeoutW: user32.func(
      '__stdcall uint64_t SendMessageTimeoutW(uint64_t hWnd, uint32_t Msg, uint64_t wParam, int64_t lParam, uint32_t fuFlags, uint32_t uTimeout, uint64_t lpdwResult)'
    ),
    SetParent: user32.func('__stdcall uint64_t SetParent(uint64_t hWndChild, uint64_t hWndNewParent)'),
    SetWindowPos: user32.func(
      '__stdcall int SetWindowPos(uint64_t hWnd, uint64_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    ),
  };
  return api;
}

function supported() {
  // GLASSHOUR_FORCE_WIN32 只给自动化测试用：在没有 Windows 的地方也能把这条 FFI 链路跑起来
  if (process.env.GLASSHOUR_FORCE_WIN32 === '1') return true;
  return process.platform === 'win32';
}

/** 取当前进程里某个 BrowserWindow 的 HWND（BigInt） */
function hwndOf(win) {
  if (!win || win.isDestroyed()) return 0n;
  const buf = win.getNativeWindowHandle();
  if (!buf || !buf.length) return 0n;
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  return BigInt(buf.readUInt32LE(0));
}

/** 物理像素的窗口矩形（FFI 用），拿不到就回退 Electron 的 DIP 值 */
function ffiRect(a, hwnd) {
  try {
    const rc = {};
    if (a.GetWindowRect(hwnd, rc)) {
      return {
        x: rc.left,
        y: rc.top,
        width: Math.max(1, rc.right - rc.left),
        height: Math.max(1, rc.bottom - rc.top),
      };
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function windowRect(win) {
  if (supported() && win && !win.isDestroyed()) {
    try {
      const a = loadApi();
      const hwnd = hwndOf(win);
      if (hwnd && a.IsWindow(hwnd)) {
        const r = ffiRect(a, hwnd);
        if (r) return r;
      }
    } catch (_) {
      /* fallthrough */
    }
  }
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    return { x, y, width, height };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * 找桌面三个关键窗口：
 *   progman   —— 桌面窗口
 *   icon      —— 挂着 SHELLDLL_DefView（桌面图标）的那个窗口
 *   wallpaper —— 紧接着 icon 之后的 WorkerW，即真正的壁纸层
 * 枚举按 z 序从顶到底：GetWindow(GW_CHILD) 取最顶，GW_HWNDNEXT 往下走。
 */
function desktopWindows() {
  if (!supported()) return { progman: 0n, icon: 0n, wallpaper: 0n };
  const a = loadApi();
  const progman = toBig(a.FindWindowW('Progman', null));
  if (progman) {
    // 让 Progman 派生出 WorkerW，并把 SHELLDLL_DefView 挪过去
    a.SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0n, 0n, SMTO_NORMAL, 1000, 0n);
  }

  let icon = 0n;
  let wallpaper = 0n;
  let top = toBig(a.GetWindow(toBig(a.GetDesktopWindow()), GW_CHILD));
  let guard = 0;
  while (top && guard++ < 2000) {
    const defView = toBig(a.FindWindowExW(top, 0n, 'SHELLDLL_DefView', null));
    if (defView) {
      icon = top;
      const workerw = toBig(a.FindWindowExW(0n, top, 'WorkerW', null));
      if (workerw) wallpaper = workerw;
      break;
    }
    top = toBig(a.GetWindow(top, GW_HWNDNEXT));
  }

  // 退化路径：有些 Win10 版本 WorkerW 直接挂在 Progman 下
  if (!wallpaper && progman) {
    const w = toBig(a.FindWindowExW(progman, 0n, 'WorkerW', null));
    if (w) wallpaper = w;
  }

  return { progman, icon, wallpaper };
}

/** 当前窗口的父窗口（0n 表示是顶层窗口） */
function parentOf(win) {
  if (!supported() || !win || win.isDestroyed()) return 0n;
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!hwnd || !a.IsWindow(hwnd)) return 0n;
    return toBig(a.GetParent(hwnd));
  } catch (_) {
    return 0n;
  }
}

/**
 * 钉到桌面层。
 * @param {import('electron').BrowserWindow} win
 * @param {{target?: 'workerw'|'progman'}} [opts]
 * @returns {{ok:boolean, via?:string, parent?:string, reason?:string}}
 */
function pinToDesktop(win, opts) {
  if (!supported()) return { ok: false, reason: 'not-windows' };
  if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' };
  const target = (opts && opts.target) === 'progman' ? 'progman' : 'workerw';
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!hwnd || !a.IsWindow(hwnd)) return { ok: false, reason: 'no-hwnd' };

    const d = desktopWindows();
    const parent = target === 'progman' ? d.progman || d.wallpaper : d.wallpaper || d.progman;
    if (!parent) return { ok: false, reason: 'desktop-layer-not-found' };

    const before = ffiRect(a, hwnd); // 钉之前先把物理矩形记下来
    const prev = toBig(a.SetParent(hwnd, parent));
    const now = toBig(a.GetParent(hwnd));
    if (now !== parent) {
      // 还原，别把窗口丢在半截状态
      if (prev) a.SetParent(hwnd, prev);
      return { ok: false, reason: 'setparent-failed' };
    }
    // 父窗口原点未必是 (0,0)（多显示器虚拟原点可能是负的），
    // 所以订完立刻用「钉之前的绝对物理坐标」复核一次，保证视觉位置一点不跳。
    if (before) {
      a.SetWindowPos(
        hwnd,
        HWND_TOP,
        before.x,
        before.y,
        before.width,
        before.height,
        SWP_NOACTIVATE | SWP_SHOWWINDOW
      );
    }
    return {
      ok: true,
      via: target,
      hwnd: hwnd.toString(16),
      parent: parent.toString(16),
      prevParent: prev ? prev.toString(16) : '0',
    };
  } catch (err) {
    return { ok: false, reason: 'ffi-error: ' + (err && err.message) };
  }
}

/** 从桌面层解绑，回到普通顶层窗口；位置原地不动 */
function detachToTopLevel(win) {
  if (!supported() || !win || win.isDestroyed()) return false;
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!hwnd || !a.IsWindow(hwnd)) return false;
    const parent = toBig(a.GetParent(hwnd));
    if (!parent) return false; // 本来就是顶层窗口
    const before = ffiRect(a, hwnd);
    a.SetParent(hwnd, 0n);
    if (before) {
      a.SetWindowPos(
        hwnd,
        HWND_TOP,
        before.x,
        before.y,
        before.width,
        before.height,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
      );
    }
    return toBig(a.GetParent(hwnd)) === 0n;
  } catch (_) {
    return false;
  }
}

/**
 * 兼容模式落位：把自己插在「桌面图标层之上、其它普通窗口之下」。
 * 做法是 SetWindowPos(hwnd, iconOrProgman, ...)：紧跟锚点之后 = 压在它上面一点点。
 */
function sinkAboveDesktop(win) {
  if (!supported() || !win || win.isDestroyed()) return false;
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!hwnd || !a.IsWindow(hwnd)) return false;
    const d = desktopWindows();
    const anchor = d.icon || d.progman || d.wallpaper;
    if (!anchor) return false;
    return !!a.SetWindowPos(
      hwnd,
      anchor,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
    );
  } catch (_) {
    return false;
  }
}

/**
 * 真机自检：窗口中心点上，「鼠标到底点得到谁」。
 * WindowFromPoint 命中我们自己（或自己的子窗口）才算通过。
 * 返回 {ok:false} 表示这次探测本身没做成（非 Windows / 窗口隐藏 / FFI 报错），
 * 上层要把它当成「无法判断」而不是「不合格」。
 */
function probeHitTest(win) {
  if (!supported()) return { ok: false, ours: false, reason: 'not-windows' };
  if (!win || win.isDestroyed()) return { ok: false, ours: false, reason: 'no-window' };
  if (typeof win.isVisible === 'function' && !win.isVisible()) {
    return { ok: false, ours: false, reason: 'hidden' };
  }
  try {
    const a = loadApi();
    const hwnd = hwndOf(win);
    if (!hwnd || !a.IsWindow(hwnd)) return { ok: false, ours: false, reason: 'no-hwnd' };
    const rc = ffiRect(a, hwnd);
    if (!rc) return { ok: false, ours: false, reason: 'no-rect' };
    const pt = {
      x: Math.round(rc.x + rc.width / 2),
      y: Math.round(rc.y + rc.height / 2),
    };
    const hit = toBig(a.WindowFromPoint(pt));
    if (!hit) return { ok: true, ours: false, reason: 'nothing-at-point', pt };
    const ours = hit === hwnd || !!a.IsChild(hwnd, hit);
    return {
      ok: true,
      ours: !!ours,
      hit: hit.toString(16),
      pt,
      reason: ours ? 'hit-ours' : 'hit-other',
    };
  } catch (err) {
    return { ok: false, ours: false, reason: 'ffi-error: ' + (err && err.message) };
  }
}

module.exports = {
  supported,
  hwndOf,
  windowRect,
  desktopWindows,
  parentOf,
  pinToDesktop,
  detachToTopLevel,
  sinkAboveDesktop,
  probeHitTest,
};
