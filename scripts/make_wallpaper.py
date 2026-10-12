#!/usr/bin/env python3
"""生成一张「深色 + 鎏金光斑」的模拟壁纸，给液态玻璃截图当背景。
   液态玻璃的模糊/折射必须有东西可模糊，纯透明背景下的截图会失真。
   输出： design/mock/wallpaper.png (1920x1080)
"""
import os
import random
from PIL import Image, ImageDraw, ImageFilter

random.seed(20261013)
W, H = 1920, 1080
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, '..', 'design', 'mock')
os.makedirs(OUT_DIR, exist_ok=True)
OUT = os.path.join(OUT_DIR, 'wallpaper.png')

# ---- 1) 竖向渐变底（上偏冷灰、下偏深黑） ----
base = Image.new('RGB', (W, H), (9, 9, 12))
d = ImageDraw.Draw(base)
for y in range(H):
    t = y / H
    r = int(26 - 18 * t)
    g = int(25 - 17 * t)
    b = int(31 - 20 * t)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# ---- 2) 鎏金光斑（左上一大团 + 右下几小团） ----
glow = Image.new('RGB', (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
spots = [
    (int(W * 0.18), int(H * 0.16), 470, (168, 128, 52)),
    (int(W * 0.72), int(H * 0.82), 380, (120, 92, 38)),
    (int(W * 0.87), int(H * 0.20), 300, (96, 74, 30)),
    (int(W * 0.34), int(H * 0.92), 260, (74, 58, 26)),
]
for cx, cy, rad, col in spots:
    gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=col)
glow = glow.filter(ImageFilter.GaussianBlur(140))
img = Image.blend(base, glow, 0.52)

# ---- 3) 加一圈柔和暗角，像真壁纸 ----
vig = Image.new('L', (W, H), 0)
vd = ImageDraw.Draw(vig)
pad = 240
vd.ellipse([-pad, -pad, W + pad, H + pad], fill=255)
vig = vig.filter(ImageFilter.GaussianBlur(220))
black = Image.new('RGB', (W, H), (0, 0, 0))
img = Image.composite(img, black, vig)

# ---- 4) 细噪点，避免色带 ----
noise = Image.effect_noise((W, H), 9).convert('RGB')
img = Image.blend(img, Image.blend(img, noise, 0.16), 0.55)

img.save(OUT)
print('wallpaper ->', os.path.abspath(OUT), img.size)
