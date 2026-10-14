'use strict';
/**
 * GlassHour · 主进程
 *  - 组件窗口：无边框 / 透明 / 不进任务栏 / 不抢焦点 → 钉到桌面壁纸层
 *  - 托盘：控制显示隐藏、模式、设置、开机自启、退出
 *  - 设置窗口：独立普通窗口（不钉桌面层）
 *  - 位置记忆、开机自启
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const pin = require('./desktop-pin');
const {
  chainFor,
  nextCandidate,
  layerLabel,
  layerDescription,
  sanitizePref,
  clampToWorkArea,
} = require('./layer-policy');

const APP_ID = 'com.shibry88.glasshour';
const ROOT = path.join(__dirname, '..');

// 卡片 420x280 + 四周 20px 阴影留白
const CARD_W = 420;
const CARD_H = 280;
const PAD = 20;
const WIN_W = CARD_W + PAD * 2;
const WIN_H = CARD_H + PAD * 2;

const store = new Store('config', {
  x: null,
  y: null,
  mode: 'date', // 'date' | 'timer'
  targetISO: '2027-06-07T00:00:00',
  title: '2027年高考',
  durationSec: 25 * 60,
  desktopLayer: 'auto', // 'auto' | 'workerw' | 'bottom' | 'normal'
  layerProbe: true, // 钉层前做「鼠标点得到吗」自检，不合格就退下一级
  openAtLogin: false,
  visible: true,
  opacity: 1,
  entries: [],
  activeId: '',
  locked: false,
  migratedGaokao: false,
  timerRunning: false,
  timerEndsAt: 0,
  timerRemaining: 1500,
});

let widget = null;
let settingsWin = null;
let tray = null;
let quitFlag = false;

// 层级状态：layer 是「当前真的在哪一层」，pref 是用户偏好（存在 store 里）
let layerState = { layer: 'none', via: 'none', probe: 'skip', parentHwnd: 0n };
let sinkActive = false; // 是否已压在「桌面图标之上、普通窗口之下」
let layerKeeper = null; // sink 模式的 z 序守卫
let layerWatchdog = null; // Explorer 重启导致掉层后的重钉守卫
let dragging = false;
let dragOffset = null;
let dragTarget = null;
let saveTimer = null;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'glasshour.log'), line);
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 倒计时条目（v1.1：多条 + 每条自定义截止时间与备注）                  */
/* ------------------------------------------------------------------ */
// 统一用「本地朴素」时间串 YYYY-MM-DDTHH:mm:ss —— 和设置页的 date/time 输入一一对应，
// 且 new Date(str) 会按本地时区解析，不会出现时区偏移
const in30Days = () => {
  const d = new Date(Date.now() + 30 * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function newEntry(patch) {
  return Object.assign(
    {
      id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: '新的倒计时',
      targetISO: in30Days(),
      note: '',
    },
    patch || {}
  );
}

/** 规范化条目列表；首次运行会把旧的单条 title/targetISO 平滑迁进来 */
function normalizeEntries() {
  let list = store.get('entries');
  if (!Array.isArray(list) || list.length === 0) {
    list = [
      newEntry({
        title: store.get('title') || '2027年高考',
        targetISO: store.get('targetISO') || '2027-06-07T00:00:00',
        note: '',
      }),
    ];
  }

  // 一次性迁移：如果用户从没动过，仍停在老的「元旦 / 2027-01-01」预设上，
  // 就换成新的「2027年高考 / 2027-06-07T00:00:00」（只做一次，动过就不碰）
  if (!store.get('migratedGaokao')) {
    const untouched =
      list.length === 1 &&
      list[0] &&
      list[0].title === '元旦' &&
      list[0].targetISO === '2027-01-01T00:00:00' &&
      !list[0].note;
    if (untouched) {
      list[0].title = '2027年高考';
      list[0].targetISO = '2027-06-07T00:00:00';
      log('migrate: 旧预设「元旦/2027-01-01」→「2027年高考 / 2027-06-07T00:00:00」');
    }
    store.set('migratedGaokao', true);
  }
  list = list.map((e, i) =>
    Object.assign(newEntry(), e || {}, {
      id: e && e.id ? e.id : 'e' + i,
      title: e && typeof e.title === 'string' && e.title.trim() ? e.title : '未命名',
      targetISO: (e && e.targetISO) || in30Days(),
      note: e && typeof e.note === 'string' ? e.note : '',
    })
  );
  store.set('entries', list);
  if (!list.some((e) => e.id === store.get('activeId'))) store.set('activeId', list[0].id);
  return list;
}

function activeEntry() {
  const list = store.get('entries') || [];
  return list.find((e) => e.id === store.get('activeId')) || list[0] || null;
}

function updateEntry(id, patch, doBroadcast) {
  const list = normalizeEntries();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return null;
  for (const k of ['title', 'targetISO', 'note']) {
    if (patch && k in patch) list[i][k] = patch[k];
  }
  store.set('entries', list);
  log(`entry:update id=${id} -> ${JSON.stringify({ title: list[i].title, targetISO: list[i].targetISO, note: list[i].note })}`);
  if (doBroadcast !== false) {
    refreshTrayMenu();
    broadcast();
  }
  return list[i];
}

function addEntry(patch) {
  const list = normalizeEntries();
  const e = newEntry(patch);
  list.push(e);
  store.set('entries', list);
  store.set('activeId', e.id);
  log(`entry:add id=${e.id} title=${e.title} target=${e.targetISO}（共 ${list.length} 条）`);
  refreshTrayMenu();
  broadcast();
  return e;
}

function removeEntry(id) {
  const list = normalizeEntries();
  if (list.length <= 1) return { ok: false, reason: 'last-entry' };
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return { ok: false, reason: 'not-found' };
  list.splice(i, 1);
  store.set('entries', list);
  if (store.get('activeId') === id) store.set('activeId', list[Math.min(i, list.length - 1)].id);
  log(`entry:remove id=${id}（剩 ${list.length} 条）`);
  refreshTrayMenu();
  broadcast();
  return { ok: true };
}

function setActiveEntry(id) {
  const list = normalizeEntries();
  if (!list.some((e) => e.id === id)) return { ok: false };
  store.set('activeId', id);
  log(`entry:set-active id=${id}`);
  refreshTrayMenu();
  broadcast();
  return { ok: true };
}

function stepActiveEntry(dir) {
  const list = normalizeEntries();
  const i = list.findIndex((e) => e.id === store.get('activeId'));
  const n = Math.min(Math.max(i + (dir > 0 ? 1 : -1), 0), list.length - 1);
  if (n !== i) setActiveEntry(list[n].id);
  return list[n];
}

/** 托盘里的「切换倒计时」子菜单（只有 1 条时返回 null，不出现） */
function entryMenu() {
  const list = store.get('entries') || [];
  if (list.length <= 1) return null;
  return {
    label: '切换倒计时',
    submenu: list.map((e) => ({
      label: `${e.title}（${String(e.targetISO).slice(0, 10)}）`,
      type: 'radio',
      checked: e.id === store.get('activeId'),
      click: () => setActiveEntry(e.id),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    store.set('visible', true);
    if (widget) {
      widget.showInactive();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 组件窗口                                                            */
/* ------------------------------------------------------------------ */
function workAreas() {
  try {
    const list = screen.getAllDisplays();
    if (list && list.length) return list.map((d) => d.workArea);
  } catch (_) {
    /* 老运行时 / 测试替身只有主屏 */
  }
  return [screen.getPrimaryDisplay().workArea];
}

function defaultPosition() {
  const wa = workAreas()[0];
  return {
    x: wa.x + wa.width - WIN_W - 24,
    y: wa.y + wa.height - WIN_H - 40,
  };
}

function createWidget() {
  const d = defaultPosition();
  // 恢复上次位置，并保证至少有一部分落在某块屏幕里（换显示器 / 改分辨率后不至于丢到屏幕外）
  const restored = clampToWorkArea(
    Number.isFinite(store.get('x')) ? store.get('x') : d.x,
    Number.isFinite(store.get('y')) ? store.get('y') : d.y,
    WIN_W,
    WIN_H,
    workAreas()
  );
  const x = restored.x;
  const y = restored.y;
  if (restored.moved) log(`位置兜底：修正到 ${x},${y}`);

  widget = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: false,
    hasShadow: false,
    acceptFirstMouse: true,
    show: false,
    title: 'GlassHour',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  widget.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  widget.once('ready-to-show', () => {
    if (store.get('visible')) widget.showInactive();
    applyLayer();
  });

  // 位置记忆：拖动中由 drag:end 统一落盘，这里只处理别的位移，并做防抖（别每帧写盘）
  widget.on('moved', () => {
    if (!widget || widget.isDestroyed()) return;
    if (dragging || store.get('locked')) return;
    const [wx, wy] = widget.getPosition();
    savePositionSoon({ x: wx, y: wy });
  });

  widget.on('close', (e) => {
    // 用户点关闭（正常不会发生）→ 只隐藏，不销毁
    if (!quitFlag) {
      e.preventDefault();
      widget.hide();
      store.set('visible', false);
    }
  });

  widget.on('closed', () => {
    widget = null;
  });
}

/* ------------------------------------------------------------------ */
/* 桌面层 / 固定                                                       */
/* ------------------------------------------------------------------ */
function savePositionSoon(pos) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const p = clampToWorkArea(pos.x, pos.y, WIN_W, WIN_H, workAreas());
    store.patch({ x: Math.round(p.x), y: Math.round(p.y) });
  }, 400);
}

function stopLayerKeeper() {
  if (layerKeeper) {
    clearInterval(layerKeeper);
    layerKeeper = null;
  }
}

function stopLayerWatchdog() {
  if (layerWatchdog) {
    clearInterval(layerWatchdog);
    layerWatchdog = null;
  }
}

/** sink 守卫：一直被别的窗口挤，就再压回去 */
function startLayerKeeper() {
  stopLayerKeeper();
  if (!pin.supported()) return;
  layerKeeper = setInterval(() => {
    if (!widget || widget.isDestroyed() || !sinkActive) return;
    pin.sinkAboveDesktop(widget);
  }, 2000);
}

/** 掉层守卫：Explorer 重启会让 WorkerW 句柄作废，这时重走一遍落位流程 */
function startLayerWatchdog() {
  stopLayerWatchdog();
  if (!pin.supported()) return;
  layerWatchdog = setInterval(() => {
    if (!widget || widget.isDestroyed() || !store.get('locked')) return;
    if (layerState.layer !== 'workerw' && layerState.layer !== 'progman') return;
    const parent = pin.parentOf(widget);
    if (parent && parent === layerState.parentHwnd) return;
    log(`watchdog: 桌面层失效（parent=${parent.toString(16)}）→ 重新钉`);
    applyLayer();
  }, 4000);
}

/** 解除钉层 → 普通顶层窗口（位置原地不动） */
function toTopLevel() {
  const detached = pin.detachToTopLevel(widget);
  sinkActive = false;
  stopLayerKeeper();
  stopLayerWatchdog();
  layerState = { layer: 'normal', via: detached ? 'detached' : 'none', probe: 'skip', parentHwnd: 0n };
  return detached;
}

/** 压到「桌面图标之上、所有普通窗口之下」：一定可点击，同时被别的窗口盖住 */
function applySink() {
  sinkActive =
    pin.supported() && widget && !widget.isDestroyed() ? !!pin.sinkAboveDesktop(widget) : false;
  if (sinkActive) startLayerKeeper();
  else stopLayerKeeper();
  return sinkActive;
}

/** 试挂某一级：成功返回 {ok:true, via, parent}，失败返回 {ok:false, reason} */
function tryLayer(cand) {
  if (cand === 'workerw' || cand === 'progman') {
    const r = pin.pinToDesktop(widget, { target: cand });
    return r.ok ? { ok: true, via: r.via, parent: r.parent } : { ok: false, reason: r.reason };
  }
  if (cand === 'sink') {
    pin.detachToTopLevel(widget);
    return pin.sinkAboveDesktop(widget) ? { ok: true, via: 'sink' } : { ok: false, reason: 'no-anchor' };
  }
  pin.detachToTopLevel(widget); // normal
  return { ok: true, via: 'normal' };
}

/**
 * 落位总闸门：所有层级变化都从这里走。
 *   locked = true  → 按偏好链钉进桌面层，并锁死位置（每一级都做真机点击自检）
 *   locked = false → 解绑成普通窗口，可拖到任意地方（仍尽量待在桌面上、可点击）
 * @param {boolean} [force] 跳过点击自检，强制使用首选层级
 */
function applyLayer(force) {
  if (!widget || widget.isDestroyed()) return layerState;
  stopLayerKeeper();
  stopLayerWatchdog();
  sinkActive = false;

  const locked = !!store.get('locked');

  if (!locked) {
    toTopLevel();
    widget.setMovable(true);
    applySink();
    log(`layer → normal${sinkActive ? '+sink' : ''}（未固定：可自由拖动）`);
    refreshTrayMenu();
    broadcast();
    return layerState;
  }

  const pref = sanitizePref(store.get('desktopLayer'));
  const chain = chainFor(pref);
  const tried = [];
  let accepted = null;

  for (let cand = nextCandidate(chain, tried); cand; cand = nextCandidate(chain, tried)) {
    tried.push(cand);
    const res = tryLayer(cand);
    if (!res.ok) {
      log(`layer ${cand} 挂载失败：${res.reason}`);
      continue;
    }
    if (cand === 'normal' || force || !store.get('layerProbe')) {
      accepted = { layer: cand, via: res.via, parent: res.parent, probe: 'skip' };
      break;
    }
    // 真机自检：窗口中心点上鼠标点得到谁？探测本身没做成（非 Windows / 窗口隐藏）按通过处理
    const p = pin.probeHitTest(widget);
    if (!p.ok) {
      accepted = { layer: cand, via: res.via, parent: res.parent, probe: 'unknown:' + p.reason };
      break;
    }
    if (p.ours) {
      accepted = { layer: cand, via: res.via, parent: res.parent, probe: 'ok' };
      break;
    }
    log(`layer ${cand} 自检未通过：窗口中心点被 ${p.hit} 挡住，鼠标点不到 → 退下一级`);
    pin.detachToTopLevel(widget);
  }

  if (!accepted) {
    // 全都不行 → 至少保证能点、能拖
    pin.detachToTopLevel(widget);
    applySink();
    accepted = { layer: 'normal', via: 'fallback', probe: 'skip' };
  }

  layerState = {
    layer: accepted.layer,
    via: accepted.via,
    probe: accepted.probe,
    parentHwnd: accepted.parent ? BigInt('0x' + accepted.parent) : 0n,
  };
  widget.setMovable(false);
  if (accepted.layer === 'sink') startLayerKeeper();
  if (accepted.layer === 'workerw' || accepted.layer === 'progman') startLayerWatchdog();
  log(`layer → ${accepted.layer}（${layerLabel(accepted.layer)}）probe=${accepted.probe}`);
  refreshTrayMenu();
  broadcast();
  return layerState;
}

/** 逐级自检（托盘菜单里的「桌面层自检」）：把每一级在真机上的结果打给用户看 */
function diagnoseLayers() {
  if (!pin.supported()) {
    dialog.showMessageBox({
      type: 'info',
      title: '桌面层自检',
      message: '当前平台不支持',
      detail: '桌面层钉死依赖 Windows 的 user32.dll，只在 Windows 上可用。',
      buttons: ['好'],
    });
    return;
  }
  const keepLocked = !!store.get('locked');
  store.set('locked', true);
  const lines = [];
  for (const cand of ['workerw', 'progman', 'sink', 'normal']) {
    const res = tryLayer(cand);
    let verdict = '挂载失败：' + res.reason;
    if (res.ok) {
      const p = pin.probeHitTest(widget);
      if (!p.ok) verdict = '挂载成功（点击自检无法进行：' + p.reason + '）';
      else verdict = p.ours ? '挂载成功 · 鼠标点得到 ✅' : `挂载成功 · 但鼠标点不到（中心点命中 ${p.hit}）❌`;
    }
    lines.push(`${layerLabel(cand)}\n    ${verdict}`);
  }
  store.set('locked', keepLocked);
  applyLayer();
  dialog.showMessageBox({
    type: 'info',
    title: '桌面层自检',
    message: `各方案的真机结果（当前生效：${layerLabel(layerState.layer)}）`,
    detail: lines.join('\n\n'),
    buttons: ['好'],
  });
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */
function trayImage() {
  for (const name of ['tray.png', 'tray@2x.png', 'icon.png']) {
    const p = path.join(ROOT, 'assets', name);
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    }
  }
  return nativeImage.createEmpty();
}

function setAutoStart(on) {
  store.set('openAtLogin', !!on);
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      openAsHidden: false,
      path: process.execPath,
      args: ['--autostart'],
    });
  } catch (err) {
    log('setLoginItemSettings failed:', err && err.message);
  }
  refreshTrayMenu();
}

function currentAutoStart() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return !!store.get('openAtLogin');
  }
}

function setMode(mode) {
  store.set('mode', mode);
  if (widget && !widget.isDestroyed()) widget.webContents.send('state:changed', publicState());
  refreshTrayMenu();
}

function showWidget() {
  if (!widget || widget.isDestroyed()) {
    createWidget();
    store.set('visible', true);
    return;
  }
  widget.showInactive();
  store.set('visible', true);
  applyLayer(); // 重新显示后把层级再捋一遍（隐藏期间可能被人挤过）
}

function hideWidget() {
  if (widget && !widget.isDestroyed()) widget.hide();
  store.set('visible', false);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 520,
    minHeight: 600,
    title: 'GlassHour · 设置',
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function resetPosition() {
  const d = defaultPosition();
  if (!widget || widget.isDestroyed()) {
    store.patch({ x: d.x, y: d.y });
    return;
  }
  // 先解绑回普通窗口，setPosition 才是「屏幕坐标」语义；固定状态下再照新位置钉回去
  pin.detachToTopLevel(widget);
  widget.setPosition(d.x, d.y);
  store.patch({ x: d.x, y: d.y });
  applyLayer();
  log(`resetPosition → ${d.x},${d.y}`);
}

/** 固定 / 解锁（图钉按钮与托盘共用同一条路径） */
function toggleLock(next) {
  const value = typeof next === 'boolean' ? next : !store.get('locked');
  store.set('locked', value);
  log(`locked -> ${value}`);
  applyLayer();
  return value;
}

function refreshTrayMenu() {
  if (!tray) return;
  const mode = store.get('mode');
  const items = [
      {
        label: store.get('visible') ? '隐藏组件' : '显示组件',
        click: () => (store.get('visible') ? hideWidget() : showWidget()),
      },
      { type: 'separator' },
      {
        label: store.get('locked') ? '✅ 已固定（点此解锁，即可拖动）' : '📌 固定到桌面（锁住当前位置）',
        click: () => toggleLock(),
      },
      { type: 'separator' },
      { label: '本模式：目标日期倒计时', type: 'radio', checked: mode === 'date', click: () => setMode('date') },
      { label: '本模式：时长计时器', type: 'radio', checked: mode === 'timer', click: () => setMode('timer') },
      { type: 'separator' },
      { label: '设置…', click: openSettings },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: currentAutoStart(),
        click: (item) => setAutoStart(item.checked),
      },
      {
        label: '桌面层',
        submenu: [
          { label: '自动（推荐：逐级自检回退）', type: 'radio', checked: store.get('desktopLayer') === 'auto', click: () => { store.set('desktopLayer', 'auto'); applyLayer(); refreshTrayMenu(); } },
          { label: '强制壁纸层 WorkerW（跳过自检）', type: 'radio', checked: store.get('desktopLayer') === 'workerw', click: () => { store.set('desktopLayer', 'workerw'); applyLayer(true); refreshTrayMenu(); } },
          { label: '兼容模式（桌面之上 · 必定可点击）', type: 'radio', checked: store.get('desktopLayer') === 'bottom', click: () => { store.set('desktopLayer', 'bottom'); applyLayer(); refreshTrayMenu(); } },
          { label: '普通窗口（不钉层）', type: 'radio', checked: store.get('desktopLayer') === 'normal', click: () => { store.set('desktopLayer', 'normal'); applyLayer(); refreshTrayMenu(); } },
          { type: 'separator' },
          { label: '钉层前做点击自检', type: 'checkbox', checked: !!store.get('layerProbe'), click: (item) => { store.set('layerProbe', !!item.checked); applyLayer(); refreshTrayMenu(); } },
          { label: '立即重钉一次', click: () => applyLayer() },
        ],
      },
      { label: '桌面层自检…', click: diagnoseLayers },
      { label: '重置窗口位置', click: resetPosition },
      { type: 'separator' },
      {
        label: '关于 GlassHour',
        click: () =>
          dialog.showMessageBox({
            type: 'info',
            title: '关于 GlassHour',
            message: 'GlassHour · 琉璃沙漏',
            detail:
              `版本 ${app.getVersion()}\n液态玻璃桌面倒计时组件 for Windows 10\n\n` +
              `位置：${store.get('locked') ? '已固定（不可拖动）' : '未固定（可拖动）'}\n` +
              `当前层级：${layerLabel(layerState.layer)}（偏好：${sanitizePref(store.get('desktopLayer'))}）\n` +
              `点击自检：${layerState.probe === 'ok' ? '通过' : layerState.probe}\n` +
              `配置文件：${store.file}\n\nMIT License`,
            buttons: ['好'],
          }),
      },
      { label: '退出', click: () => { quitFlag = true; app.quit(); } },
  ];
  const em = entryMenu();
  if (em) items.splice(5, 0, em);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (err) {
    log('tray failed:', err && err.message);
    return;
  }
  tray.setToolTip('GlassHour · 琉璃沙漏');
  tray.on('double-click', () => (store.get('visible') ? hideWidget() : showWidget()));
  refreshTrayMenu();
}

/* ------------------------------------------------------------------ */
/* 状态 / IPC                                                          */
/* ------------------------------------------------------------------ */
function publicState() {
  const list = store.get('entries') || [];
  const act = activeEntry();
  return {
    mode: store.get('mode'),
    entries: list.map((e) => ({ id: e.id, title: e.title, targetISO: e.targetISO, note: e.note })),
    activeId: store.get('activeId'),
    targetISO: act ? act.targetISO : store.get('targetISO'),
    title: act ? act.title : store.get('title'),
    note: act ? act.note : '',
    durationSec: store.get('durationSec'),
    opacity: store.get('opacity'),
    visible: store.get('visible'),
    timerRunning: !!store.get('timerRunning'),
    timerEndsAt: store.get('timerEndsAt') || 0,
    timerRemaining: store.get('timerRemaining'),
    // desktopLayer = 当前真正生效的层级；desktopLayerPref = 用户偏好（设置页那一栏绑这个）
    desktopLayer: layerState.layer,
    desktopLayerLabel: layerLabel(layerState.layer),
    desktopLayerDesc: layerDescription(layerState.layer),
    desktopLayerPref: sanitizePref(store.get('desktopLayer')),
    desktopLayerProbe: layerState.probe || 'skip',
    layerProbeEnabled: !!store.get('layerProbe'),
    locked: !!store.get('locked'),
    version: app.getVersion(),
    loginItem: currentAutoStart(),
    userData: app.getPath('userData'),
    now: Date.now(),
  };
}

function broadcast() {
  const s = publicState();
  if (widget && !widget.isDestroyed()) widget.webContents.send('state:changed', s);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state:changed', s);
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('state:set', (_e, patch) => {
    const allowed = ['mode', 'durationSec', 'opacity', 'desktopLayer', 'locked', 'layerProbe',
      'timerRunning', 'timerEndsAt', 'timerRemaining'];
    const clean = {};
    for (const k of Object.keys(patch || {})) if (allowed.includes(k)) clean[k] = patch[k];
    const entryPatch = {};
    for (const k of ['title', 'targetISO', 'note']) {
      if (patch && k in patch) entryPatch[k] = patch[k];
    }
    store.patch(clean);
    if (Object.keys(entryPatch).length) updateEntry(store.get('activeId'), entryPatch, false);
    else log(`state:set ${JSON.stringify(clean)}`);
    // 固定状态 / 桌面层偏好 / 自检开关，任何一项变了都要重新落位
    if ('locked' in clean || 'desktopLayer' in clean || 'layerProbe' in clean) applyLayer();
    refreshTrayMenu();
    broadcast();
    return publicState();
  });
  ipcMain.handle('mode:set', (_e, m) => {
    setMode(m === 'timer' ? 'timer' : 'date');
    return publicState();
  });
  ipcMain.handle('ui:open-settings', () => openSettings());
  ipcMain.handle('ui:hide', () => hideWidget());
  ipcMain.handle('ui:reset-position', () => {
    resetPosition();
    return true;
  });
  ipcMain.handle('app:quit', () => {
    quitFlag = true;
    app.quit();
  });
  ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));
  ipcMain.handle('entry:add', (_e, patch) => {
    addEntry(patch || {});
    return publicState();
  });
  ipcMain.handle('entry:update', (_e, arg) => {
    const a = arg || {};
    updateEntry(a.id, a.patch || {});
    return publicState();
  });
  ipcMain.handle('entry:remove', (_e, id) => {
    const r = removeEntry(id);
    return Object.assign({ state: publicState() }, r);
  });
  ipcMain.handle('entry:set-active', (_e, id) => {
    setActiveEntry(id);
    return publicState();
  });
  ipcMain.handle('entry:step', (_e, dir) => {
    stepActiveEntry(dir);
    return publicState();
  });
  ipcMain.handle('login-item:set', (_e, on) => {
    setAutoStart(!!on);
    return { openAtLogin: currentAutoStart(), userData: app.getPath('userData') };
  });

  /*
   * 手动拖动（不依赖 -webkit-app-region）。
   * 渲染层那一句 `if (state.locked) return` 只是提前省事，主进程这里的 store 判断才是权威闸门：
   * 就算渲染层状态过期，固定状态下也一律不放行。
   */
  ipcMain.on('drag:start', () => {
    if (!widget || widget.isDestroyed()) return;
    if (store.get('locked')) {
      log('drag:start 被拒：已固定（先点图钉解锁）');
      return;
    }
    dragging = true;
    // 拖之前先脱离桌面层：这样 getPosition/setPosition 就是普通屏幕坐标，任何显示器布局都不会错位
    pin.detachToTopLevel(widget);
    sinkActive = false;
    stopLayerKeeper();
    const pt = screen.getCursorScreenPoint();
    const [wx, wy] = widget.getPosition();
    dragOffset = { dx: pt.x - wx, dy: pt.y - wy };
    dragTarget = { x: wx, y: wy };
    // 拖动期间浮到最上层，否则会被别的窗口盖住（看不见自己在拖什么）
    try {
      widget.setAlwaysOnTop(true, 'screen-saver');
    } catch (_) {
      /* ignore */
    }
    log(`drag:start ${wx},${wy}`);
  });

  ipcMain.on('drag:move', () => {
    if (!dragging || !dragOffset || !widget || widget.isDestroyed()) return;
    if (store.get('locked')) return;
    const pt = screen.getCursorScreenPoint();
    dragTarget = { x: Math.round(pt.x - dragOffset.dx), y: Math.round(pt.y - dragOffset.dy) };
    widget.setPosition(dragTarget.x, dragTarget.y);
  });

  ipcMain.on('drag:end', () => {
    if (!dragging) return;
    dragging = false;
    dragOffset = null;
    if (!widget || widget.isDestroyed()) return;
    if (dragTarget) savePositionSoon(dragTarget);
    try {
      widget.setAlwaysOnTop(false);
    } catch (_) {
      /* ignore */
    }
    // 松手后按当前固定状态重新落位：锁着 → 钉回桌面层；没锁 → 沉回「桌面之上」，但位置是新的
    applyLayer();
    log(`drag:end ${JSON.stringify(dragTarget)}`);
  });
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  normalizeEntries();
  registerIpc();
  createWidget();
  createTray();

  // 同步开机自启的真实状态
  const real = currentAutoStart();
  if (real !== !!store.get('openAtLogin')) store.set('openAtLogin', real);
  else if (store.get('openAtLogin')) setAutoStart(true);

  app.on('activate', () => showWidget());
});

app.on('window-all-closed', () => {
  // 组件常驻托盘，不跟随窗口关闭退出（有监听器即由我们接管，默认不退出）
});

app.on('before-quit', () => {
  quitFlag = true;
  stopLayerKeeper();
  stopLayerWatchdog();
  if (saveTimer) clearTimeout(saveTimer);
  if (widget && !widget.isDestroyed()) pin.detachToTopLevel(widget);
});
