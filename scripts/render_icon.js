'use strict';
/**
 * 把 assets/icon.svg 渲染成 1024x1024 透明 PNG（用 Chromium 渲染，保真度最高）
 * 用法： node scripts/render_icon.js [svg路径] [输出png]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SVG = process.argv[2] || path.join(ROOT, 'assets', 'icon.svg');
const OUT = process.argv[3] || path.join(ROOT, 'design', 'icon-1024.png');
const SIZE = 1024;

(async () => {
  if (!fs.existsSync(SVG)) {
    console.error('找不到 SVG：' + SVG);
    process.exit(1);
  }
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    #wrap{width:${SIZE}px;height:${SIZE}px}
    #wrap svg{width:${SIZE}px;height:${SIZE}px;display:block}
  </style></head><body><div id="wrap">${svg}</div></body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, omitBackground: true });
  await browser.close();
  console.log('icon 渲染完成 ->', OUT, `${SIZE}x${SIZE} (透明底)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
