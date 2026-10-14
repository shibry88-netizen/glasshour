'use strict';
/**
 * GlassHour · 设置页渲染层测试（jsdom，不需要 electron / 显示器）
 *
 * 做法：jsdom 加载真实 settings.html，注入一个会记录调用的假 window.gh，
 * 然后**模拟用户真实操作**：点 ✎ 打开编辑表单 → 改日期/名称/备注 → 点「保存」，
 * 断言它到底把什么参数发给了主进程、以及界面有没有跟着更新。
 *
 * 用法： NODE_PATH=/tmp/jst/node_modules node test/settings_ui.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let fails = 0;
const ok = (cond, msg, extra) => {
  if (!cond) fails++;
  console.log(`   ${cond ? '✅' : '❌'} ${msg}${extra ? '  ' + extra : ''}`);
};

/* ---------- 假 state / 假 gh（契约与 electron/preload.js 一致）---------- */
function makeState() {
  return {
    mode: 'date',
    entries: [{ id: 'e1', title: '元旦', targetISO: '2027-01-01T00:00:00', note: '' }],
    activeId: 'e1',
    targetISO: '2027-01-01T00:00:00',
    title: '元旦',
    note: '',
    durationSec: 1500,
    opacity: 1,
    visible: true,
    desktopLayer: 'sink', // 当前真实生效的层级
    desktopLayerLabel: '桌面之上 · 普通窗口之下（兼容模式，可点击）',
    desktopLayerPref: 'auto', // 用户偏好（下拉框绑这个）
    desktopLayerProbe: 'ok',
    layerProbeEnabled: true,
    locked: false,
    version: '1.1.0',
    loginItem: false,
    userData: '/tmp/fake',
    now: Date.now(),
  };
}

function buildDom(state) {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'settings.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'settings.js'), 'utf8');

  const stub = `
    window.__CALLS__ = [];
    window.__STATE__ = ${JSON.stringify(state)};
    window.gh = {
      getState: async () => window.__STATE__,
      setState: async (p) => { window.__CALLS__.push({ fn: 'setState', args: [p] }); Object.assign(window.__STATE__, p); return window.__STATE__; },
      setMode: async (m) => { window.__CALLS__.push({ fn: 'setMode', args: [m] }); window.__STATE__.mode = m; return window.__STATE__; },
      setLoginItem: async (v) => ({ openAtLogin: !!v, userData: '/tmp/fake' }),
      addEntry: async (p) => { window.__CALLS__.push({ fn: 'addEntry', args: [p] });
        const e = Object.assign({ id: 'new1', note: '' }, p);
        window.__STATE__.entries.push(e); window.__STATE__.activeId = e.id;
        Object.assign(window.__STATE__, { title: e.title, targetISO: e.targetISO, note: e.note });
        return window.__STATE__; },
      updateEntry: async (id, p) => { window.__CALLS__.push({ fn: 'updateEntry', args: [id, p] });
        const i = window.__STATE__.entries.findIndex((e) => e.id === id);
        if (i < 0) return window.__STATE__;
        Object.assign(window.__STATE__.entries[i], p);
        if (window.__STATE__.activeId === id) Object.assign(window.__STATE__, p);
        return window.__STATE__; },
      removeEntry: async (id) => { window.__CALLS__.push({ fn: 'removeEntry', args: [id] });
        window.__STATE__.entries = window.__STATE__.entries.filter((e) => e.id !== id);
        return { ok: true, state: window.__STATE__ }; },
      setActiveEntry: async (id) => { window.__CALLS__.push({ fn: 'setActiveEntry', args: [id] });
        window.__STATE__.activeId = id;
        const e = window.__STATE__.entries.find((x) => x.id === id);
        if (e) Object.assign(window.__STATE__, { title: e.title, targetISO: e.targetISO, note: e.note });
        return window.__STATE__; },
      stepEntry: async () => window.__STATE__,
      onState: () => () => {},
      openSettings: () => {}, hide: () => {}, resetPosition: async () => {},
      quit: () => {}, openPath: async () => {}, dragStart: () => {}, dragMove: () => {}, dragEnd: () => {},
      platform: 'win32',
    };
  `;

  const patched = html.replace('<script src="settings.js"></script>', `<script>${stub}</script><script>${js}</script>`);
  const dom = new JSDOM(patched, { runScripts: 'dangerously', pretendToBeVisual: true });
  return dom;
}

const click = (el) => {
  const ev = el.ownerDocument.defaultView.MouseEvent;
  el.dispatchEvent(new ev('click', { bubbles: true, cancelable: true }));
};
const tick = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  const state = makeState();
  const dom = buildDom(state);
  const w = dom.window;
  const d = w.document;
  await tick();
  await tick();

  const $ = (sel) => d.querySelector(sel);
  const calls = () => w.__CALLS__;

  console.log('\n===== 1. 初始渲染（模拟用户的现状：只有「元旦 / 2027-01-01」一条）=====');
  const items = d.querySelectorAll('.eitem');
  ok(items.length === 1, `列表渲染出 ${items.length} 条`);
  ok(items[0] && items[0].querySelector('.eitem__name').textContent.includes('元旦'), '名称显示「元旦」', items[0] && items[0].querySelector('.eitem__name').textContent);
  ok(/2027-01-01/.test(items[0].querySelector('.eitem__meta').textContent), '截止时间显示 2027-01-01', items[0].querySelector('.eitem__meta').textContent);
  // v1.2：只有一条时表单自动摊开，日期字段一眼可见（用户打开设置多半就是要改这条的日期）
  ok(!d.getElementById('entryForm').classList.contains('is-hidden'), '单条时编辑表单自动展开');
  ok(d.getElementById('fDate').value === '2027-01-01', `日期字段一眼可见且已回填（${d.getElementById('fDate').value}）`);

  console.log('\n===== 2. 点 ✎ 打开编辑表单 =====');
  const editBtn = items[0].querySelector('[data-act="edit"]');
  ok(!!editBtn, '列表项里有编辑按钮');
  click(editBtn);
  await tick();
  ok(!d.getElementById('entryForm').classList.contains('is-hidden'), '表单已展开');
  ok(d.getElementById('fTitle').value === '元旦', `名称已回填（${d.getElementById('fTitle').value}）`);
  ok(d.getElementById('fDate').value === '2027-01-01', `日期已回填（${d.getElementById('fDate').value}）`);
  ok(d.getElementById('fTime').value === '00:00', `时间已回填（${d.getElementById('fTime').value}）`);

  console.log('\n===== 3. 改成自定义日期 + 备注，点「保存」=====');
  d.getElementById('fTitle').value = '2027年高考';
  d.getElementById('fDate').value = '2027-06-07';
  d.getElementById('fTime').value = '00:00';
  d.getElementById('fNote').value = '加油';
  calls().length = 0;
  click(d.getElementById('fSave'));
  await tick();
  await tick();

  const upd = calls().find((c) => c.fn === 'updateEntry');
  const act = calls().find((c) => c.fn === 'setActiveEntry');
  ok(!!upd, '确实调用了 updateEntry');
  if (upd) {
    ok(upd.args[0] === 'e1', `传的 id = ${upd.args[0]}`);
    ok(upd.args[1].title === '2027年高考', `传的 title = ${upd.args[1].title}`);
    ok(upd.args[1].targetISO === '2027-06-07T00:00:00', `传的 targetISO = ${upd.args[1].targetISO}`);
    ok(upd.args[1].note === '加油', `传的 note = ${upd.args[1].note}`);
  }
  ok(!!act, '调用了 setActiveEntry 把它设为当前');
  ok(d.getElementById('entryForm').classList.contains('is-hidden'), '保存后表单收起');

  console.log('\n===== 4. 界面是否跟着更新 =====');
  const items2 = d.querySelectorAll('.eitem');
  ok(items2[0].querySelector('.eitem__name').textContent.includes('2027年高考'), '列表名称已刷新', items2[0].querySelector('.eitem__name').textContent);
  ok(/2027-06-07/.test(items2[0].querySelector('.eitem__meta').textContent), '列表截止时间已刷新', items2[0].querySelector('.eitem__meta').textContent);

  console.log('\n===== 5. 走「＋ 新增倒计时」这条路 =====');
  click(d.getElementById('addEntry'));
  await tick();
  ok(!d.getElementById('entryForm').classList.contains('is-hidden'), '新增表单展开');
  ok(d.getElementById('fTitle').value === '', '新增时名称为空');
  d.getElementById('fTitle').value = '考试';
  d.getElementById('fDate').value = '2026-12-20';
  d.getElementById('fTime').value = '09:00';
  calls().length = 0;
  click(d.getElementById('fSave'));
  await tick();
  await tick();
  const add = calls().find((c) => c.fn === 'addEntry');
  ok(!!add, '确实调用了 addEntry');
  if (add) ok(add.args[0].targetISO === '2026-12-20T09:00:00', `传的 targetISO = ${add.args[0].targetISO}`);
  ok(d.querySelectorAll('.eitem').length === 2, `列表变成 ${d.querySelectorAll('.eitem').length} 条`);

  console.log('\n===== 6. 日期空着就点保存，会怎样 =====');
  click(d.getElementById('addEntry'));
  await tick();
  d.getElementById('fTitle').value = '空日期';
  d.getElementById('fDate').value = '';
  d.getElementById('fTime').value = '';
  calls().length = 0;
  click(d.getElementById('fSave'));
  await tick();
  await tick();
  ok(!calls().some((c) => c.fn === 'addEntry'), '没日期时不会乱建条目');
  ok(d.getElementById('status').textContent.includes('日期'), `有提示文案：「${d.getElementById('status').textContent}」`);
  ok(!d.getElementById('entryForm').classList.contains('is-hidden'), '表单保持展开（数据没丢）');


  console.log('\n===== 7. 桌面层下拉框显示的是「偏好」，不是「当前生效层级」=====');
  ok(
    d.getElementById('layer').value === 'auto',
    `偏好 auto 时显示 auto（旧实现会串成生效层级，导致「自动」永远选不上）→ ${d.getElementById('layer').value}`
  );
  ok(
    /兼容模式/.test(d.getElementById('layerInfo').textContent),
    `关于栏显示真实生效层级：${d.getElementById('layerInfo').textContent}`
  );
  ok(/点击自检通过/.test(d.getElementById('layerInfo').textContent), '并显示点击自检结论');
  calls().length = 0;
  d.getElementById('layer').value = 'bottom';
  d.getElementById('layer').dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  await tick();
  const layerCall = calls().find((c) => c.fn === 'setState' && c.args[0].desktopLayer);
  ok(!!layerCall && layerCall.args[0].desktopLayer === 'bottom', '切换桌面层会发 setState({desktopLayer})');

  console.log('\n===== 8. 「固定状态」勾选框 = 组件上那颗图钉 =====');
  ok(d.getElementById('locked').checked === false, '未固定时复选框是空的');
  calls().length = 0;
  d.getElementById('locked').checked = true;
  d.getElementById('locked').dispatchEvent(new w.Event('change', { bubbles: true }));
  await tick();
  await tick();
  const lockCall = calls().find((c) => c.fn === 'setState' && 'locked' in c.args[0]);
  ok(!!lockCall && lockCall.args[0].locked === true, '勾上就发 setState({locked:true}) → 主进程去钉桌面层');
  ok(/已固定/.test(d.getElementById('lockedHint').textContent), `提示文案跟着变：${d.getElementById('lockedHint').textContent}`);


  console.log(`\n===== 测试结束：${fails === 0 ? '全部通过 ✅' : fails + ' 处失败 ❌'} =====`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(2);
});
