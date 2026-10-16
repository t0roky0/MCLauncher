"""The shop's coin: the user's own pixel art (8x8, 16.10.2026) — a gold disc
lit from the top left, a brown rim, darker at the bottom right. Written as
assets/images/coin.png; the launcher shows it at whole multiples only (24 px
in the wallet and at a price, 32 px on a coin pack) with pixelated scaling.
The same art is the 'coin' sprite in src/renderer/js/icons.js (toasts).
The coin before it (drawn by script, 16 and 12 px): .design-backups/coin-before-user.

    python scripts/shop/coin.py [preview.png]
"""
import os, sys
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'images')
COLORS = {
    'O': (0x74, 0x45, 0x00), 'P': (0x53, 0x30, 0x00),   # the rim: top left, bottom right
    'W': (0xff, 0xe7, 0xbf), 'A': (0xff, 0xcd, 0x76),   # the glint, the lit face
    'S': (0xff, 0xc3, 0x57), 'B': (0xff, 0xbf, 0x4c),   # the face
    'D': (0xff, 0xad, 0x19), 'E': (0xfc, 0xa1, 0x1b), 'C': (0xff, 0xa0, 0x00),   # its shade
}
ROWS = [
    '..OOOO..',
    '.OAABCP.',
    'OAWWBBCP',
    'OAWSBDEP',
    'OBBBDEEP',
    'OCBDEEEP',
    '.PCEEEP.',
    '..PPPP..',
]

img = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
for y, row in enumerate(ROWS):
    for x, ch in enumerate(row):
        if ch != '.':
            img.putpixel((x, y), COLORS[ch] + (255,))
img.save(os.path.join(OUT, 'coin.png'))
if len(sys.argv) > 1:
    sheet = Image.new('RGBA', (8 * 16 + 24 + 32 + 80, 8 * 16 + 40), (29, 28, 27, 255))
    sheet.alpha_composite(img.resize((128, 128), Image.NEAREST), (20, 20))
    sheet.alpha_composite(img.resize((24, 24), Image.NEAREST), (168, 20))
    sheet.alpha_composite(img.resize((32, 32), Image.NEAREST), (168, 60))
    sheet.save(sys.argv[1])
print('coin', OUT)
