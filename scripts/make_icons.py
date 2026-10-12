#!/usr/bin/env python3
"""GlassHour · 图标多尺寸处理
   输入  design/icon-1024.png        （render_icon.js 渲染的主图标）
         design/icon-var-32.png     （可选，32px 粗化变体）
         design/icon-var-16.png     （可选，16px 粗化变体）
   输出  build/icon.ico              （electron-builder 用的多尺寸 Windows 图标）
         build/icon.png / assets/icon.png   （512）
         assets/tray.png (16) / assets/tray@2x.png (32)
         design/icon-sheet.png            （6 档尺寸，深/浅两底色）
         design/icon-sheet-small.png      （小尺寸：原图缩放 vs 粗化变体 对比）
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
DESIGN = os.path.join(ROOT, 'design')
SRC = os.path.join(DESIGN, 'icon-1024.png')

os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)

if not os.path.exists(SRC):
    print('缺少源图：%s\n请先运行： node scripts/render_icon.js' % SRC, file=sys.stderr)
    sys.exit(1)

src = Image.open(SRC).convert('RGBA')
print('源图:', src.size)

try:
    FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
    FONT_S = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 13)
except Exception:
    FONT = ImageFont.load_default()
    FONT_S = FONT

# ---------- 1) Windows 多尺寸 .ico ----------
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
src.save(os.path.join(ROOT, 'build', 'icon.ico'), format='ICO', sizes=ICO_SIZES)
print('ico -> build/icon.ico', ICO_SIZES)

# ---------- 2) 通用 png ----------
src.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'build', 'icon.png'))
src.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'assets', 'icon.png'))
print('png -> build/icon.png, assets/icon.png (512)')


def tune(im, size):
    """小尺寸锐化，抵消缩放发灰"""
    out = im.resize((size, size), Image.LANCZOS)
    r, g, b, a = out.split()
    r = r.point(lambda v: min(255, int(v * 1.12)))
    g = g.point(lambda v: min(255, int(v * 1.08)))
    b = b.point(lambda v: min(255, int(v * 1.02)))
    return Image.merge('RGBA', (r, g, b, a))


# ---------- 3) 托盘 ----------
tune(src, 32).save(os.path.join(ROOT, 'assets', 'tray@2x.png'))
tune(src, 16).save(os.path.join(ROOT, 'assets', 'tray.png'))
print('tray -> assets/tray.png (16), assets/tray@2x.png (32)')

# ---------- 4) 对比图：深/浅底 × 六档 ----------
SIZES = [1024, 256, 64, 48, 32, 16]
PAD = 28
CELL_H = 300
rows = [('#0b0b0d', (236, 231, 221)), ('#f2f2f2', (30, 30, 30))]
cell_w = [max(s, 90) + PAD * 2 for s in SIZES]
sheet = Image.new('RGB', (sum(cell_w), CELL_H * len(rows) + 46), (20, 20, 22))
d = ImageDraw.Draw(sheet)
for ri, (bg, fg) in enumerate(rows):
    y0 = 46 + ri * CELL_H
    d.rectangle([0, y0, sheet.width, y0 + CELL_H], fill=bg)
    x = 0
    for ci, s in enumerate(SIZES):
        im = src.resize((s, s), Image.LANCZOS)
        cx = x + cell_w[ci] // 2
        cy = y0 + CELL_H // 2
        sheet.paste(im, (cx - s // 2, cy - s // 2), im)
        d.text((cx - 18, y0 + CELL_H - 26), '%dpx' % s, fill=fg, font=FONT)
        x += cell_w[ci]
d.text((12, 14), 'GlassHour icon  ·  1024 / 256 / 64 / 48 / 32 / 16   (top: dark bg, bottom: light bg)',
       fill=(216, 182, 120), font=FONT)
sheet.save(os.path.join(DESIGN, 'icon-sheet.png'))
print('对比图 -> design/icon-sheet.png', sheet.size)

# ---------- 5) 小尺寸对比：原图缩放 vs 粗化变体 ----------
v32 = os.path.join(DESIGN, 'icon-var-32.png')
v16 = os.path.join(DESIGN, 'icon-var-16.png')
if os.path.exists(v32) and os.path.exists(v16):
    VS = [48, 32, 16]
    v32img = Image.open(v32).convert('RGBA')
    v16img = Image.open(v16).convert('RGBA')
    W = sum(max(s, 120) + 60 for s in VS) + 60
    Hh = 2 * 250 + 70
    sm = Image.new('RGB', (W, Hh), (11, 11, 13))
    sd = ImageDraw.Draw(sm)
    sd.text((16, 14), 'Small sizes:  original scaled  vs  simplified variant', fill=(216, 182, 120), font=FONT)
    # 第一行：原图缩放
    x = 60
    for s in VS:
        im = src.resize((s, s), Image.LANCZOS)
        sd.text((x - 6, 60), 'origin %dpx' % s, fill=(150, 150, 150), font=FONT_S)
        sm.paste(im, (x, 130 + (48 - s) // 2), im)
        x += max(s, 120) + 60
    # 第二行：粗化变体（48 用 32 变体放大示意）
    x = 60
    for s in VS:
        im = (v32img if s >= 32 else v16img).resize((s, s), Image.LANCZOS)
        sd.text((x - 6, 300), 'variant %dpx' % s, fill=(216, 182, 120), font=FONT_S)
        sm.paste(im, (x, 370 + (48 - s) // 2), im)
        x += max(s, 120) + 60
    sm.save(os.path.join(DESIGN, 'icon-sheet-small.png'))
    print('小尺寸对比 -> design/icon-sheet-small.png', sm.size)
else:
    print('（跳过小尺寸对比：未找到 design/icon-var-32.png 或 icon-var-16.png）')
