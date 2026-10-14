#!/usr/bin/env python3
"""GlassHour · 托盘图标生成

输入  design/icon-16.svg  （16px 粗化变体，设计师规范：单色金 + 实心三角）
      design/icon-32.svg  （32px 粗化变体）
      assets/icon.svg     （兜底：直接缩主图标）
输出  assets/tray.png     (16, Windows 通知区域)
      assets/tray@2x.png  (32, 高 DPI)

小尺寸必须用「粗化变体」而不是直接缩主图——主图在 16px 下光晕/高光会糊成一团。
渲染优先用 rsvg-convert，其次 cairosvg；都没有就退回 Pillow 缩主图并给出警告。

用法： python3 scripts/make_tray.py
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
DESIGN = os.path.join(ROOT, 'design')
ASSETS = os.path.join(ROOT, 'assets')
os.makedirs(ASSETS, exist_ok=True)

from PIL import Image  # noqa: E402


def tune(im, size, bright=(1.12, 1.08, 1.02)):
    """小尺寸提亮，抵消缩放发灰"""
    out = im.resize((size, size), Image.LANCZOS)
    r, g, b, a = out.split()
    r = r.point(lambda v: min(255, int(v * bright[0])))
    g = g.point(lambda v: min(255, int(v * bright[1])))
    b = b.point(lambda v: min(255, int(v * bright[2])))
    return Image.merge('RGBA', (r, g, b, a))


def render_svg(svg_path, png_path, size):
    """把 SVG 渲染成指定尺寸 PNG。返回 True 表示用上了 SVG。"""
    if not os.path.exists(svg_path):
        return False
    rsvg = shutil.which('rsvg-convert')
    if rsvg:
        subprocess.run(
            [rsvg, '-w', str(size), '-h', str(size), '-o', png_path, svg_path],
            check=True, capture_output=True,
        )
        return True
    try:
        import cairosvg  # noqa: WPS433
        cairosvg.svg2png(
            url=svg_path, write_to=png_path,
            output_width=size, output_height=size,
        )
        return True
    except Exception as err:  # noqa: BLE001
        print('  SVG 渲染不可用（%s），退回缩放主图' % err, file=sys.stderr)
        return False


def load_source():
    """主图标：优先 design/icon-1024.png，其次把 assets/icon.svg 渲染出来当兜底"""
    p1024 = os.path.join(DESIGN, 'icon-1024.png')
    if os.path.exists(p1024):
        return Image.open(p1024).convert('RGBA')
    svg = os.path.join(ASSETS, 'icon.svg')
    tmp = os.path.join(DESIGN, '_icon-fallback.png')
    if render_svg(svg, tmp, 1024):
        return Image.open(tmp).convert('RGBA')
    return None


def main():
    src = load_source()

    jobs = [
        ('tray.png', 'icon-16.svg', 16),
        ('tray@2x.png', 'icon-32.svg', 32),
    ]
    for out_name, svg_name, size in jobs:
        out = os.path.join(ASSETS, out_name)
        tmp = out + '.raw.png'
        used_svg = render_svg(os.path.join(DESIGN, svg_name), tmp, size)
        if used_svg:
            im = Image.open(tmp).convert('RGBA')
            # 变体本身就是为小尺寸画的，只做轻微提亮
            tune(im, size, (1.06, 1.04, 1.0)).save(out)
            os.remove(tmp)
            print('%-14s <- design/%s (%dpx)' % (out_name, svg_name, size))
        elif src is not None:
            tune(src, size).save(out)
            print('%-14s <- assets/icon.svg 缩放 (%dpx)  ⚠ 未用粗化变体' % (out_name, size))
        else:
            print('缺少 assets/icon.svg，无法生成 %s' % out_name, file=sys.stderr)
            sys.exit(1)

    # 顺便保证 assets/icon.png（512）在仓库里存在，别让运行时找不到
    icon_png = os.path.join(ASSETS, 'icon.png')
    if not os.path.exists(icon_png) and src is not None:
        src.resize((512, 512), Image.LANCZOS).save(icon_png)
        print('icon.png       <- assets/icon.svg (512px)')

    print('托盘图标生成完成 ->', ASSETS)


if __name__ == '__main__':
    main()
