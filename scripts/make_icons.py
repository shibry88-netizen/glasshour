#!/usr/bin/env python3
"""GlassHour · 图标多尺寸处理
   输入  design/icon-1024.png   （scripts/render_icon.js 渲染出来的透明底 1024 图）
   输出  build/icon.ico         （electron-builder 用的多尺寸 Windows 图标）
         build/icon.png         （512，通用）
         assets/tray.png        （托盘小图标，按小尺寸粗化变体处理）
         design/icon-sheet.png  （1024/256/64/48/32/16 对比图，给「模型之眼」复核）
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
SRC = os.path.join(ROOT, 'design', 'icon-1024.png')
os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)

if not os.path.exists(SRC):
    print('缺少源图：%s\n请先运行： node scripts/render_icon.js' % SRC, file=sys.stderr)
    sys.exit(1)

src = Image.open(SRC).convert('RGBA')
print('源图:', src.size)

# ---------- 1) Windows 多尺寸 .ico ----------
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
ico_path = os.path.join(ROOT, 'build', 'icon.ico')
src.save(ico_path, format='ICO', sizes=ICO_SIZES)
print('ico ->', ico_path, ICO_SIZES)

# ---------- 2) 通用 png ----------
png512 = src.resize((512, 512), Image.LANCZOS)
png512.save(os.path.join(ROOT, 'build', 'icon.png'))
png512.save(os.path.join(ROOT, 'assets', 'icon.png'))
print('png -> build/icon.png, assets/icon.png (512)')

# ---------- 3) 托盘图标（16/32，做小尺寸锐化） ----------
def sharpen_small(im, size):
    out = im.resize((size, size), Image.LANCZOS)
    # 轻微提对比，抵消缩小时的发灰
    r, g, b, a = out.split()
    r = r.point(lambda v: min(255, int(v * 1.12)))
    g = g.point(lambda v: min(255, int(v * 1.08)))
    b = b.point(lambda v: min(255, int(v * 1.02)))
    return Image.merge('RGBA', (r, g, b, a))

tray32 = sharpen_small(src, 32)
tray32.save(os.path.join(ROOT, 'assets', 'tray@2x.png'))
tray16 = sharpen_small(src, 16)
tray16.save(os.path.join(ROOT, 'assets', 'tray.png'))
print('tray -> assets/tray.png (16), assets/tray@2x.png (32)')

# ---------- 4) 对比图（深/浅底 × 六种尺寸） ----------
SIZES = [1024, 256, 64, 48, 32, 16]
PAD = 28
CELL_H = 300
rows = [('#0b0b0d', (236, 231, 221)), ('#f2f2f2', (30, 30, 30))]
cell_w = []
for s in SIZES:
    cell_w.append(max(s, 90) + PAD * 2)
sheet_w = sum(cell_w)
sheet_h = CELL_H * len(rows) + 46
sheet = Image.new('RGB', (sheet_w, sheet_h), (20, 20, 22))
d = ImageDraw.Draw(sheet)

try:
    from PIL import ImageFont
    font = ImageFont.load_default()
except Exception:
    font = None

for ri, (bg, fg) in enumerate(rows):
    y0 = 46 + ri * CELL_H
    d.rectangle([0, y0, sheet_w, y0 + CELL_H], fill=bg)
    x = 0
    for ci, s in enumerate(SIZES):
        im = src.resize((s, s), Image.LANCZOS)
        cx = x + cell_w[ci] // 2
        cy = y0 + CELL_H // 2
        sheet.paste(im, (cx - s // 2, cy - s // 2), im)
        label = '%dpx' % s
        d.text((cx - 16, y0 + CELL_H - 26), label, fill=fg, font=font)
        x += cell_w[ci]

d.text((12, 14), 'GlassHour icon · 1024 / 256 / 64 / 48 / 32 / 16 (top: dark bg, bottom: light bg)',
       fill=(216, 182, 120), font=font)

sheet_path = os.path.join(ROOT, 'design', 'icon-sheet.png')
sheet.save(sheet_path)
print('对比图 ->', sheet_path, sheet.size)
