'use strict';
/**
 * GlassHour · 主进程逻辑集成测试（不依赖 electron 运行时、不需要 Xvfb）
 *
 * 做法：伪造 electron 模块 → require 真实 main.js → 直接调用它注册的 ipcMain handler，
 * 断言 publicState() 与落盘 config.json 的内容。用来抓「改了日期但存不下来」这类问题。
 *
 * 用法： node test/main_logic.test.js
 */
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
const handlers = new Map();
const sent = [];
const windows = [];
const menus = [];

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
    windows.push(this);
  }
  loadFile() {}
  loadURL() {}
  once() {}
  on() {}
  showInactive() { this._shown = true; }
  hide() {}
  show() {}
  focus() {}
  isDestroyed() { return this._destroyed; }
  getPosition() { return [0, 0]; }
  setPosition() {}
  getSize() { return [460, 320]; }
  setAlwaysOnTop() {}
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
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setAppUserModelId: () => {},
  },
  BrowserWindow: FakeBrowserWindow,
  Tray: class {
    setContextMenu(m) { menus.push(m); }
    setToolTip() {}
    on() {}
  },
  Menu: { buildFromTemplate: (t) => t },
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set('on:' + ch, fn),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createEmpty: () => ({}),
  },
  dialog: { showMessageBox: () => {} },
  shell: { openPath: () => {} },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  if (request === 'koffi') return { load: () => ({ func: () => () => 0 }) };
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

  console.log(`\n===== 测试结束：${fails === 0 ? '全部通过 ✅' : fails + ' 处失败 ❌'} =====`);
  console.log('（配置目录 ' + USER_DATA + '）');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(2);
});
