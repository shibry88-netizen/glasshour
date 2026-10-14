#!/usr/bin/env python3
"""GlassHour · 组件大小对照图

把 scripts/screenshot.js 生成的 size-{50,65,80,100}-*.png 拼成一张对照图：
  · 行 = 组件大小档位（50 / 65 / 80 / 100%）
  · 列 = 状态（日期默认 / 紧迫 / 计时中 / 多条）
统一降到 1x 显示（screenshot 出的是 2x），按真实 CSS 尺寸摆位 ——
这样「50% 到底小多少」一眼就能比出来，而不是各自居中放大。

用法： python3 scripts/make_size_sheet.py [shots 目录] [输出文件]
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'design', 'shots')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'design', 'shots', 'size-compare.png')

SCALES = [0.5, 0.65, 0.8, 1]
STATES = [
    ('date-default', '日期倒计时'),
    ('date-urgent', '紧迫（<7 天）'),
    ('timer-running', '计时中'),
    ('date-multi', '多条 + 切换'),
]

CELL_W, CELL_H = 470, 330   # 以 100% 档窗口尺寸为准（460x320）
PAD = 18
HEADER = 56
LABEL_H = 26

BG = (11, 12, 14)
GOLD = (201, 164, 91)
DIM = (155, 150, 142)


def font(size, bold=False):
    for p in (
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=1 if bold and p.endswith('.ttc') else 0)
            except Exception:
                continue
    return ImageFont.load_default()


def main():
    W = PAD + len(STATES) * (CELL_W + PAD)
    H = HEADER + len(SCALES) * (CELL_H + LABEL_H + PAD)
    sheet = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(sheet)
    f_title = font(22)
    f_lab = font(15)
    f_cell = font(16)

    d.text((PAD, 16), 'GlassHour · 组件大小对照（50 / 65 / 80 / 100%）', fill=GOLD, font=f_title)
    d.text((PAD + 430, 22), '同一状态在四档下的真实尺寸，1:1 显示', fill=DIM, font=f_lab)

    # 列标题
    for ci, (_, cn) in enumerate(STATES):
        x = PAD + ci * (CELL_W + PAD)
        d.text((x + 4, HEADER - 24), cn, fill=DIM, font=f_cell)

    missing = []
    for ri, k in enumerate(SCALES):
        y = HEADER + ri * (CELL_H + LABEL_H + PAD)
        d.text((PAD + 2, y + CELL_H + 4), f'{round(k * 100)}%' + ('（出厂默认）' if k == 0.5 else ''), fill=GOLD, font=f_lab)
        for ci, (key, _) in enumerate(STATES):
            x = PAD + ci * (CELL_W + PAD)
            src = os.path.join(SHOTS, f'size-{round(k * 100)}-{key}.png')
            if not os.path.exists(src):
                missing.append(os.path.basename(src))
                d.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], outline=(60, 40, 30))
                d.text((x + 8, y + 8), '缺图', fill=(150, 90, 60), font=f_cell)
                continue
            im = Image.open(src).convert('RGBA')
            # 2x → 1x，保持真实 CSS 尺寸
            im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
            # 按格子底部右对齐（组件默认在桌面右下角），贴着格子右下角放
            px = x + CELL_W - im.width - 8
            py = y + CELL_H - im.height - 8
            sheet.paste(im, (px, py), im)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT)
    print('对照图 ->', OUT, sheet.size)
    if missing:
        print('缺少这些图（先跑 node scripts/screenshot.js）：')
        for m in missing:
            print('  -', m)


if __name__ == '__main__':
    main()
