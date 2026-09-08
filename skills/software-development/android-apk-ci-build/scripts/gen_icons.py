#!/usr/bin/env python3
"""Generate Android launcher icons for a Flutter app: adaptive vector (anydpi-v26)
+ legacy PNGs. Run: python3 gen_icons.py  (edit ROOT/BOLT/BG/GREEN for your app).

Produces, under android/app/src/main/res/:
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png + ic_launcher_round.png
  drawable/ic_launcher_foreground.xml     (bolt + glow, 108dp viewport)
  drawable/ic_launcher_monochrome.xml     (white bolt — Android 13+ themed icons)

Design notes (verified on DebDown+):
- Adaptive foreground viewport is 108dp; keep the actual art inside the
  center ~66dp safe zone or launchers crop it. The bolt poly below is ~40dp.
- The <monochrome> layer is what makes the icon follow wallpaper theme colors
  on Android 13+ ("themed icons"). Include it or the icon won't theme.
- Legacy PNGs still needed for API < 26 (adaptive icons are v26+).
- PIL is required: python3 -m pip install --break-system-packages pillow
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = '/tmp/debdownplus/android/app/src/main/res'   # <-- point at your project

# Bolt polygon in 108-space, centered ~(55,54)
BOLT = [(64, 18), (42, 56), (52, 56), (46, 90), (68, 48), (58, 48)]
CX, CY = 55, 54
SCALE = 1.30                       # glow outline multiplier
GLOW = [(CX + (x - CX) * SCALE, CY + (y - CY) * SCALE) for x, y in BOLT]

BG = (7, 18, 7, 255)               # dark green-black background
GREEN = (57, 255, 20, 255)         # neon green #39FF14


def render_icon(size):
    """Render 108-space design scaled to `size` px."""
    k = size / 108.0
    img = Image.new('RGBA', (size, size), BG)
    # subtle radial glow behind art
    glow_canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_canvas)
    gd.ellipse([size * 0.22, size * 0.16, size * 0.78, size * 0.86],
               fill=(57, 255, 20, 46))
    glow_canvas = glow_canvas.filter(ImageFilter.GaussianBlur(size * 0.06))
    img = Image.alpha_composite(img, glow_canvas)
    d = ImageDraw.Draw(img)
    d.polygon([(x * k, y * k) for x, y in GLOW], fill=(57, 255, 20, 70))
    d.polygon([(x * k, y * k) for x, y in BOLT], fill=GREEN)
    return img


def main():
    sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for folder, size in sizes.items():
        icon = render_icon(size)
        base = os.path.join(ROOT, f'mipmap-{folder}')
        os.makedirs(base, exist_ok=True)
        icon.save(os.path.join(base, 'ic_launcher.png'))
        icon.save(os.path.join(base, 'ic_launcher_round.png'))  # same art
        print('PNG OK', folder, size)

    os.makedirs(os.path.join(ROOT, 'drawable'), exist_ok=True)
    glow_path = ' '.join(f'M{x:.1f},{y:.1f}' if i == 0 else f'L{x:.1f},{y:.1f}'
                         for i, (x, y) in enumerate(GLOW)) + ' Z'
    bolt_path = ' '.join(f'M{x},{y}' if i == 0 else f'L{x},{y}'
                         for i, (x, y) in enumerate(BOLT)) + ' Z'

    fg = f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="{glow_path}" android:fillColor="#3D39FF14"/>
    <path android:pathData="{bolt_path}" android:fillColor="#39FF14"/>
</vector>
'''
    mono = f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="{bolt_path}" android:fillColor="#FFFFFFFF"/>
</vector>
'''
    with open(os.path.join(ROOT, 'drawable', 'ic_launcher_foreground.xml'), 'w') as f:
        f.write(fg)
    with open(os.path.join(ROOT, 'drawable', 'ic_launcher_monochrome.xml'), 'w') as f:
        f.write(mono)
    print('VECTOR OK')


if __name__ == '__main__':
    main()
