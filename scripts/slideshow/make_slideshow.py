#!/usr/bin/env python3
"""Turn rows of content_matrix.json into finished TikTok slideshows.

Each post id becomes a folder with slide-01.jpg ... slide-NN.jpg (content
slides + CTA), post.txt (description + hashtags), plan.json (every prompt
used) and contact-sheet.jpg.

Tiles are generated with the OpenAI Images API (OPENAI_API_KEY) and cached
by prompt, so re-running a post costs nothing. Drop your own photo at
<out>/_cache/override/<post>-s<slide>-t<tile>.jpg to replace any tile.

Usage:
  python3 make_slideshow.py --list
  python3 make_slideshow.py GY01 FJ01 --app-name "MyApp"
  python3 make_slideshow.py SK01 --app-screenshot shot.png --app-icon icon.png
  python3 make_slideshow.py SK01 --dry-run     # print prompts, no API calls
"""
import argparse
import base64
import hashlib
import io
import itertools
import json
import os
import random
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFilter, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_grid_slide import RATIOS, draw_caption, load_font, render_grid  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
INTER = "/usr/share/fonts/opentype/inter/Inter-{}.otf"
GREEN = (61, 174, 112)
CUTOUT_H = {"9:16": 0.47, "3:4": 0.5}  # statue height as a fraction of the slide, matched to the reference posts

# Short screen title on the placeholder app screen, per pillar.
TITLES = {"skin": "Skin score", "face": "Jawline score", "gym": "Workout plan", "posture": "Posture check",
          "grooming": "Grooming", "habits": "Daily routine", "style": "Style check", "progress": "Progress",
          "creator": "Progress"}

# Goal bars shown on the placeholder app screen, per pillar.
GOALS = {
    "food": ["Clear skin", "Body fat", "Muscle", "Health"],
    "skin": ["Clarity", "Hydration", "Glow", "Routine"],
    "face": ["Jawline", "Debloat", "Symmetry", "Sleep"],
    "gym": ["Shoulders", "Back", "Neck", "Consistency"],
    "posture": ["Neck", "Shoulders", "Spine", "Daily stretch"],
    "grooming": ["Hair", "Teeth", "Eyes", "Routine"],
    "habits": ["Sleep", "Discipline", "Screen time", "Routine"],
    "style": ["Fit", "Basics", "Scent", "Grooming"],
    "progress": ["Looks", "Skin", "Body", "Consistency"],
    "creator": ["Jawline", "Routine", "Filming", "Consistency"],
}


def font(weight, size):
    return load_font(size, candidates=[INTER.format(weight), "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"])


# --------------------------------------------------------------------------- images

def openai_image(prompt, model, quality, transparent=False):
    body = {"model": model, "prompt": prompt, "size": "1024x1536", "quality": quality, "n": 1}
    if transparent:
        body.update(background="transparent", output_format="png")
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenAI {e.code}: {e.read().decode(errors='replace')[:400]}\nprompt: {prompt[:160]}") from None
    return base64.b64decode(data["data"][0]["b64_json"])


def strip_white_bg(img):
    """Fallback when the model ignored transparency: flood the near-white border to alpha."""
    img = img.convert("RGBA")
    if img.getextrema()[3][0] < 250:
        return img  # already has transparency
    rgb = img.convert("RGB")
    mask = Image.new("L", img.size, 0)
    for seed in [(0, 0), (img.width - 1, 0), (0, img.height - 1), (img.width - 1, img.height - 1)]:
        tmp = rgb.copy()
        ImageDraw.floodfill(tmp, seed, (255, 0, 255), thresh=40)
        mask = Image.composite(Image.new("L", img.size, 255), mask,
                               Image.eval(tmp.split()[1], lambda v: 255 if v == 0 else 0))
    img.putalpha(ImageOps.invert(mask).filter(ImageFilter.GaussianBlur(1)))
    return img


def openrouter_image(prompt, model, ratio="2:3"):
    """OpenRouter /images endpoint (same contract as src/lib/openrouter.ts). Muse takes the
    aspect ratio inside the prompt; other models take aspect_ratio/quality fields."""
    muse = model == "meta/muse-image"
    body = {"model": model, "prompt": f"{prompt}\nCompose the image in {ratio} aspect ratio." if muse else prompt}
    if not muse:
        body.update(aspect_ratio=ratio, quality="medium", output_format="png")
    req = urllib.request.Request(
        os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1") + "/images",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json",
                 "X-Title": "slashloop"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenRouter {e.code}: {e.read().decode(errors='replace')[:400]}\nprompt: {prompt[:160]}") from None
    if data.get("error"):
        raise RuntimeError(f"OpenRouter: {data['error']}")
    cost = (data.get("usage") or {}).get("cost")
    if cost is not None:
        print(f"  openrouter cost ${cost:.4f}", file=sys.stderr, flush=True)
    return base64.b64decode(data["data"][0]["b64_json"])


class ImageCache:
    def __init__(self, root, model, quality, dry_run, provider="openai"):
        self.root, self.model, self.quality, self.dry, self.provider = root, model, quality, dry_run, provider
        os.makedirs(os.path.join(root, "override"), exist_ok=True)

    def get(self, prompt, transparent=False, override=None):
        if override and os.path.exists(override):
            return Image.open(override)
        key = hashlib.sha1(f"{self.model}|{self.quality}|{transparent}|{prompt}".encode()).hexdigest()[:16]
        if self.provider == "openrouter":
            key = "or-" + key
        path = os.path.join(self.root, key + ".png")
        if not os.path.exists(path):
            if self.dry:
                return Image.new("RGB", (1024, 1536), (60, 60, 60))
            if self.provider == "openrouter":
                png = openrouter_image(prompt, self.model)
                img = Image.open(io.BytesIO(png))
                img.save(path)  # normalise to PNG on disk whatever format came back
                return strip_white_bg(img) if transparent else img.convert("RGB")
            try:
                png = openai_image(prompt, self.model, self.quality, transparent)
            except RuntimeError as e:  # occasional transient 400/5xx: retry once
                print(f"retrying after error: {e}", file=sys.stderr, flush=True)
                png = openai_image(prompt, self.model, self.quality, transparent)
            with open(path, "wb") as f:
                f.write(png)
        img = Image.open(path)
        return strip_white_bg(img) if transparent else img.convert("RGB")


# --------------------------------------------------------------------------- planning

def tile_prompt(m, look, token, post_id=""):
    st = m["special_tiles"]
    if token in ("@person_good", "@person_bad"):
        # a different (but stable) face per post, so the account doesn't repeat one person
        variants = m.get("person_variants", {}).get(token[8:], [])
        if not variants:
            return st[token]
        v = variants[int(hashlib.sha1(post_id.encode()).hexdigest(), 16) % len(variants)]
        return st[token].replace(" No text.", f" Look: {v}. No text.")
    if token.startswith("@sprite:"):
        return st["@sprite"].format(item=token[8:])
    if token.startswith("@statue:"):
        return st["@statue"].format(pose=token[8:])
    return m["looks"][look].format(subject=token, food=token) + m["looks"]["_suffix"]


def pillar_tags(m, post):
    pl = m["pillars"].get("food" if post["pillar"].startswith("food") else post["pillar"], {})
    return pl.get("meme_hashtags") if post["pillar"] == "food (meme)" else pl.get("hashtags")


def cover_prompt(m, post):
    img = post["cover"]["image"]
    if img.startswith("@statue:"):
        base = m["special_tiles"]["@statue"].format(pose=img[8:]).replace(", vertical 2:3. No text.", ".")
    else:
        base = m["looks"]["cover"].format(subject=img)
    return base + m["looks"]["_cover_suffix"]


def render_cover(img, hook, ratio):
    """Slide 1: one full-bleed hero image + a big hook caption in the upper third."""
    W, H = RATIOS[ratio]
    canvas = ImageOps.fit(img.convert("RGB"), (W, H), Image.LANCZOS, centering=(0.5, 0.6))
    shade = Image.linear_gradient("L").resize((W, H)).point(lambda v: int(120 * (1 - v / 255) ** 2))
    canvas = Image.composite(Image.new("RGB", (W, H), "black"), canvas, shade)  # soft darkening at the top
    draw_caption(canvas, hook, "outline", font_scale=0.085, center_y=int(H * 0.19), max_w=0.82)
    return canvas


def plan_post(m, post):
    f = m["formulas"][post["formula"]]
    d = dict(f["defaults"], **post.get("format", {}))
    slides = []
    for i, s in enumerate(post["slides"], 1):
        slides.append({
            "n": i, "caption": s["caption"], "cutout": s.get("cutout", d["cutout"]),
            "tiles": [{"token": t, "prompt": tile_prompt(m, d["look"], t, post["id"])} for t in s["tiles"]],
        })
    return {"id": post["id"], "pillar": post["pillar"], "formula": post["formula"], "topic": post["topic"],
            "ratio": d["ratio"], "look": d["look"], "cta_variant": d["cta"], "default_cutout": d["cutout"],
            "slides": slides, "cta": post["cta"],
            "description": post.get("description") or random.choice(f["description"]),
            "hashtags": pillar_tags(m, post) or f["hashtags"]}


def arrange_for_contrast(tiles, imgs):
    """Reorder plain subject tiles so neighbours differ most in colour (special tiles stay put)."""
    fixed = [i for i, t in enumerate(tiles) if t["token"].startswith("@")]
    free = [i for i in range(4) if i not in fixed]
    if len(free) < 2:
        return list(range(4))
    means = [ImageOps.fit(im.convert("RGB"), (8, 8)).resize((1, 1), Image.BOX).getpixel((0, 0)) for im in imgs]
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(means[a], means[b])) ** 0.5
    best, best_score = list(range(4)), -1
    for perm in itertools.permutations(free):
        order = list(range(4))
        for slot, src in zip(free, perm):
            order[slot] = src
        score = min(dist(order[0], order[1]), dist(order[2], order[3]), dist(order[0], order[2]), dist(order[1], order[3]))
        if score > best_score:
            best, best_score = order, score
    return best


# --------------------------------------------------------------------------- CTA pieces

def app_icon(app_name, size, icon_path=None):
    if icon_path:
        ic = ImageOps.fit(Image.open(icon_path).convert("RGBA"), (size, size))
    else:
        ic = Image.new("RGBA", (size, size), (40, 40, 40, 255))
        d = ImageDraw.Draw(ic)
        d.text((size / 2, size / 2), app_name[:1].upper(), font=font("Bold", int(size * 0.55)), fill="white", anchor="mm")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    ic.putalpha(mask)
    return ic


def download_badge(size):
    b = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.linear_gradient("L").resize((size, size))
    blue = Image.composite(Image.new("RGB", (size, size), (30, 110, 240)), Image.new("RGB", (size, size), (25, 190, 250)), grad)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    b.paste(blue, (0, 0), mask)
    d = ImageDraw.Draw(b)
    w, c = int(size * 0.07), size / 2
    d.line([(c, size * 0.22), (c, size * 0.66)], fill="white", width=w)
    d.line([(c - size * 0.2, size * 0.48), (c, size * 0.68), (c + size * 0.2, size * 0.48)], fill="white", width=w, joint="curve")
    d.line([(size * 0.27, size * 0.8), (size * 0.73, size * 0.8)], fill="white", width=w)
    return b


def score_screen(w, h, title, score, goals, thumb=None):
    """Placeholder app screen (score ring + goal bars). Replace with --app-screenshot."""
    s = Image.new("RGB", (w, h), (244, 244, 244))
    d = ImageDraw.Draw(s)
    u = w / 100
    d.text((7 * u, 4 * u), "9:41", font=font("SemiBold", int(4.2 * u)), fill="black")
    d.rounded_rectangle([36 * u, 2.5 * u, 64 * u, 9 * u], radius=int(3.2 * u), fill="black")
    y = 15 * u
    if thumb is not None:
        t = ImageOps.fit(thumb.convert("RGB"), (int(12 * u), int(12 * u)))
        m = Image.new("L", t.size, 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, t.width - 1, t.height - 1], radius=int(2.5 * u), fill=255)
        s.paste(t, (int(6 * u), int(y)), m)
    d.text((21 * u, y + 6 * u), title, font=font("Bold", int(5.2 * u)), fill="black", anchor="lm")
    cx, cy, r = w / 2, y + 40 * u, 21 * u
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(225, 225, 225), width=int(3.4 * u))
    d.arc([cx - r, cy - r, cx + r, cy + r], start=-90, end=-90 + 360 * score / 100, fill=GREEN, width=int(3.4 * u))
    d.text((cx, cy - 2 * u), str(score), font=font("Bold", int(13 * u)), fill=GREEN, anchor="mm")
    d.text((cx, cy + 9 * u), "Good", font=font("SemiBold", int(4.2 * u)), fill=(130, 130, 130), anchor="mm")
    y = cy + r + 8 * u
    d.rounded_rectangle([6 * u, y, 94 * u, y + 52 * u], radius=int(4 * u), fill="white")
    d.text((11 * u, y + 7 * u), "Your goals", font=font("Bold", int(4.8 * u)), fill="black", anchor="lm")
    rng = random.Random(title)
    for i, g in enumerate(goals):
        gy = y + 17 * u + i * 9.5 * u
        v = max(70, min(99, score + rng.randint(-8, 5)))
        d.text((11 * u, gy), g, font=font("Medium", int(4.3 * u)), fill="black", anchor="lm")
        d.rounded_rectangle([53 * u, gy - 0.8 * u, 79 * u, gy + 0.8 * u], radius=int(u), fill=(228, 228, 228))
        d.rounded_rectangle([53 * u, gy - 0.8 * u, 53 * u + 26 * u * v / 100, gy + 0.8 * u], radius=int(u), fill=GREEN)
        d.text((89 * u, gy), str(v), font=font("Bold", int(4.5 * u)), fill=GREEN, anchor="rm")
    return s


def phone(screen, width):
    """Wrap a screen image in a simple iPhone-style frame (RGBA)."""
    bez = int(width * 0.035)
    sw = width - 2 * bez
    screen = ImageOps.fit(screen.convert("RGB"), (sw, int(sw * 2.16)), centering=(0.5, 0))
    h = screen.height + 2 * bez
    ph = Image.new("RGBA", (width, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ph)
    d.rounded_rectangle([0, 0, width - 1, h - 1], radius=int(width * 0.16), fill=(18, 18, 18), outline=(150, 150, 150), width=max(2, width // 150))
    m = Image.new("L", screen.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, sw - 1, screen.height - 1], radius=int(width * 0.13), fill=255)
    ph.paste(screen, (bez, bez), m)
    return ph


def cta_slide(plan, app_name, screen_img, icon_path, tile_imgs, cutout_img):
    W, H = RATIOS[plan["ratio"]]
    caption = f"get the '{app_name}' app"
    variant = plan["cta_variant"]
    if variant == "in_grid":
        # reuse the last slide's tiles (the one the viewer just saw); screenshot replaces top-right
        imgs = list(tile_imgs[-1])
        tw, th = W // 2, H // 2
        shot = Image.new("RGB", (tw, th), (12, 12, 12))
        p = phone(screen_img, int(tw * 0.86))
        shot.paste(p, ((tw - p.width) // 2, int(th * 0.05)), p)
        imgs[1] = shot
        return render_grid(imgs, caption, plan["ratio"], "outline", cutout_img, cutout_height=CUTOUT_H[plan["ratio"]])
    if variant == "phone_dark":
        bg = Image.new("RGB", (W, H), (6, 6, 6))
        glow = Image.new("L", (W, H), 0)
        ImageDraw.Draw(glow).ellipse([W * 0.15, H * 0.1, W * 0.85, H * 0.9], fill=40)
        bg = Image.composite(Image.new("RGB", (W, H), (60, 60, 60)), bg, glow.filter(ImageFilter.GaussianBlur(W // 6)))
        p = phone(screen_img, int(W * 0.5))
        bg.paste(p, ((W - p.width) // 2, (H - p.height) // 2), p)
        draw_caption(bg, caption, "box", center_y=int(H * 0.44), font_scale=0.062)
        return bg
    # store_card: 3:4 card, centred on 9:16 with grey padding when needed
    card = Image.new("RGB", (1080, 1440), (237, 237, 237))
    d = ImageDraw.Draw(card)
    ic = app_icon(app_name, 172, icon_path)
    card.paste(ic, (92, 108), ic)
    badge = download_badge(172)
    card.paste(badge, (816, 108), badge)
    d.text((540, 158), app_name, font=font("Bold", 86), fill="black", anchor="mm")
    d.text((540, 232), f"Download {app_name}", font=font("SemiBold", 40), fill=(70, 70, 70), anchor="mm")
    p = phone(screen_img, 760)
    card.paste(p, ((1080 - p.width) // 2, 370), p)
    if (W, H) == (1080, 1440):
        return card
    full = Image.new("RGB", (W, H), (237, 237, 237))
    full.paste(card, (0, (H - 1440) // 2))
    return full


# --------------------------------------------------------------------------- build

def build(m, post, args, cache):
    plan = plan_post(m, post)
    out = os.path.join(args.out, post["id"])
    os.makedirs(out, exist_ok=True)

    jobs = []  # (key, prompt, transparent, override)
    for s in plan["slides"]:
        for t, tile in enumerate(s["tiles"]):
            jobs.append(((s["n"], t), tile["prompt"], False,
                         os.path.join(cache.root, "override", f"{post['id']}-s{s['n']}-t{t + 1}.jpg")))
    cutouts = {s["cutout"] for s in plan["slides"]} | ({plan["default_cutout"]} if plan["cta_variant"] == "in_grid" else set())
    for c in cutouts - {"none"}:
        jobs.append((("cutout", c), m["cutouts"][c], True, None))

    if post.get("cover"):
        plan["cover"] = dict(post["cover"], prompt=cover_prompt(m, post))
        jobs.append((("cover",), plan["cover"]["prompt"], False,
                     os.path.join(cache.root, "override", f"{post['id']}-cover.jpg")))
    if args.cover_only:
        if not post.get("cover"):
            print(f"[{post['id']}] has no cover in the matrix, skipped", flush=True)
            return
        jobs = [j for j in jobs if j[0] == ("cover",)]
    if args.dry_run:
        print(json.dumps(plan, indent=1))
        return
    print(f"[{post['id']}] generating {len(jobs)} images (cached ones are free)...", flush=True)
    with ThreadPoolExecutor(args.workers) as ex:
        results = dict(zip([j[0] for j in jobs], ex.map(lambda j: cache.get(j[1], j[2], j[3]), jobs)))

    if args.cover_only:
        render_cover(results[("cover",)], plan["cover"]["hook"], plan["ratio"]).save(
            os.path.join(out, "cover.jpg"), quality=92)
        print(f"[{post['id']}] cover -> {out}/cover.jpg", flush=True)
        return

    slide_imgs, tile_sets = [], []
    if plan.get("cover"):
        slide_imgs.append(render_cover(results[("cover",)], plan["cover"]["hook"], plan["ratio"]))
    for s in plan["slides"]:
        imgs = [results[(s["n"], t)] for t in range(4)]
        order = arrange_for_contrast(s["tiles"], imgs) if post["formula"] != "sprite" else list(range(4))
        imgs = [imgs[i] for i in order]
        s["tile_order"] = order
        tile_sets.append(imgs)
        cut = results.get(("cutout", s["cutout"]))
        slide_imgs.append(render_grid(imgs, s["caption"], plan["ratio"], "outline", cut, cutout_height=CUTOUT_H[plan["ratio"]]))

    # CTA
    if args.app_screenshot:
        screen = Image.open(args.app_screenshot)
    else:
        c = plan["cta"]
        thumb = next((im for s, ims in zip(plan["slides"], tile_sets) for t, im in zip(s["tiles"], ims)
                      if not t["token"].startswith("@")), None)
        pillar = "food" if plan["pillar"].startswith("food") else plan["pillar"]
        title = c.get("food") or TITLES[pillar]
        screen = score_screen(1000, 2160, title[:22], c.get("score", 92), GOALS[pillar], thumb)
    cut = results.get(("cutout", plan["default_cutout"]))
    slide_imgs.append(cta_slide(plan, args.app_name, screen, args.app_icon, tile_sets, cut))

    for i, im in enumerate(slide_imgs, 1):
        im.save(os.path.join(out, f"slide-{i:02d}.jpg"), quality=92)
    with open(os.path.join(out, "post.txt"), "w") as f:
        f.write(f"{plan['description']}\n\n{' '.join(plan['hashtags'])}\n")
    with open(os.path.join(out, "plan.json"), "w") as f:
        json.dump(plan, f, indent=1)
    th = 360
    thumbs = [im.resize((th, int(im.height * th / im.width))) for im in slide_imgs]
    sheet = Image.new("RGB", (len(thumbs) * (th + 12) + 12, max(t.height for t in thumbs) + 24), "white")
    for i, t in enumerate(thumbs):
        sheet.paste(t, (12 + i * (th + 12), 12))
    sheet.save(os.path.join(out, "contact-sheet.jpg"), quality=88)
    print(f"[{post['id']}] done -> {out}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="post ids from content_matrix.json (e.g. GY01 FJ01)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--matrix", default=os.path.join(HERE, "content_matrix.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--app-name", default="YourApp")
    ap.add_argument("--app-icon")
    ap.add_argument("--app-screenshot")
    ap.add_argument("--provider", choices=["openai", "openrouter"], default="openai")
    ap.add_argument("--model", help="default: gpt-image-1.5 (openai) or meta/muse-image (openrouter)")
    ap.add_argument("--quality", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out-suffix", help="write to <out>-<suffix>, e.g. 'muse' to compare models side by side")
    ap.add_argument("--cover-only", action="store_true", help="only generate slide 1 (cover) -> <out>/<id>/cover.jpg")
    args = ap.parse_args()

    m = json.load(open(args.matrix))
    posts = {p["id"]: p for p in m["posts"]}
    if args.list or not args.ids:
        for p in m["posts"]:
            print(f"{p['id']:5} {p['pillar']:12} {p['formula']:9} {p['topic']}")
        return
    missing = [i for i in args.ids if i not in posts]
    if missing:
        sys.exit(f"unknown ids: {missing}")
    args.model = args.model or ("meta/muse-image" if args.provider == "openrouter" else "gpt-image-1.5")
    key_var = "OPENROUTER_API_KEY" if args.provider == "openrouter" else "OPENAI_API_KEY"
    if not args.dry_run and not os.environ.get(key_var):
        sys.exit(f"{key_var} is not set")
    if args.out_suffix:
        args.out = args.out.rstrip("/") + "-" + args.out_suffix
    cache = ImageCache(os.path.join(args.out, "_cache"), args.model, args.quality, args.dry_run, args.provider)
    failed = []
    for i in args.ids:
        try:
            build(m, posts[i], args, cache)
        except RuntimeError as e:  # e.g. a moderation block: report it and keep going
            print(f"[{i}] FAILED: {str(e)[:300]}", file=sys.stderr, flush=True)
            failed.append(i)
    if failed:
        sys.exit(f"failed: {failed}")


if __name__ == "__main__":
    main()
