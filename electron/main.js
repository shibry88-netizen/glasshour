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
const { pinToDesktop, unpinFromDesktop } = require('./desktop-pin');

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
let layerInfo = { via: 'none' };
let dragOffset = null;
let bottomKeeper = null;
let quitFlag = false;

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
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIN_W - 24,
    y: workArea.y + workArea.height - WIN_H - 40,
  };
}

function createWidget() {
  const d = defaultPosition();
  const x = Number.isFinite(store.get('x')) ? store.get('x') : d.x;
  const y = Number.isFinite(store.get('y')) ? store.get('y') : d.y;

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
    applyDesktopLayer();
  });

  widget.on('moved', () => {
    if (!widget || widget.isDestroyed()) return;
    const [wx, wy] = widget.getPosition();
    store.set('x', wx);
    store.set('y', wy);
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
/* 桌面层策略                                                          */
/* ------------------------------------------------------------------ */
function stopBottomKeeper() {
  if (bottomKeeper) {
    clearInterval(bottomKeeper);
    bottomKeeper = null;
  }
}

/** 回退方案：不可激活 + 不进任务栏 + 常驻 z 序底部 */
function startBottomKeeper() {
  stopBottomKeeper();
  layerInfo = { via: 'bottom' };
  bottomKeeper = setInterval(() => {
    if (!widget || widget.isDestroyed()) return;
    try {
      widget.setAlwaysOnTop(false);
    } catch (_) {
      /* ignore */
    }
  }, 800);
}

function applyDesktopLayer() {
  if (!widget || widget.isDestroyed()) return;
  const strategy = store.get('desktopLayer');
  stopBottomKeeper();
  layerInfo = { via: 'none' };

  if (strategy === 'normal') return;

  if (strategy === 'bottom') {
    startBottomKeeper();
    return;
  }

  if (strategy === 'workerw') {
    const r = pinToDesktop(widget);
    layerInfo = r;
    log('pin(workerw):', JSON.stringify(r));
    if (!r.ok) startBottomKeeper();
    return;
  }

  // auto：先试真·壁纸层，失败自动回退
  const r = pinToDesktop(widget);
  layerInfo = r;
  log('pin(auto):', JSON.stringify(r));
  if (!r.ok) startBottomKeeper();
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
  store.patch({ x: d.x, y: d.y });
  if (widget && !widget.isDestroyed()) {
    widget.setPosition(d.x, d.y);
    if (layerInfo.via === 'workerw') applyDesktopLayer();
  }
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
          { label: '自动（推荐）', type: 'radio', checked: store.get('desktopLayer') === 'auto', click: () => { store.set('desktopLayer', 'auto'); applyDesktopLayer(); refreshTrayMenu(); } },
          { label: '强制钉在壁纸层 (WorkerW)', type: 'radio', checked: store.get('desktopLayer') === 'workerw', click: () => { store.set('desktopLayer', 'workerw'); applyDesktopLayer(); refreshTrayMenu(); } },
          { label: '兼容模式（不可激活底层窗口）', type: 'radio', checked: store.get('desktopLayer') === 'bottom', click: () => { store.set('desktopLayer', 'bottom'); applyDesktopLayer(); refreshTrayMenu(); } },
          { label: '普通窗口', type: 'radio', checked: store.get('desktopLayer') === 'normal', click: () => { store.set('desktopLayer', 'normal'); applyDesktopLayer(); refreshTrayMenu(); } },
        ],
      },
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
              `桌面层：${layerInfo.via}${layerInfo.reason ? ' (' + layerInfo.reason + ')' : ''}\n` +
              `配置文件：${store.file}\n\nMIT License`,
            buttons: ['好'],
          }),
      },
      { label: '退出', click: () => { quitFlag = true; app.quit(); } },
  ];
  const em = entryMenu();
  if (em) items.splice(2, 0, em);
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
    desktopLayer: layerInfo.via,
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
    const allowed = ['mode', 'durationSec', 'opacity', 'desktopLayer', 'locked',
      'timerRunning', 'timerEndsAt', 'timerRemaining'];
    const clean = {};
    for (const k of Object.keys(patch || {})) if (allowed.includes(k)) clean[k] = patch[k];
    const entryPatch = {};
    for (const k of ['title', 'targetISO', 'note']) {
      if (patch && k in patch) entryPatch[k] = patch[k];
    }
    store.patch(clean);
    if ('locked' in clean) log(`locked -> ${clean.locked}`);
    if (Object.keys(entryPatch).length) updateEntry(store.get('activeId'), entryPatch, false);
    else log(`state:set ${JSON.stringify(clean)}`);
    if ('desktopLayer' in clean) applyDesktopLayer();
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

  // 手动拖动（不依赖 -webkit-app-region，WorkerW 子窗口下更可靠）
  ipcMain.on('drag:start', () => {
    if (!widget || widget.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const [wx, wy] = widget.getPosition();
    dragOffset = { dx: pt.x - wx, dy: pt.y - wy };
  });
  ipcMain.on('drag:move', () => {
    if (!dragOffset || !widget || widget.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    widget.setPosition(Math.round(pt.x - dragOffset.dx), Math.round(pt.y - dragOffset.dy));
  });
  ipcMain.on('drag:end', () => {
    dragOffset = null;
    if (widget && !widget.isDestroyed()) {
      const [wx, wy] = widget.getPosition();
      store.patch({ x: wx, y: wy });
    }
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
  stopBottomKeeper();
  if (widget && !widget.isDestroyed()) unpinFromDesktop(widget);
});
