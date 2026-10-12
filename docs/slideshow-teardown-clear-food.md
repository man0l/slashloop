# Teardown: faceless "2×2 food grid" TikTok slideshows (Clear Food app)

Source: 5 slideshow posts from one faceless channel, 17 slides in total. Every zip
starts at `slide-02`, so the cover/hook slide (slide 1) of each post is **not
in the set**. Everything below is based on slides 2 to 5. See "Gaps" at the end.

All five posts are **app-install ads dressed up as health/looksmaxxing memes**.
The product is the iOS app **Clear Food**, a food scanner that gives a 0–100 score plus
"Your goals" bars (Clear skin / Body fat / Muscle / Health / Looks). Each post
is 2–3 content slides and then 1 CTA slide showing the app.

---

## 1. The posts, slide by slide

| Post | Ratio | Slide 2 | Slide 3 | Slide 4 | Slide 5 (CTA) |
|---|---|---|---|---|---|
| **A** `53c0a077` | 3:4 | "average american man": 3 junk-food tiles + 1 weak-jawline side profile | "average european": honeycomb, fruit tray, kiwi + 1 model-face tile | **CTA**: app mockup on a light-grey card ("Mixed Fruits 96 Good") | — |
| **B** `882ba22e` | 3:4 | "eggs & raw milk": a real photo next to its **Minecraft item sprite** | "melon & tomatoes": same pattern | "apples & potatoes": same pattern | **CTA**: app mockup card ("Fried Eggs 90 Good") |
| **C** `c108f284` | 9:16 | "real PROTEIN": chicken, eggs, steak, salmon | "real FATS": avocado, nuts, coconut, olive oil | "real CARBS": sweet potato, oats, sourdough, potatoes | **CTA**: same mockup card, 9:16 version with extra grey padding |
| **D** `d65be698` | 9:16 | "Why is my blood flow so good?": chocolate, watermelon, pomegranate, garlic + **statue cutout** | "Why are my eyes so bright?": carrots, sardines, beef, arugula + statue | **CTA in-grid**: "get the „Clear Food" app", with a real app screenshot as one tile + statue | — |
| **E** `fadec7f0` | 3:4 | "also this isn't healthy": burger, Nutella crêpes, fries, chicken tenders + **facepalm statue** | "but this is.": steak, fruit tray, steak & eggs board + model-face tile | **CTA**: photo of a phone in a dark room, white **box caption** "get the 'Clear Food' app" | — |

---

## 2. The universal template (90% of the slides)

```
┌──────────────┬──────────────┐
│              │              │
│   photo 1    │   photo 2    │   4 full-bleed photos
│              │              │   no gutters, no borders
│        caption on seam      │ ← 1 caption, centred on the horizontal seam
├──────────────┼──────────────┤
│              │              │
│   photo 3    │   photo 4    │   optional: a transparent cutout (statue)
│           ▲ cutout ▲        │   bottom-centre, overlapping all 4 tiles
└──────────────┴──────────────┘
```

### Visual spec (measured from the slides)

| Element | Spec |
|---|---|
| Canvas | **1080×1440 (3:4)** or **1080×1920 (9:16)**. Some exports are 1170 wide (iPhone). Both ratios work. 3:4 shows bigger in the TikTok photo-mode feed. |
| Grid | Exact 2×2 split at 50%/50%, **no gutter, no border, no rounded corners**. Each image is center-crop "cover" filled. |
| Caption font | TikTok's in-app text font (TikTok Sans / Proxima-like geometric sans), medium weight. Inter SemiBold is a near-identical substitute. |
| Caption size | ~7% of canvas width (≈75 px at 1080w). The line spans 35–75% of the width. |
| Caption style | **White fill + black outline** (TikTok "classic" text style). Outline ≈ 4–5 px. No shadow, no background box. |
| Caption position | Centred horizontally and **vertically on the grid seam**: the text straddles the line between the top and bottom rows. |
| Caption length | 2–6 words. Two lines max (9:16 posts wrap to 2 lines). |
| Case | Mostly lowercase, a TikTok-native, low-effort feel. ALL-CAPS only for the key noun ("real **PROTEIN**"). Title case only for the question hooks. |
| Cutout | Optional. A greyscale Greek/Roman statue (back-double-biceps bust, or the "facepalm" statue) with a transparent background, ~45–55% of canvas height, anchored bottom-centre. |
| Box style | Used only on one CTA: black text on a white rounded rectangle (TikTok "box" text style). |

### Image-selection rules

1. **Macro / overhead "texture fill" food shots** (D): the food fills the frame
   edge to edge (pomegranate seeds, sardines, carrot coins). These read as colour
   blocks at thumbnail size. This is the most "premium" look.
2. **Pinterest-style casual phone photos** (A, C, E): real-life plates, pans,
   cutting boards, with a bit of a warm/golden look. They look user-made, not
   stock.
3. **Colour contrast between tiles**: each grid mixes 3–4 different dominant
   colours (red/green/orange/white). They never put two same-colour tiles next
   to each other.
4. **The "person" tile** (A, E): one of the 4 tiles is a face that embodies the
   outcome. A strong-jaw, clear-skin model face means "good food", and a weak
   side profile means "bad food". It is always placed **bottom-left**.
5. **Meme layer** (B): a real photo paired with a Minecraft item sprite
   arranged diagonally (photo/sprite on top, sprite/photo on the bottom). It's a
   nostalgia pattern-interrupt that appeals to Gen-Z men.

---

## 3. The CTA slide: 3 variants

| Variant | Used in | Build |
|---|---|---|
| **Store card** | A, B, C | Flat light-grey bg (#EDEDED). Top row: app icon (left), **"Clear Food"** bold + "Download Clear Food" grey subtitle (centre), App Store icon (right). Below it: an iPhone frame mockup with a screenshot of the scan result. In C, the 3:4 card is centred on a 9:16 grey canvas. **The scanned food matches a food shown in the post** (fruit tray → "Mixed Fruits 96", fried eggs → "Fried Eggs 90"). |
| **In-grid** | D | Same 2×2 grid + statue, but the top-right tile is a real screenshot of the app (score 87). The caption is "get the „Clear Food" app" in outline style. This is the most native-looking CTA because it doesn't break the visual rhythm. |
| **Phone-in-the-dark** | E | A real photo of a phone held in a dark room, showing the scan of the exact plate from the previous slide ("Steak, eggs, and fruit plate 90"). The box caption sits over the middle. It feels like proof ("I scanned it"). |

Common CTA rules: show the **score ring (green, 85–96, "Good")** and the
**goal bars**. The goals listed are *looks* outcomes (Clear skin, Body fat,
Muscle, Looks), not nutrition facts. That is the positioning: food → looks.

---

## 4. Narrative formulas (the 5 hooks)

| # | Formula | Slide-by-slide | Example from the set |
|---|---|---|---|
| 1 | **Contrast / "average X vs average Y"** | bad group → good group → CTA | average american man / average european |
| 2 | **Myth-bust pair** | "this isn't healthy" → "but this is." → CTA | also this isn't healthy / but this is. |
| 3 | **"real ___" category list** | real PROTEIN → real FATS → real CARBS → CTA | macro trilogy |
| 4 | **Rhetorical humble-brag question** | "Why is my ___ so ___?" × 2 → CTA in the same format | blood flow so good / eyes so bright |
| 5 | **Meme mash-up list** | "food & food" with game sprites × 3 → CTA | eggs & raw milk / melon & tomatoes / apples & potatoes |

Copy rules seen across all five:
- **The caption never explains.** There are no benefits, numbers, or sources. The
  images carry the argument, and viewers argue in the comments.
- **The caption is a label for the grid, not a sentence about it.** (A slide
  caption is 2–6 words.)
- **Slightly provocative / polarising** framing (US vs Europe, "raw milk",
  "this isn't healthy" on beloved junk food). This drives comments.
- **Speaks to a male looksmaxxing / "trad health" audience**: statues,
  jawlines, steak & eggs, raw milk, blood flow.
- **The app name appears only on the last slide**, in quotes: "get the 'Clear Food' app".

---

## 5. Replicating it with AI: a pipeline

### Step 1: Generate the concept and captions (LLM)

```text
You write TikTok photo-carousel scripts for a faceless health/looksmaxxing
account promoting the food-scanner app "<APP NAME>".

Format rules:
- 3 or 4 slides. Every content slide = a 2x2 grid of 4 food photos + ONE caption.
- Caption: 2-6 words, lowercase (one ALL-CAPS word allowed), no emojis,
  no hashtags, no explanation. It labels the grid, it never explains it.
- Use one of these formulas: contrast ("average X" vs "average Y"),
  myth-bust ("this isn't healthy" / "but this is."), category list
  ("real PROTEIN" / "real FATS" / "real CARBS"), humble-brag question
  ("Why is my ___ so ___?"), or meme pairing.
- Each grid: 4 visually distinct foods, mixed dominant colours, no two
  same-colour neighbours. Optionally replace one tile with an
  "outcome person" (bottom-left).
- Last slide = CTA "get the '<APP NAME>' app" plus which food from the post is
  being scanned and its score (85-96).

Return JSON:
{"formula": "...", "ratio": "3:4|9:16", "cutout": "none|statue_back|statue_facepalm",
 "slides": [{"caption": "...", "tiles": ["tl food + shot type", "tr ...", "bl ...", "br ..."]}],
 "cta": {"variant": "store_card|in_grid|phone_dark", "scanned_food": "...", "score": 92}}

Topic: <e.g. "foods for testosterone">. Give 5 different scripts.
```

### Step 2: Generate the tile images

Two looks. Pick one per post and keep it consistent.

**A) Macro texture fill (post D look):**
```text
Extreme close-up overhead food photograph of <FOOD>, the food completely fills
the frame edge to edge, no plate or background visible, natural soft daylight,
high saturation, crisp detail, glossy texture, commercial food photography,
square composition, 3:4
```

**B) Casual Pinterest phone photo (posts A/C/E look):**
```text
Casual iPhone photo of <FOOD> on <a cutting board / frying pan / white plate /
kitchen counter>, shot from slightly above, warm golden window light, slightly
imperfect real-life kitchen, Pinterest aesthetic, not styled, realistic,
shallow depth of field, 3:4
```

**Outcome-person tile (optional):**
```text
Portrait photo of a handsome young man, sharp jawline, clear glowing skin,
light eyes, messy/slicked dark hair, neutral expression, looking at camera,
soft beige wall background, natural light, editorial model photo, 3:4
```
(For the "bad" contrast, the original uses a plain side profile with a weak chin
on a white wall. Use this carefully. Don't use real people's photos.)

**Statue cutout (generate once, reuse in every post):**
```text
Black-and-white marble Greek statue bust of a muscular athlete seen from
behind, head turned to the side in profile, curly hair, defined back muscles,
broken-off arms, dramatic studio light, isolated on a plain white background
```
Then remove the background (remove.bg, Canva "BG remover", or `rembg`) and
save it as a transparent PNG. The facepalm variant: "white marble statue of
a man covering his face with his hand in shame, isolated".

**Minecraft-sprite variant (post B):** search for the sprite (eggs, milk
bucket, melon slice, sweet berries, potato, apple) or prompt "Minecraft
16x16 pixel art item sprite of <FOOD>, white background, flat, no shading
blur". Place it diagonally opposite its real photo.

> Tip: to avoid the "AI look", real stock/Pinterest-style photos still perform
> best for the casual look. Use AI mainly for the macro texture tiles, the
> statue, and the person tile.

### Step 3: Assemble the slides

This repo now has a renderer that reproduces the exact layout:
`scripts/slideshow/render_grid_slide.py` (Pillow only).

```bash
# 3:4 grid, classic outline caption
python3 scripts/slideshow/render_grid_slide.py -o s2.jpg \
  --caption "real PROTEIN" chicken.jpg eggs.jpg steak.jpg salmon.jpg

# 9:16 grid with statue cutout (post D look)
python3 scripts/slideshow/render_grid_slide.py -o s2.jpg --ratio 9:16 \
  --caption "Why is my blood flow so good?" --cutout statue.png \
  chocolate.jpg watermelon.jpg pomegranate.jpg garlic.jpg

# box-style CTA caption
python3 scripts/slideshow/render_grid_slide.py -o cta.jpg --style box \
  --caption "get the 'Clear Food' app" a.jpg b.jpg c.jpg d.jpg
```
Options: `--cutout-height 0.5`, `--font path/to/TikTokSans.ttf`,
`--font-scale 0.07`. Order of images: top-left, top-right, bottom-left,
bottom-right.

Alternatively, put the captions on in the TikTok app itself (Classic font,
outline style). This keeps it 100% native, and the original creator very likely
certainly did that. The text is TikTok's own font.

### Step 4: The CTA slide
- Build the "store card" once in Canva/Figma (grey bg, app icon, name +
  "Download <App>", App Store badge, iPhone mockup). Then only swap the
  screenshot per post.
- Always scan **a food that appeared in the post** so the CTA feels like a
  payoff, not an ad.

### Step 5: Posting
- Post as a TikTok **photo carousel** (photo mode), with a trending or
  chill/phonk sound.
- Captions on screen do the work. Keep the description short and question-based
  ("would you eat this?") to bait comments.

---

## 6. Ready-to-use idea bank (same formulas, new topics)

| Formula | Slide captions |
|---|---|
| Contrast | "average gym bro breakfast" / "average greek grandpa breakfast" |
| Contrast | "20 year old in 2005" / "20 year old in 2025" |
| Myth-bust | "this isn't 'protein'" (bars, shakes) / "but this is." |
| Myth-bust | "your 'healthy' snack" / "actual healthy snack" |
| Category list | "real SNACKS" / "real DESSERTS" / "real DRINKS" |
| Category list | "foods for CLEAR SKIN" / "foods for JAWLINE" / "foods for HAIR" |
| Question | "Why is my skin so clear?" / "Why is my sleep so deep?" / "Why is my testosterone so high?" |
| Question | "How do I stay this lean?" / "How is my digestion so good?" |
| Meme | Minecraft foods × real foods: "golden carrots & steak", "cookies & cake" (bad edition) |
| Meme | "ancient greek diet" (statue + olives, figs, honey, lamb) |

---

## 7. Gaps and cautions

- **Slide 1 (the cover/hook) is missing** from all 5 zips. On these accounts
  slide 1 is usually the biggest hook text over a full-bleed image. Send it and
  it can be added here.
- Health claims stay *implied* (images + labels), never stated. Keep it that way.
  Explicit claims like "raw milk cures X" create a moderation and liability risk.
- If you promote your own app, swap the name and screenshots. Don't reuse the Clear Food
  branding or screenshots.
- Don't use real, identifiable people's photos for the "person" tile. Use
  AI-generated faces or licensed stock.
