'use strict';
/**
 * GlassHour · 主进程逻辑集成测试（不依赖 electron 运行时、不需要 Xvfb）
 *
 * 做法：伪造 electron 模块 + 伪造 koffi（内含一个迷你 Win32 窗口世界）
 *      → require 真实 main.js → 直接调用它注册的 ipcMain handler，
 *      断言 publicState() 与落盘 config.json 的内容。
 *
 * 覆盖两件事：
 *   1) 条目增删改查 / 旧配置迁移 / 落盘（抓「改了日期但存不下来」这类问题）
 *   2) 「固定 / 解锁 / 再固定」这条桌面层链路（抓「图钉是假的」「解锁拖不动」这类问题）
 *
 * 用法： node test/main_logic.test.js
 *      （脚本会自己打开 GLASSHOUR_FORCE_WIN32，不需要真的 Windows）
 */
process.env.GLASSHOUR_FORCE_WIN32 = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
// 预置一份「老预设」的配置（就像从 v1.0 升上来的用户），用来验证一次性迁移
fs.writeFileSync(
  path.join(USER_DATA, 'config.json'),
  JSON.stringify({ mode: 'date', targetISO: '2027-01-01T00:00:00', title: '元旦', durationSec: 1500, opacity: 1 }, null, 2)
);

/* ------------------------------------------------------------------ */
/* 迷你 Win32 窗口世界：让 desktop-pin.js 的 FFI 逻辑真的跑起来          */
/* ------------------------------------------------------------------ */
const HWND = { desktop: 0x1, progman: 0x100, icon: 0x200, defview: 0x210, wallpaper: 0x300, widget: 0x400 };
const world = {
  parent: new Map(), // hwnd -> 父 hwnd
  rect: new Map(), // hwnd -> {left,top,right,bottom}（物理像素）
  hit: 'auto', // 'auto' 按父子关系推断鼠标点得到谁；也可以指定具体句柄
  calls: { setParent: [], setWindowPos: [] },
  topLevel: [HWND.icon, HWND.wallpaper, HWND.progman], // z 序：从顶到底
};
world.parent.set(HWND.icon, HWND.desktop);
world.parent.set(HWND.wallpaper, HWND.desktop);
world.parent.set(HWND.progman, HWND.desktop);
world.rect.set(HWND.widget, { left: 1436, top: 720, right: 1896, bottom: 1040 });

const n = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));
const known = () => [HWND.desktop, HWND.progman, HWND.icon, HWND.defview, HWND.wallpaper, HWND.widget];

function api(name, args) {
  switch (name) {
    case 'FindWindowW':
      return args[0] === 'Progman' ? HWND.progman : 0;
    case 'GetDesktopWindow':
      return HWND.desktop;
    case 'GetWindow': {
      const h = n(args[0]);
      const cmd = n(args[1]);
      if (cmd === 5) return h === HWND.desktop ? world.topLevel[0] : 0; // GW_CHILD = 最顶
      if (cmd === 2) {
        const i = world.topLevel.indexOf(h); // GW_HWNDNEXT = 往下
        return i >= 0 && i + 1 < world.topLevel.length ? world.topLevel[i + 1] : 0;
      }
      return 0;
    }
    case 'FindWindowExW': {
      const parent = n(args[0]);
      const after = n(args[1]);
      if (args[2] === 'SHELLDLL_DefView') return parent === HWND.icon ? HWND.defview : 0;
      if (args[2] === 'WorkerW') return parent === 0 && after === HWND.icon ? HWND.wallpaper : 0;
      return 0;
    }
    case 'SendMessageTimeoutW':
      return 1;
    case 'SetParent': {
      const child = n(args[0]);
      const parent = n(args[1]);
      const prev = world.parent.get(child) || 0;
      world.calls.setParent.push({ child, parent });
      if (parent) world.parent.set(child, parent);
      else world.parent.delete(child);
      return prev;
    }
    case 'GetParent':
      return world.parent.get(n(args[0])) || 0;
    case 'IsWindow':
      return n(args[0]) && known().includes(n(args[0])) ? 1 : 0;
    case 'IsChild':
      return 0;
    case 'GetWindowRect': {
      const rc = world.rect.get(n(args[0]));
      const out = args[1];
      if (!rc || !out || typeof out !== 'object') return 0;
      out.left = rc.left;
      out.top = rc.top;
      out.right = rc.right;
      out.bottom = rc.bottom;
      return 1;
    }
    case 'WindowFromPoint': {
      if (world.hit !== 'auto') return world.hit;
      // 真实世界的坑：挂在壁纸层时，鼠标点上去命中的是桌面图标层，不是我们的窗口
      const p = world.parent.get(HWND.widget) || 0;
      return p === HWND.wallpaper || p === HWND.progman ? HWND.icon : HWND.widget;
    }
    case 'SetWindowPos': {
      const hwnd = n(args[0]);
      const after = n(args[1]);
      const flags = n(args[6]);
      const SWP_NOMOVE = 0x0002;
      const SWP_NOSIZE = 0x0001;
      if (!(flags & SWP_NOMOVE) && !(flags & SWP_NOSIZE)) {
        world.rect.set(hwnd, {
          left: n(args[2]),
          top: n(args[3]),
          right: n(args[2]) + n(args[4]),
          bottom: n(args[3]) + n(args[5]),
        });
      }
      world.calls.setWindowPos.push({ hwnd, after, x: n(args[2]), y: n(args[3]), flags });
      return 1;
    }
    default:
      return 0;
  }
}

/** 伪 koffi：func(签名) → 用签名里的函数名分发到迷你世界 */
const fakeKoffi = {
  load: () => ({
    func: (sig) => {
      const name = (/__stdcall\s+[\w*\s]+?\s+(\w+)\s*\(/.exec(sig) || [, 'unknown'])[1];
      return (...args) => api(name, args);
    },
  }),
  struct: (name, fields) => ({ name, fields }),
};

/* ------------------------------------------------------------------ */
/* 伪 electron                                                         */
/* ------------------------------------------------------------------ */
const handlers = new Map();
const sent = [];
const windows = [];
const menus = [];
const cursor = { x: 0, y: 0 };
const registry = { command: null }; // 模拟 Windows 注册表里的启动项命令
const balloons = [];
const hotkeys = [];
let trayImg = null;

class FakeWebContents {
  send(ch, payload) {
    sent.push({ ch, payload });
  }
}
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts || {};
    this.webContents = new FakeWebContents();
    this._destroyed = false;
    this._pos = { x: this.opts.x || 0, y: this.opts.y || 0 };
    this._size = { width: this.opts.width || 460, height: this.opts.height || 320 };
    this._visible = true;
    this.movable = null;
    this.alwaysOnTop = null;
    windows.push(this);
    world.rect.set(HWND.widget, {
      left: this._pos.x,
      top: this._pos.y,
      right: this._pos.x + this._size.width,
      bottom: this._pos.y + this._size.height,
    });
  }
  loadFile() {}
  loadURL() {}
  once(ev, cb) {
    // 真实 Electron 里 ready-to-show 之后主进程会做第一次落位，测试里也让它发生
    if (ev === 'ready-to-show') setTimeout(() => cb && cb(), 0);
  }
  on() {}
  showInactive() {
    this._shown = true;
    this._visible = true;
  }
  show() {
    this._visible = true;
  }
  hide() {
    this._visible = false;
  }
  focus() {}
  isDestroyed() {
    return this._destroyed;
  }
  isVisible() {
    return this._visible;
  }
  getNativeWindowHandle() {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(HWND.widget));
    return b;
  }
  getPosition() {
    return [this._pos.x, this._pos.y];
  }
  setPosition(x, y) {
    const rc = world.rect.get(HWND.widget) || {
      left: 0,
      top: 0,
      right: this._size.width,
      bottom: this._size.height,
    };
    const w = rc.right - rc.left || this._size.width;
    const h = rc.bottom - rc.top || this._size.height;
    this._pos = { x: Math.round(x), y: Math.round(y) };
    world.rect.set(HWND.widget, {
      left: this._pos.x,
      top: this._pos.y,
      right: this._pos.x + w,
      bottom: this._pos.y + h,
    });
  }
  getSize() {
    return [this._size.width, this._size.height];
  }
  setBounds(b) {
    if (b && b.width) this._size.width = b.width;
    if (b && b.height) this._size.height = b.height;
    if (b) this.setPosition(b.x, b.y);
  }
  getBounds() {
    return { x: this._pos.x, y: this._pos.y, width: this._size.width, height: this._size.height };
  }
  setMovable(v) {
    this.movable = v;
  }
  setAlwaysOnTop(v) {
    this.alwaysOnTop = v;
  }
  setMenuBarVisibility() {}
}

const fakeElectron = {
  app: {
    getPath: () => USER_DATA,
    getVersion: () => '1.1.0',
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    // 真实 Electron 在 Windows 上的行为：写入时带 args，读取时若不带同样的 args 就匹配不上
    setLoginItemSettings: (o) => {
      const opts = o || {};
      registry.command = opts.openAtLogin
        ? opts.args && opts.args.length
          ? `${opts.path} ${opts.args.join(' ')}`
          : opts.path
        : null;
    },
    getLoginItemSettings: (o) => {
      if (!registry.command) return { openAtLogin: false };
      if (o && o.path) {
        const want = o.args && o.args.length ? `${o.path} ${o.args.join(' ')}` : o.path;
        return { openAtLogin: registry.command === want };
      }
      return { openAtLogin: false }; // 不传参数 = 不带 args 的默认项，永远匹配不上
    },
    setAppUserModelId: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  Tray: class {
    constructor(img) {
      trayImg = img;
    }
    setContextMenu(m) {
      menus.push(m);
    }
    setToolTip(t) {
      this.tip = t;
    }
    displayBalloon(o) {
      balloons.push(o);
    }
    on() {}
  },
  Menu: { buildFromTemplate: (t) => t },
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set('on:' + ch, fn),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getCursorScreenPoint: () => ({ x: cursor.x, y: cursor.y }),
  },
  nativeImage: {
    // 故意让「从文件读」失败，逼出「assets 缺图标」这条兜底路径
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createEmpty: () => ({ __empty: true }),
    createFromDataURL: (u) => ({ __fallback: true, url: u, resize: () => ({ __fallback: true }) }),
  },
  globalShortcut: {
    register: (k, fn) => {
      hotkeys.push({ key: k, fn });
      return true;
    },
    unregisterAll: () => {},
  },
  dialog: { showMessageBox: () => {} },
  shell: { openPath: () => {} },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  if (request === 'koffi') return fakeKoffi;
  return origLoad.apply(this, arguments);
};

require(path.join(__dirname, '..', 'electron', 'main.js'));

/* ------------------------------------------------------------------ */
let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log(`   ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
};

const call = (ch, ...args) => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error('没有注册这个 handler: ' + ch);
  return fn({}, ...args);
};
const cfg = () => JSON.parse(fs.readFileSync(path.join(USER_DATA, 'config.json'), 'utf8'));

(async () => {
  await new Promise((r) => setTimeout(r, 80)); // 等 whenReady().then 跑完

  console.log('\n===== 1. 首次启动：旧配置迁移 =====');
  let s = call('state:get');
  ok(Array.isArray(s.entries) && s.entries.length === 1, '自动生成 1 条条目', JSON.stringify(s.entries));
  ok(!!s.activeId && s.activeId === s.entries[0].id, 'activeId 指向它');
  ok(
    s.title === '2027年高考' && s.targetISO === '2027-06-07T00:00:00',
    `从没动过的旧预设「元旦/2027-01-01」自动迁到「${s.title}」/ ${s.targetISO}`
  );
  ok(cfg().migratedGaokao === true, '迁移标记已落盘（只会迁一次）');

  console.log('\n===== 1b. 迁移只做一次：动过的条目不会在重启后被改回去 =====');
  let s2 = call('entry:update', { id: s.activeId, patch: { title: '我自己起的名字', targetISO: '2030-03-03T08:30:00' } });
  ok(s2.title === '我自己起的名字', `改成「${s2.title}」`);
  // 真·重启：清模块缓存重新 require，让它从磁盘重新读配置
  const MAIN = path.join(__dirname, '..', 'electron', 'main.js');
  delete require.cache[require.resolve(MAIN)];
  require(MAIN);
  await new Promise((r) => setTimeout(r, 80));
  s = call('state:get');
  ok(s.title === '我自己起的名字' && s.targetISO === '2030-03-03T08:30:00', `重启后仍是用户自己设的值（${s.title} / ${s.targetISO}）`);
  // 恢复成后面用例要用的状态
  s = call('entry:update', { id: s.activeId, patch: { title: '元旦', targetISO: '2027-01-01T00:00:00' } });

  console.log('\n===== 2. 编辑当前条目（设置页表单走的就是 entry:update）=====');
  s = call('entry:update', { id: s.activeId, patch: { title: '考研', targetISO: '2027-12-25T00:00:00', note: '加油' } });
  ok(s.title === '考研', `state.title 立刻变为「${s.title}」`);
  ok(s.targetISO === '2027-12-25T00:00:00', `state.targetISO 立刻变为 ${s.targetISO}`);
  ok(s.note === '加油', `state.note = ${s.note}`);
  ok(cfg().entries[0].title === '考研', '已落盘 config.json');
  ok(cfg().activeId === s.activeId, 'activeId 已落盘');
  ok(sent.length > 0 && sent[sent.length - 1].ch === 'state:changed', `已向窗口广播 state:changed（共 ${sent.length} 次）`);
  const lastPayload = sent[sent.length - 1].payload;
  ok(lastPayload.targetISO === '2027-12-25T00:00:00', `广播出去的 payload.targetISO 也是新值 (${lastPayload.targetISO})`);

  console.log('\n===== 3. 走 state:set 改日期（v1.0 的旧路径，兼容性）=====');
  s = call('state:set', { title: '元旦', targetISO: '2028-01-01T00:00:00' });
  ok(s.title === '元旦' && s.targetISO === '2028-01-01T00:00:00', `state:set 也能改到当前条目 (${s.title} / ${s.targetISO})`);
  ok(cfg().entries[0].targetISO === '2028-01-01T00:00:00', 'state:set 已落盘');

  console.log('\n===== 4. 新增条目并切当前 =====');
  s = call('entry:add', { title: '考试', targetISO: '2026-12-20T09:00:00', note: '' });
  ok(s.entries.length === 2, `条目数 = ${s.entries.length}`);
  ok(s.title === '考试', `新增后自动设为当前（title=${s.title}）`);
  ok(s.activeId === s.entries[1].id, 'activeId 指向新条目');
  ok(cfg().entries.length === 2, '两条都已落盘');

  console.log('\n===== 5. 切换当前 / 步进 =====');
  s = call('entry:set-active', s.entries[0].id);
  ok(s.title === '元旦', `set-active 生效（title=${s.title}）`);
  s = call('entry:step', 1);
  ok(s.title === '考试', `step(+1) 生效（title=${s.title}）`);
  s = call('entry:step', 1);
  ok(s.title === '考试', 'step(+1) 到末尾不越界');
  s = call('entry:step', -1);
  ok(s.title === '元旦', `step(-1) 生效（title=${s.title}）`);

  console.log('\n===== 6. 编辑「非当前」条目，不应改变当前 =====');
  const other = s.entries.find((e) => e.id !== s.activeId);
  s = call('entry:update', { id: other.id, patch: { note: '改的是另一条' } });
  ok(s.activeId === s.entries.find((e) => e.title === '元旦').id, '当前条目没被带跑');
  ok(s.entries.find((e) => e.id === other.id).note === '改的是另一条', '另一条确实改了');
  ok(s.note !== '改的是另一条', `当前条目的备注没被串改（${s.note}）`);

  console.log('\n===== 7. 删除 =====');
  s = call('entry:remove', other.id);
  ok(s.ok === true && s.state.entries.length === 1, `删除成功，剩 ${s.state.entries.length} 条`);
  s = call('entry:remove', s.state.activeId);
  ok(s.ok === false && s.reason === 'last-entry', '最后一条拒绝删除');

  console.log('\n===== 8. 重启后是否还记得（重新读盘）=====');
  const finalCfg = cfg();
  ok(finalCfg.entries.length === 1 && finalCfg.entries[0].title === '元旦', `落盘条目：${JSON.stringify(finalCfg.entries.map((e) => e.title))}`);
  ok('note' in finalCfg.entries[0], `备注字段存在（${JSON.stringify(finalCfg.entries[0].note)}）`);
  ok(typeof finalCfg.locked === 'boolean', `locked 字段已落盘（${finalCfg.locked}）`);


  /* ================================================================ */
  /* 9~15：固定 / 解锁 / 再固定（图钉按钮背后的桌面层真机链路）           */
  /*   —— 这一段就是用来防「图钉是假的」「解锁了拖不动」「再固定跑回老位置」 */
  /* ================================================================ */
  const W = () => windows[windows.length - 1];
  const widgetParent = () => world.parent.get(HWND.widget) || 0;
  const resetWorld = () => {
    world.calls.setParent.length = 0;
    world.calls.setWindowPos.length = 0;
    world.hit = 'auto';
  };
  // 只看「带坐标」的 SetWindowPos：钉层时用它把窗口原地钉住
  const pinnedAt = () => {
    const list = world.calls.setWindowPos.filter((c) => c.hwnd === HWND.widget && !(c.flags & 0x0002));
    return list.length ? list[list.length - 1] : null;
  };

  const w = W();

  console.log('\n===== 9. 未固定：普通顶层窗口，可拖到任意地方 =====');
  let st9 = call('state:get');
  ok(st9.locked === false, '初始状态：未固定');
  ok(widgetParent() === 0, '没有挂在桌面层（是顶层窗口，坐标就是屏幕坐标）');
  ok(w.movable === true, 'setMovable(true)');
  ok(st9.desktopLayerPref === 'auto', `偏好 = ${st9.desktopLayerPref}`);

  resetWorld();
  const p0 = w.getPosition();
  cursor.x = p0[0] + 50;
  cursor.y = p0[1] + 40;
  call('on:drag:start');
  cursor.x = p0[0] - 150; // 往左上拖 −200
  cursor.y = p0[1] - 60; // 往左上拖 −100
  call('on:drag:move');
  call('on:drag:end');
  const p1 = w.getPosition();
  ok(p1[0] === p0[0] - 200 && p1[1] === p0[1] - 100, `拖动跟随鼠标：${p0.join(',')} → ${p1.join(',')}`);
  await new Promise((r) => setTimeout(r, 500));
  ok(cfg().x === p1[0] && cfg().y === p1[1], `新位置已落盘 (${cfg().x},${cfg().y})`);

  console.log('\n===== 10. 点「固定」：真的钉进桌面层 + 位置锁死 =====');
  call('state:set', { layerProbe: false }); // 关自检，强制走壁纸层（自检回退在 13 单独测）
  resetWorld();
  const before10 = w.getPosition();
  let st10 = call('state:set', { locked: true });
  ok(
    world.calls.setParent.some((c) => c.child === HWND.widget && c.parent === HWND.wallpaper),
    'SetParent(widget → 壁纸层 WorkerW)：是真钉，不是只改 UI'
  );
  ok(widgetParent() === HWND.wallpaper, `窗口父句柄 = 0x${widgetParent().toString(16)}`);
  ok(st10.desktopLayer === 'workerw' && st10.locked === true, `层级 ${st10.desktopLayer} / locked ${st10.locked}`);
  ok(w.movable === false, 'setMovable(false)：OS 侧也不给拖');
  const pin10 = pinnedAt();
  ok(
    pin10 && pin10.x === before10[0] && pin10.y === before10[1],
    `钉住时用当前屏幕坐标原地复核（${pin10 ? pin10.x + ',' + pin10.y : '—'}）`
  );

  const keep = w.getPosition();
  cursor.x += 400;
  cursor.y += 400;
  call('on:drag:start');
  call('on:drag:move');
  call('on:drag:end');
  ok(
    w.getPosition()[0] === keep[0] && w.getPosition()[1] === keep[1],
    '固定状态下拖动被主进程拦下（位置一动不动）'
  );

  console.log('\n===== 11. 点「解锁」：脱离桌面层，能拖到任意地方 =====');
  resetWorld();
  let st11 = call('state:set', { locked: false });
  ok(
    world.calls.setParent.some((c) => c.child === HWND.widget && c.parent === 0),
    'SetParent(widget → NULL)：解除钉层'
  );
  ok(widgetParent() === 0, '回到普通顶层窗口');
  ok(w.movable === true, 'setMovable(true)');
  ok(st11.locked === false, 'locked 已落盘为 false');

  const p2 = w.getPosition();
  cursor.x = p2[0] + 30;
  cursor.y = p2[1] + 20;
  call('on:drag:start');
  cursor.x = p2[0] + 30 - 900; // 拖到左上角（任意方向）
  cursor.y = p2[1] + 20 - 600;
  call('on:drag:move');
  call('on:drag:end');
  const p3 = w.getPosition();
  ok(p3[0] === p2[0] - 900 && p3[1] === p2[1] - 600, `拖到 ${p3.join(',')}（向左上也跟随）`);
  await new Promise((r) => setTimeout(r, 500));
  ok(cfg().x === p3[0] && cfg().y === p3[1], `解锁后的新位置已落盘 (${cfg().x},${cfg().y})`);

  console.log('\n===== 12. 再点「固定」：锁在拖动后的新位置 =====');
  resetWorld();
  let st12 = call('state:set', { locked: true });
  ok(widgetParent() === HWND.wallpaper, '重新钉回壁纸层');
  const pin12 = pinnedAt();
  ok(
    pin12 && pin12.x === p3[0] && pin12.y === p3[1],
    `钉的是新位置（${pin12 ? pin12.x + ',' + pin12.y : '—'}），不是解锁前的老位置`
  );
  ok(st12.locked === true && st12.desktopLayer === 'workerw', `locked ${st12.locked} / layer ${st12.desktopLayer}`);

  console.log('\n===== 13. 点击自检：壁纸层点不到时自动退到「必定可点击」的兼容层 =====');
  call('state:set', { locked: false });
  call('state:set', { layerProbe: true });
  resetWorld();
  let st13 = call('state:set', { locked: true });
  ok(
    st13.desktopLayer === 'sink',
    `workerw / progman 的自检都不通过 → 落到 ${st13.desktopLayer}（不会卡在点不动的死状态）`
  );
  ok(widgetParent() === 0, '没有被挂在壁纸层');
  ok(
    world.calls.setWindowPos.some((c) => c.hwnd === HWND.widget && c.after === HWND.icon && c.flags & 0x0002),
    '压在桌面图标层之上（sink），其它窗口仍然盖得住它'
  );

  console.log('\n===== 13b. 被普通窗口挡住 ≠ 自检不通过（别把好方案误判掉）=====');
  call('state:set', { locked: false });
  resetWorld();
  world.hit = 0x999; // 一个普通应用窗口（不属于桌面层一家人）
  let st13b = call('state:set', { locked: true });
  ok(st13b.desktopLayer === 'workerw', `仍按壁纸层钉住（probe=${st13b.desktopLayerProbe}）`);
  ok(widgetParent() === HWND.wallpaper, '窗口确实挂在壁纸层');
  world.hit = 'auto';

  console.log('\n===== 14. 显式选「兼容模式」：直接用 sink，并保持锁定 =====');
  resetWorld();
  let st14 = call('state:set', { desktopLayer: 'bottom' });
  ok(st14.desktopLayerPref === 'bottom', `偏好已落盘 = ${st14.desktopLayerPref}`);
  ok(st14.desktopLayer === 'sink', `生效层级 = ${st14.desktopLayer}`);
  ok(w.movable === false, '兼容模式下依然是「已固定」：拖不动');
  ok(cfg().locked === true, 'locked=true 已落盘');

  console.log('\n===== 16. 开机自启：写进去必须读得回来 =====');
  let aut = call('login-item:set', true);
  ok(aut.openAtLogin === true, `开启自启后立刻读回 = ${aut.openAtLogin}（旧实现恒为 false → 开关自己弹回去）`);
  ok(
    !!registry.command && registry.command.includes('--autostart'),
    `注册表启动项已写入：${registry.command}`
  );
  ok(cfg().openAtLogin === true, '配置里也记成「要自启」（以用户意愿为准，不再被读回值抹掉）');
  aut = call('login-item:set', false);
  ok(aut.openAtLogin === false, '关闭后读回 false');
  ok(registry.command === null, '注册表项已清除');
  aut = call('login-item:set', true);
  ok(call('state:get').loginItem === true, 'state.loginItem = true（设置页勾选框据此渲染，不会弹回）');

  console.log('\n===== 17. 隐藏组件之后必须找得回来 =====');
  const vis = W();
  let hid = call('ui:hide');
  ok(hid.visible === false && vis.isVisible() === false, '组件已隐藏');
  ok(cfg().visible === false, '隐藏状态已落盘');
  ok(
    balloons.length === 1 && /Ctrl\+Alt\+G|托盘/.test(balloons[0].content || ''),
    `第一次隐藏弹一次托盘气泡，告诉用户怎么恢复：「${(balloons[0] || {}).content || '—'}」`
  );
  call('ui:hide');
  ok(balloons.length === 1, '第二次隐藏不再打扰（只提示一次）');
  const back = call('ui:show');
  ok(back.visible === true && vis.isVisible() === true, 'ui:show 能把组件显示回来');
  ok(cfg().visible === true, '显示状态已落盘');
  ok(
    hotkeys.some((h) => h.key === 'Control+Alt+G'),
    `注册了兜底快捷键 ${hotkeys.map((h) => h.key).join(' / ')}（托盘图标万一看不见也能叫回来）`
  );

  console.log('\n===== 18. 托盘图标不能是空的 =====');
  ok(!!trayImg, '托盘图标对象已创建');
  ok(
    trayImg && trayImg.__fallback === true,
    'assets 里图标读不到时会用内置兜底图（旧实现返回空图 → 通知区域什么都看不到）'
  );

  console.log('\n===== 19. 组件大小：窗口尺寸 + 中心锚点 =====');
  const ws = W();
  let sc = call('size:set', 1);
  ok(sc.uiScale === 1 && cfg().uiScale === 1, `100% 档已落盘（窗口 ${ws.getSize().join('x')}）`);
  const c0x = ws.getPosition()[0] + ws.getSize()[0] / 2;
  const c0y = ws.getPosition()[1] + ws.getSize()[1] / 2;
  sc = call('size:set', 0.5);
  const [ax, ay] = ws.getPosition();
  const [aw, ah] = ws.getSize();
  ok(aw === 250 && ah === 180, `50% 档窗口 = ${aw}x${ah}（卡片 210x140 + 40 投影留白）`);
  ok(
    Math.abs(ax + aw / 2 - c0x) <= 1 && Math.abs(ay + ah / 2 - c0y) <= 1,
    `中心锚点：卡片中心漂移 ≤1px（${c0x},${c0y} → ${ax + aw / 2},${ay + ah / 2}）`
  );
  ok(sc.uiScale === 0.5 && cfg().uiScale === 0.5, '50% 已落盘（出厂默认）');
  call('size:set', 0.8);
  ok(ws.getSize().join('x') === '376x264', `80% 档窗口 = ${ws.getSize().join('x')}`);
  call('size:set', 0.65);
  ok(ws.getSize().join('x') === '313x222', `65% 档窗口 = ${ws.getSize().join('x')}`);
  sc = call('size:set', 0.73);
  ok(sc.uiScale === 0.5, '非法档位（0.73）回落到默认 50%');
  sc = call('size:set', 0.5);
  ok(sc.uiScale === 0.5, '回到 50%');

  console.log('\n===== 15. 收尾：解锁并恢复默认偏好 =====');
  const st15 = call('state:set', { locked: false, desktopLayer: 'auto' });
  ok(st15.locked === false && st15.desktopLayerPref === 'auto', '回到未固定 / auto');
  ok(cfg().locked === false, 'config.json 落盘同步');


  console.log(`\n===== 测试结束：${fails === 0 ? '全部通过 ✅' : fails + ' 处失败 ❌'} =====`);
  console.log('（配置目录 ' + USER_DATA + '）');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(2);
});
