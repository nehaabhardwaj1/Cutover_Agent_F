"""
Run once to generate icon16.png, icon48.png, icon128.png
Requires Pillow: pip install pillow
"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 48, 128]
BG    = (0, 0, 0, 255)        # black
FG    = (161, 0, 255, 255)    # Accenture purple #A100FF

script_dir = os.path.dirname(os.path.abspath(__file__))

for size in SIZES:
    img  = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)

    # Draw ">" centred
    char = ">"
    font_size = int(size * 0.65)

    font = None
    for fname in ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf",
                  "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"]:
        try:
            font = ImageFont.truetype(fname, font_size)
            break
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), char, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (size - w) // 2 - bbox[0]
    y = (size - h) // 2 - bbox[1]
    draw.text((x, y), char, fill=FG, font=font)

    out = os.path.join(script_dir, f"icon{size}.png")
    img.save(out, "PNG")
    print(f"Saved {out}")

print("Done — reload the extension in chrome://extensions")
