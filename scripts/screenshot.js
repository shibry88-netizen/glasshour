'use strict';
/**
 * GlassHour · 打包前 UI 截图
 *
 * 关键：液态玻璃的模糊/折射必须有「背后的东西」才成立。
 * 所以截图时会在组件底下垫一张模拟壁纸（design/mock/wallpaper.png），
 * 输出就是真机上「组件压在壁纸层」看到的效果，而不是透明背景干巴巴的图。
 *
 * 用法：
 *   python3 scripts/make_wallpaper.py      # 先生成壁纸（只需一次）
 *   node scripts/screenshot.js [输出目录]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'design', 'shots');
const PAGE = 'file://' + path.join(ROOT, 'renderer', 'index.html');
const WALL = path.join(ROOT, 'design', 'mock', 'wallpaper.png');

// 组件窗口 = 卡片 420x280 + 四周 20px 阴影留白
const VIEW = { width: 460, height: 320 };
// 组件默认摆在屏幕右下角，截壁纸右下角那块，最接近真机
const WALL_STYLE = `
  html, body {
    background: #0a0a0c url("file://${WALL}") no-repeat !important;
    background-size: 1920px 1080px !important;
    background-position: -1440px -740px !important;
  }`;

const DAY = 86400 * 1000;
const soonISO = new Date(Date.now() + 78 * DAY + 6 * 3600e3 + 12 * 60e3 + 30e3).toISOString();

const base = {
  mode: 'date',
  targetISO: soonISO,
  title: '元旦',
  durationSec: 25 * 60,
  timerRunning: false,
  timerEndsAt: 0,
  timerRemaining: 25 * 60,
  opacity: 1,
};

const SHOTS = [
  { name: '01-date-default', state: { ...base }, note: '日期倒计时 · 默认' },
  { name: '02-date-hover', state: { ...base }, hover: true, note: '日期倒计时 · 悬停' },
  {
    name: '03-date-urgent',
    state: { ...base, title: '考试', targetISO: new Date(Date.now() + 3 * DAY + 5 * 3600e3).toISOString() },
    note: '剩余 <7 天 · 紧迫态',
  },
  {
    name: '04-date-done',
    state: { ...base, title: '纪念日', targetISO: new Date(Date.now() - 3600e3).toISOString() },
    note: '已归零 · 完成态',
  },
  {
    name: '05-timer-running',
    state: {
      ...base,
      mode: 'timer',
      timerRunning: true,
      timerEndsAt: Date.now() + 17 * 60e3 + 42e3,
      timerRemaining: 17 * 60 + 42,
    },
    note: '时长计时器 · 计时中',
  },
  {
    name: '06-timer-paused',
    state: { ...base, mode: 'timer', timerRunning: false, timerRemaining: 25 * 60 },
    note: '时长计时器 · 暂停',
  },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(WALL)) {
    console.error('缺少壁纸：' + WALL + '\n请先运行： python3 scripts/make_wallpaper.py');
    process.exit(1);
  }

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();

  for (const shot of SHOTS) {
    await page.addInitScript((s) => {
      window.__GH_MOCK__ = s;
    }, Object.assign({ now: Date.now() }, shot.state));
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.addStyleTag({ content: WALL_STYLE });
    if (page.evaluate) await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(500);
    if (shot.hover) {
      await page.hover('[data-gh="card"]');
      await page.waitForTimeout(700);
    }
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log('  ✓', `${shot.name}.png`, '—', shot.note);
  }

  await browser.close();
  console.log('\n全部截图完成 →', OUT);
})().catch((err) => {
  console.error('截图失败:', err);
  process.exit(1);
});
