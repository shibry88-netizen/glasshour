#!/usr/bin/env python3
"""从 assets/icon.svg 生成「小尺寸粗化变体」——按设计师规范：
   32px：删光晕/柔化滤镜/高光/细环；描边 12→30；沙粒并成实心；rx 228→200；背景纯色 #12151A
   16px：只留上下金横梁 + 两个实心金三角 + 中轴，全单色金，描边 36，无渐变
   输出：design/icon-32.svg  design/icon-16.svg
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
OUT = os.path.join(ROOT, 'design')

SVG32 = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="gold" x1=".15" y1="0" x2=".85" y2="1">
      <stop offset="0" stop-color="#F0DCA8"/><stop offset=".42" stop-color="#C9A45B"/><stop offset="1" stop-color="#8C6B2E"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="200" fill="#12151A"/>
  <g fill="url(#gold)">
    <path d="M318 268H706C640 402 552 462 512 512C472 462 384 402 318 268Z"/>
    <path d="M318 756H706C640 622 552 562 512 512C472 562 384 622 318 756Z"/>
    <rect x="272" y="222" width="480" height="44" rx="22"/>
    <rect x="272" y="758" width="480" height="44" rx="22"/>
  </g>
  <g stroke="#12151A" stroke-width="30" stroke-linejoin="round" fill="none">
    <path d="M318 268H706C640 402 552 462 512 512C472 462 384 402 318 268Z"/>
    <path d="M318 756H706C640 622 552 562 512 512C472 562 384 622 318 756Z"/>
  </g>
</svg>
'''

SVG16 = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="200" fill="#12151A"/>
  <g fill="#C9A45B">
    <rect x="302" y="238" width="420" height="56" rx="28"/>
    <rect x="302" y="730" width="420" height="56" rx="28"/>
    <path d="M340 294H684C626 400 550 456 512 498C474 456 398 400 340 294Z"/>
    <path d="M340 730H684C626 624 550 568 512 526C474 568 398 624 340 730Z"/>
    <rect x="500" y="486" width="24" height="52" rx="12"/>
  </g>
</svg>
'''

for name, content in (('icon-32.svg', SVG32), ('icon-16.svg', SVG16)):
    p = os.path.join(OUT, name)
    os.makedirs(OUT, exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(content)
    print('写入', p, len(content), 'bytes')
