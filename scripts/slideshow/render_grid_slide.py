#!/usr/bin/env python3
"""Render a faceless "2x2 food grid" TikTok slide (Clear Food-style format).

Layout reproduced from the reference slides:
  * 4 photos in a 2x2 grid, no gutters, each cropped to fill (cover)
  * one caption centred exactly on the horizontal seam, TikTok "classic"
    style: white text, thick black outline, lowercase, no background
  * optional transparent PNG cutout (statue / person) bottom-centre,
    overlapping all four tiles
  * optional "box" caption style (black text on white rounded rect) used
    on CTA slides

Examples:
  python3 render_grid_slide.py -o out.jpg --caption "real PROTEIN" \
      tl.jpg tr.jpg bl.jpg br.jpg
  python3 render_grid_slide.py -o out.jpg --ratio 9:16 \
      --caption "Why is my blood flow so good?" --cutout statue.png a b c d
"""
import argparse
from PIL import Image, ImageDraw, ImageFont, ImageOps

RATIOS = {"3:4": (1080, 1440), "9:16": (1080, 1920)}
FONT_CANDIDATES = [
    "TikTokSans-Medium.ttf",  # drop the real TikTok Sans next to this script if you have it
    "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(path, size):
    for p in ([path] if path else []) + FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs=4, help="top-left top-right bottom-left bottom-right")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--caption", default="")
    ap.add_argument("--ratio", choices=RATIOS, default="3:4")
    ap.add_argument("--style", choices=["outline", "box"], default="outline")
    ap.add_argument("--cutout", help="transparent PNG placed bottom-centre")
    ap.add_argument("--cutout-height", type=float, default=0.45, help="fraction of canvas height")
    ap.add_argument("--font")
    ap.add_argument("--font-scale", type=float, default=0.07, help="font size as fraction of width")
    a = ap.parse_args()

    W, H = RATIOS[a.ratio]
    canvas = Image.new("RGB", (W, H), "black")
    tw, th = W // 2, H // 2
    for i, path in enumerate(a.images):
        tile = ImageOps.fit(Image.open(path).convert("RGB"), (tw, th), Image.LANCZOS)
        canvas.paste(tile, ((i % 2) * tw, (i // 2) * th))

    if a.cutout:
        cut = Image.open(a.cutout).convert("RGBA")
        ch = int(H * a.cutout_height)
        cut = cut.resize((int(cut.width * ch / cut.height), ch), Image.LANCZOS)
        canvas.paste(cut, ((W - cut.width) // 2, H - ch), cut)

    if a.caption:
        d = ImageDraw.Draw(canvas)
        font = load_font(a.font, int(W * a.font_scale))
        lines = wrap(d, a.caption, font, W * (0.8 if a.style == "box" else 0.62))
        asc, desc = font.getmetrics()
        lh = int((asc + desc) * 1.0)
        top = H // 2 - lh * len(lines) // 2
        if a.style == "box":
            widths = [d.textlength(l, font=font) for l in lines]
            pad = int(W * 0.03)
            bw = max(widths) + pad * 2
            d.rounded_rectangle([(W - bw) / 2, top - pad // 2, (W + bw) / 2, top + lh * len(lines) + pad // 2],
                                radius=int(W * 0.015), fill="white")
        for n, line in enumerate(lines):
            y = top + n * lh
            if a.style == "box":
                d.text((W / 2, y), line, font=font, fill="black", anchor="ma")
            else:
                d.text((W / 2, y), line, font=font, fill="white", anchor="ma",
                       stroke_width=max(3, int(W * 0.0045)), stroke_fill="black")

    canvas.save(a.out, quality=92)
    print(a.out)


if __name__ == "__main__":
    main()
