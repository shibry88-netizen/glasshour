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
/*
 * 组件大小档位（设计规范增量 v1.3-s1）：
 *   50% / 65% = 迷你版式（隐藏模式胶囊与备注行、字号有下限）
 *   80%       = 标准版式 ×0.8
 *   100%      = 原稿逐像素
 * 每档的窗口/卡片尺寸、字号表、元素取舍都来自规范，这里逐条硬断言。
 */
const SCALE_SPEC = [
  { k: 1, view: { width: 460, height: 320 }, card: { w: 420, h: 280 }, mini: false },
  { k: 0.8, view: { width: 376, height: 264 }, card: { w: 336, h: 224 }, mini: false },
  { k: 0.65, view: { width: 313, height: 222 }, card: { w: 273, h: 182 }, mini: true },
  { k: 0.5, view: { width: 250, height: 180 }, card: { w: 210, h: 140 }, mini: true },
];
const SCALE_BY_K = SCALE_SPEC.reduce((m, x) => (m[x.k] = x, m), {});

// 每档的字号表（= 规范里那张表；中文下限 11、单位 14、主数字 24）
function expectFor(k) {
  const T = {
    1: { caption: 13, sub: 15, note: 12, unit: 20, bigDate: 96, bigTimer: 88, unit2: 20, navFs: 12, segFs: 12, btnFs: 14 },
    0.8: { caption: 11, sub: 12, note: 11, unit: 16, bigDate: 77, bigTimer: 70, unit2: 16, navFs: 11, segFs: 11, btnFs: 11 },
    0.65: { caption: 11, sub: 11, note: null, unit: 14, bigDate: 62, bigTimer: 57, unit2: 14, navFs: 11, segFs: 11, btnFs: 11 },
    0.5: { caption: 11, sub: 11, note: null, unit: 14, bigDate: 48, bigTimer: 44, unit2: 14, navFs: 11, segFs: 11, btnFs: 11 },
  };
  return T[String(k)] || T['1'];
}

let VIEW = SCALE_SPEC[0].view;
let CARD = SCALE_SPEC[0].card;
let EXPECT = {};

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
  { name: '单条 · 无备注', state: { ...base }, light: true },
  { name: '单条 · 有备注', light: true, state: { ...base, ...E1, entries: [E1], activeId: 'e1' } },
  { name: '3 条 · 中间条', state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2' } },
  { name: '3 条 · 首条', state: { ...base, ...E1, entries: [E1, E2, E3], activeId: 'e1' } },
  { name: '3 条 · 末条无备注', state: { ...base, ...E3, entries: [E1, E2, E3], activeId: 'e3' } },
  { name: '12 条 · 计数器宽度', state: { ...base, ...E12[11], entries: E12, activeId: 'x12' } },
  { name: '紧迫态 + 备注', light: true, state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2' } },
  { name: '计时模式', light: true, state: { ...base, mode: 'timer', ...E1, entries: [E1, E2, E3], activeId: 'e1' } },
  { name: '已固定（位置锁定）', light: true, state: { ...base, ...E1, entries: [E1], activeId: 'e1', locked: true } },
  { name: '已固定 + 三条', state: { ...base, ...E2, entries: [E1, E2, E3], activeId: 'e2', locked: true } },
];

// 期望值（来自《UI 设计规范 v1.0 / 增量 v1.1 / v1.3-s1》）；fontSize 每档现算
function buildExpect(k) {
  const t = expectFor(k);
  const px = (n) => (n == null ? null : n + 'px');
  return {
    caption: { fontSize: px(t.caption) },
    sub: { fontSize: px(t.sub) },
    note: { fontSize: px(t.note), color: 'rgba(236, 232, 224, 0.55)' },
    unit: { fontSize: px(t.unit) },
  };
}

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

  for (const spec of SCALE_SPEC) {
  const K = spec.k;
  VIEW = spec.view;
  CARD = spec.card;
  EXPECT = buildExpect(K);
  await page.setViewportSize(VIEW);
  const cases = K === 1 ? CASES : CASES.filter((c) => c.light);
  console.log(`\n\n########## 组件大小 ${Math.round(K * 100)}%（窗口 ${VIEW.width}x${VIEW.height} · 卡片 ${CARD.w}x${CARD.h}）##########`);

  for (const c of cases) {
    console.log(`\n===== [${Math.round(K * 100)}%] ${c.name} =====`);
    await page.addInitScript((s) => {
      window.__GH_MOCK__ = s;
    }, Object.assign({ uiScale: K, now: Date.now() }, c.state));
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
        if (K === 1) {
          say(nav.left >= 124 && nav.right <= 364, `切换控件不侵入胶囊(≤124)与齿轮(≥364)：[${nav.left}, ${nav.right}]`);
        } else {
          say(nav.left >= 8 && nav.right <= CARD.w - 8, `切换控件在卡片内留边：[${nav.left}, ${nav.right}]`);
        }
        console.log(`   ℹ️ 切换控件宽 ${nav.w}px（规范最小 96px，≥10 条可加宽）`);
      }
    } else {
      say(!nav || !nav.visible, `条目数 ${n} = 1 → 切换控件必须不渲染（当前 ${nav && nav.visible ? '❌ 仍渲染' : '正确隐藏'}）`);
    }

    // 4.5) 顶部三件套横向不打架
    const seg = (byName['mode-btn'] || [])[0];
    const gear = (byName['settings'] || [])[0];
    const lockBtn = (byName['lock'] || [])[0];
    if (seg && seg.visible && lockBtn && nav && nav.visible) {
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
      say(pin.right <= CARD.w - 4 && pin.left > 0, `图钉在卡片右上留边内 [${pin.left}, ${pin.right}]`);
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

    /* ---------------- 7) 组件大小档位专项（v1.3-s1） ---------------- */
    const t = expectFor(K);
    const cardNow = data.card;
    say(
      Math.abs(cardNow.w - CARD.w) <= 0.5 && Math.abs(cardNow.h - CARD.h) <= 0.5,
      `卡片尺寸 ${cardNow.w}x${cardNow.h}（规范 ${CARD.w}x${CARD.h}）`
    );

    // 7.1 主数字：日期/计时两套期望值
    if (big) {
      const want = c.state.mode === 'timer' ? t.bigTimer : t.bigDate;
      say(parseFloat(big.fontSize) === want, `主数字字号 ${parseFloat(big.fontSize)}px（规范 ${want}px）`);
      say(parseFloat(big.fontSize) >= 24, '主数字 ≥ 24px 下限（低于此就不再是「一眼读数」）');
    }
    // 7.2 字号下限：中文一律 ≥11，单位 ≥14
    const texts = data.els.filter((e) => e.visible && TEXTUAL.has(e.name) && e.name !== 'big');
    texts.forEach((e) => {
      const fs = parseFloat(e.fontSize);
      const floor = e.name === 'unit' ? 14 : 11;
      say(fs >= floor, `${e.name} 字号 ${fs}px ≥ 下限 ${floor}px`);
    });
    // 7.3 玻璃是材质：blur 与 1px 描边全档位恒定
    const mat = await page.evaluate(() => {
      const el = document.querySelector('[data-gh="card"]');
      const cs = getComputedStyle(el);
      return { bf: cs.backdropFilter || cs.webkitBackdropFilter, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius };
    });
    say(/blur\(28px\)/.test(mat.bf), `卡片 blur 恒 28px（当前 ${mat.bf}）`);
    say(/0px 0px 0px 1px/.test(mat.shadow), '内描边恒 1px（不许 0.5px 亚像素边）');
    say(!/0\.5px/.test(mat.shadow + mat.bf), '没有出现 0.5px 的亚像素宽度');

    // 7.4 元素取舍：迷你档不渲染模式胶囊与备注行
    if (spec.mini) {
      const segEl = (byName['mode-btn'] || [])[0];
      say(!segEl || !segEl.visible, `迷你档不渲染模式胶囊（当前 ${segEl && segEl.visible ? '❌ 仍渲染' : '正确隐藏'}）`);
      const noteEl = (byName['note'] || [])[0];
      say(!noteEl || !noteEl.visible, `迷你档不渲染备注行（当前 ${noteEl && noteEl.visible ? '❌ 仍渲染' : '正确隐藏'}）`);
    } else {
      const segEl = (byName['mode-btn'] || [])[0];
      say(!!segEl && segEl.visible, '标准档必须渲染模式胶囊');
    }
    // 7.5 图钉与齿轮任何档位都必须可达
    ['lock', 'settings'].forEach((n) => {
      const e = (byName[n] || [])[0];
      say(!!e && e.visible, `${n} 在 ${Math.round(K * 100)}% 档仍渲染（固定/设置入口不可消失）`);
    });

    // 7.6 命中区：所有可点控件的有效点击直径 ≥24px（seg 按钮在 100% 档按旧稿 20px）
    const hits = await page.evaluate((names) => {
      const inside = (el, x, y) => {
        const t = document.elementFromPoint(x, y);
        return !!t && (t === el || el.contains(t));
      };
      const out = {};
      document.querySelectorAll('[data-gh]').forEach((el) => {
        const tag = el.getAttribute('data-gh');
        if (!names.includes(tag)) return;
        const r = el.getBoundingClientRect();
        if (getComputedStyle(el).display === 'none' || r.width === 0) return;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        let half = 0;
        for (let d = 0.5; d <= 16; d += 0.5) {
          if (!(inside(el, cx - d, cy) && inside(el, cx + d, cy) && inside(el, cx, cy - d) && inside(el, cx, cy + d))) break;
          half = d;
        }
        out[tag] = +(half * 2).toFixed(1);
      });
      return out;
    }, ['lock', 'settings', 'entry-prev', 'entry-next', 'timer-toggle', 'timer-reset', 'mode-btn']);
    Object.keys(hits).forEach((n) => {
      const floor = n === 'mode-btn' && K === 1 ? 20 : 24;
      // 探测按 0.5px 步进，点正好落在边界上会被判在外侧 → 留 1px 容差
      say(hits[n] >= floor - 1, `${n} 命中区 ${hits[n]}px ≥ ${floor}px（含 1px 边界容差）`);
    });
  }
  }

  await browser.close();
  console.log(`\n===== 审计完成：${problems === 0 ? '全部通过 ✅' : problems + ' 处问题 ❌'} =====`);
  process.exit(problems === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
