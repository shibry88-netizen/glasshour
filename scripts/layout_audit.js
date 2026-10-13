'use strict';
/**
 * GlassHour · 版面几何审计
 * 不靠肉眼/视觉模型，直接在 Chromium 里量每个元素的几何盒，做硬断言：
 *   1. 元素是否越出卡片边界
 *   2. 内容元素之间是否重叠
 *   3. 备注为空时是否真的不渲染；只有 1 条时切换控件是否真的不渲染
 *   4. 切换控件的计数器读数、首尾箭头禁用态
 *   5. 关键字号 / 颜色是否与设计规范一致
 *
 * 用法： node scripts/layout_audit.js
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE = 'file://' + path.join(ROOT, 'renderer', 'index.html');
const WALL = path.join(ROOT, 'design', 'mock', 'wallpaper.png');
const VIEW = { width: 460, height: 320 };
const CARD = { w: 420, h: 280 }; // 卡片逻辑尺寸

const DAY = 86400 * 1000;
const iso = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const E1 = { id: 'e1', title: '元旦', targetISO: iso(Date.now() + 78 * DAY), note: '新的一年，把想做的事都做掉' };
const E2 = { id: 'e2', title: '考试', targetISO: iso(Date.now() + 3 * DAY), note: '还有三天，错题再过一遍' };
const E3 = { id: 'e3', title: '发工资', targetISO: iso(Date.now() + 19 * DAY), note: '' };
const E12 = Array.from({ length: 12 }, (_, i) => ({
  id: 'x' + (i + 1),
  title: '第' + (i + 1) + '条',
  targetISO: iso(Date.now() + (i + 1) * DAY),
  note: '',
}));

const base = {
  mode: 'date',
  title: '元旦',
  targetISO: E1.targetISO,
  note: '',
  entries: [E1],
  activeId: 'e1',
  durationSec: 25 * 60,
  timerRunning: false,
  timerEndsAt: 0,
  timerRemaining: 25 * 60,
  opacity: 1,
};

const CASES = [
  { name: '单条 · 无备注', state: { ...base } },
  { name: '单条 · 有备注', state: { ...base, ...E1, entries: [E1], activeId: 'e1' } },
  { name: '3 条 · 中间条', state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2' } },
  { name: '3 条 · 首条', state: { ...base, ...E1, entries: [E1, E2, E3], activeId: 'e1' } },
  { name: '3 条 · 末条无备注', state: { ...base, ...E3, entries: [E1, E2, E3], activeId: 'e3' } },
  { name: '12 条 · 计数器宽度', state: { ...base, ...E12[11], entries: E12, activeId: 'x12' } },
  { name: '紧迫态 + 备注', state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2' } },
  { name: '计时模式', state: { ...base, mode: 'timer', ...E1, entries: [E1, E2, E3], activeId: 'e1' } },
  { name: '已固定（位置锁定）', state: { ...base, ...E1, entries: [E1], activeId: 'e1', locked: true } },
  { name: '已固定 + 三条', state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2', locked: true } },
];

// 期望值（来自《UI 设计规范 v1.0 / 增量 v1.1》）
const EXPECT = {
  'caption': { fontSize: '13px' },
  'sub': { fontSize: '15px' },
  'note': { fontSize: '12px', color: 'rgba(236, 232, 224, 0.55)' },
  'unit': { fontSize: '20px' },
};

const CONTENT = [
  'caption', 'big', 'unit', 'sub', 'note', 'settings', 'lock', 'mode-btn',
  'entry-nav', 'entry-cur', 'entry-total', 'entry-prev', 'entry-next',
  'timer-toggle', 'timer-reset',
];

// 纯文本元素：按「字体墨迹」而不是「行框」比，否则行高留白会造出假重叠
// （例：标签行框高 18px、字号 13px；主数字行框从下一行起，两者行框相邻但墨迹不碰）
const TEXTUAL = new Set(['caption', 'big', 'unit', 'sub', 'note', 'entry-cur', 'entry-total']);

function inkBox(e) {
  const fs = parseFloat(e.fontSize) || 0;
  if (!TEXTUAL.has(e.name) || !fs) {
    return { left: e.left, top: e.top, right: e.right, bottom: e.bottom };
  }
  const lead = Math.max(0, (e.h - fs) / 2); // 行框内的半行距
  return {
    left: e.left,
    // 数字/汉字的字面大约从基线往上 0.7em，基线在 0.8em 处
    top: e.top + lead + fs * 0.1,
    right: e.right,
    bottom: e.top + lead + fs * 0.8,
  };
}

function overlaps(a, b) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}
function contains(outer, inner) {
  return (
    outer.left <= inner.left + 0.5 &&
    outer.top <= inner.top + 0.5 &&
    outer.right >= inner.right - 0.5 &&
    outer.bottom >= inner.bottom - 0.5
  );
}

(async () => {
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const wallCss = fs.existsSync(WALL)
    ? `html,body{background:#0a0a0c url("file://${WALL}") no-repeat !important;background-size:1920px 1080px !important;background-position:-1440px -740px !important}`
    : '';

  let problems = 0;
  const say = (ok, msg) => {
    if (!ok) problems++;
    console.log(`   ${ok ? '✅' : '❌'} ${msg}`);
  };

  for (const c of CASES) {
    console.log(`\n===== ${c.name} =====`);
    await page.addInitScript((s) => {
      window.__GH_MOCK__ = s;
    }, Object.assign({ now: Date.now() }, c.state));
    await page.goto(PAGE, { waitUntil: 'load' });
    if (wallCss) await page.addStyleTag({ content: wallCss });
    await page.waitForTimeout(420);

    const data = await page.evaluate((names) => {
      const cardEl = document.querySelector('[data-gh="card"]');
      const cr = cardEl.getBoundingClientRect();
      const out = { card: { w: cr.width, h: cr.height }, els: [] };
      const seen = [];
      document.querySelectorAll('[data-gh]').forEach((el) => {
        const tag = el.getAttribute('data-gh');
        if (!names.includes(tag) && tag !== 'card') return;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        out.els.push({
          name: tag,
          role: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
          visible,
          disabled: !!el.disabled,
          // 转成「卡片内相对坐标」
          left: +(r.left - cr.left).toFixed(1),
          top: +(r.top - cr.top).toFixed(1),
          right: +(r.right - cr.left).toFixed(1),
          bottom: +(r.bottom - cr.top).toFixed(1),
          w: +r.width.toFixed(1),
          h: +r.height.toFixed(1),
          text: (el.textContent || '').trim(),
          fontSize: cs.fontSize,
          color: cs.color,
          ellipsis: cs.textOverflow === 'ellipsis',
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        });
      });
      return out;
    }, CONTENT);

    const byName = {};
    data.els.forEach((e) => {
      (byName[e.name] = byName[e.name] || []).push(e);
    });

    // 1) 越界检查
    data.els.forEach((e) => {
      if (!e.visible) return;
      const inX = e.left >= -0.5 && e.right <= CARD.w + 0.5;
      const inY = e.top >= -0.5 && e.bottom <= CARD.h + 0.5;
      say(inX && inY, `${e.name} 在卡片内  [${e.left},${e.top} → ${e.right},${e.bottom}]`);
    });

    // 2) 重叠检查（跳过包含关系）
    const vis = data.els.filter((e) => e.visible);
    let overlapHit = 0;
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const a = vis[i], b = vis[j];
        if (a.name === b.name && a.role === b.role) continue;
        if (contains(a, b) || contains(b, a)) continue; // 父子关系不算重叠
        // 只在同一「层」里比：内容文字元素之间、控件元素之间
        const aT = TEXTUAL.has(a.name), bT = TEXTUAL.has(b.name);
        if (aT !== bT) continue;
        const ia = inkBox(a), ib = inkBox(b);
        if (overlaps(ia, ib)) {
          overlapHit++;
          say(false, `重叠！${a.name}[${ia.top.toFixed(1)}-${ia.bottom.toFixed(1)}] ∩ ${b.name}[${ib.top.toFixed(1)}-${ib.bottom.toFixed(1)}]`);
        }
      }
    }
    if (!overlapHit) console.log('   ✅ 墨迹无重叠');

    // 3) 备注显隐
    const note = (byName['note'] || [])[0];
    const noteText = (c.state.note || '').trim();
    const noteVisible = note && note.visible && c.state.mode === 'date';
    if (noteText && c.state.mode === 'date') {
      say(noteVisible, `备注有内容 → 应渲染（当前 ${noteVisible ? '渲染' : '未渲染'}）`);
      if (noteVisible) {
        say(note.text.startsWith(noteText.slice(0, 6)), `备注文本正确：「${note.text}」`);
        const clipped = note.scrollW > note.clientW + 1;
        say(
          !clipped || note.ellipsis,
          clipped ? `备注超宽已按 ellipsis 截断（scrollW ${note.scrollW} > clientW ${note.clientW}）` : `备注未截断，完整显示`
        );
      }
    } else if (c.state.mode === 'date') {
      say(!noteVisible, `备注为空 → 不渲染（当前 ${noteVisible ? '❌ 仍渲染' : '正确隐藏'}）`);
    } else {
      say(!noteVisible, `计时模式 → 备注不显示（当前 ${noteVisible ? '❌ 仍显示' : '正确隐藏'}）`);
    }

    // 4) 切换控件显隐 + 计数器
    const nav = (byName['entry-nav'] || [])[0];
    const n = (c.state.entries || []).length;
    if (n > 1) {
      say(nav && nav.visible, `条目数 ${n} > 1 → 切换控件应渲染`);
      if (nav && nav.visible) {
        const cur = (byName['entry-cur'] || [])[0];
        const tot = (byName['entry-total'] || [])[0];
        const idx = (c.state.entries || []).findIndex((e) => e.id === c.state.activeId);
        say(cur && cur.text === String(idx + 1), `当前序号 = ${cur && cur.text}（应 ${idx + 1}）`);
        say(tot && tot.text === String(n), `总数 = ${tot && tot.text}（应 ${n}）`);
        const prev = (byName['entry-prev'] || [])[0];
        const next = (byName['entry-next'] || [])[0];
        say(!!prev && prev.disabled === (idx === 0), `‹ 禁用态 = ${prev && prev.disabled}（应 ${idx === 0}）`);
        say(!!next && next.disabled === (idx === n - 1), `› 禁用态 = ${next && next.disabled}（应 ${idx === n - 1}）`);
        say(nav.left >= 124 && nav.right <= 364, `切换控件不侵入胶囊(≤124)与齿轮(≥364)：[${nav.left}, ${nav.right}]`);
        console.log(`   ℹ️ 切换控件宽 ${nav.w}px（规范最小 96px，≥10 条可加宽）`);
      }
    } else {
      say(!nav || !nav.visible, `条目数 ${n} = 1 → 切换控件必须不渲染（当前 ${nav && nav.visible ? '❌ 仍渲染' : '正确隐藏'}）`);
    }

    // 4.5) 顶部三件套横向不打架
    const seg = (byName['mode-btn'] || [])[0];
    const gear = (byName['settings'] || [])[0];
    const lockBtn = (byName['lock'] || [])[0];
    if (seg && lockBtn && nav && nav.visible) {
      say(seg.right <= nav.left + 0.5, `模式胶囊右缘 ${seg.right} ≤ 切换控件左缘 ${nav.left}`);
      say(nav.right <= lockBtn.left + 0.5, `切换控件右缘 ${nav.right} ≤ 图钉左缘 ${lockBtn.left}`);
    }
    if (lockBtn && gear) {
      say(lockBtn.right <= gear.left + 0.5, `图钉右缘 ${lockBtn.right} ≤ 齿轮左缘 ${gear.left}`);
    }

    // 4.7) 锁定态
    const cardEl = data.els.find((e) => e.name === 'card');
    const pin = (byName['lock'] || [])[0];
    if (pin) {
      if (c.state.locked) {
        say(pin.disabled === false, '已固定时图钉仍可点（否则解不开）');
      }
      say(pin.left >= 300 && pin.right <= 400, `图钉在右上工具区 [${pin.left}, ${pin.right}]`);
    }
    if (cardEl) {
      say(true, `卡片光标 = ${(await page.evaluate(() => getComputedStyle(document.querySelector('[data-gh=\"card\"]')).cursor))}`);
    }

    // 5) 字号 / 颜色
    Object.keys(EXPECT).forEach((k) => {
      const e = (byName[k] || [])[0];
      if (!e || !e.visible) return;
      const exp = EXPECT[k];
      if (exp.fontSize) say(e.fontSize === exp.fontSize, `${k} 字号 = ${e.fontSize}（规范 ${exp.fontSize}）`);
      if (exp.color) say(e.color === exp.color, `${k} 颜色 = ${e.color}（规范 ${exp.color}）`);
    });

    // 6) 主数字排版链路
    const big = (byName['big'] || [])[0];
    if (big) console.log(`   ℹ️ 主数字 ${big.text} · ${big.fontSize} · [${big.left},${big.top} → ${big.right},${big.bottom}]`);
    (byName['caption'] || []).forEach((x) => console.log(`   ℹ️ 标签「${x.text}」· ${x.fontSize} · [${x.left},${x.top}]`));
  }

  await browser.close();
  console.log(`\n===== 审计完成：${problems === 0 ? '全部通过 ✅' : problems + ' 处问题 ❌'} =====`);
  process.exit(problems === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
