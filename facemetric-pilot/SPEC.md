# facemetric-pilot: format spec v2 (matched to the reference reels)

This replaces sections 2, 3 and 5 of the original pilot brief. v1 described the look from memory; v2 is measured off
the three @facemetricai reels in `reference/` (moustache 7696478528707054880, 372K views; jaw ladder 7697699922719591713;
cleft chin 7696107281934503201, 370K views). Where v1 and the reels disagree, the reels win. Numbers are at
1080x1920 (the downloads are 576x1024, scaled x1.875).

Status column: **built** = in `src/` now, **todo** = needed for R04/R05/R06+ and not built yet.

---

## 1. What changed from v1

| v1 said | The reels do | Why it matters |
|---|---|---|
| Background `#DCE8F3` light blue, 2% vignette | `#9CADBB` muted blue-grey, no vignette; photo backgrounds are the same colour so photos bleed into the canvas | v1 colour made every frame look like a different brand |
| One caption, white Inter 800 with navy outline, top **or** bottom | Two text layers: a **headline** at the top (condensed, navy) and **subtitles** at the bottom (voice-synced, 1-3 words, spoken word on a yellow box) | Subtitles carry the voice; the headline carries the section |
| Photo always in a 900 px card | Default is **full-bleed** (photo spans the width, sits on the bottom edge). Cards only for profile views, comparisons and "zoomed" moments | Full-bleed is what reads as the house look |
| 6 px navy measure line, 24 px ticks | Thin **white** line, small ticks, **teal end dots** with white ring | Navy disappears on hair and dark clothes |
| Rounded-rectangle "box" on brows | **Corner brackets** (viewfinder) | |
| Chips: 40 px white pill, navy text | Two kinds: **label chips** stacked above the photo with a teal ✓ badge ("LONG UPPER LIP ✓"), and **small chips** on the face (MATCH, WIDER, DEEP SPLIT) with a navy outline | |
| Split labels above each card | Labels sit **inside the bottom** of each card; active card has a teal border, the other dims | |
| Grid payoff labels under the cards with arrows | Labels inside the card bottoms; the payoff row gets **teal / purple rings**; "+ MOUSTACHE" pill between the rows | |
| Circular inset 420 px | Ladder uses a **rounded-square inset** (chin close-up) at the right, with the value above and the level pill below | |
| Black turtleneck, every face | Plain crew neck (dark green, grey) or dark suit; constant **per face**, never mixed within a reel | Turtleneck is a Reel Factory rule, not the reference look |
| 25-35 cuts/min | 29 visible changes/min (contrast), 23 (deep-dive), 13 (ladder); only 8-10/min are full-frame cuts, the rest are overlay or framing changes | v1 asked for 25-35 hard cuts, which is too many |
| 35-55 s for every reel | Contrast pair 45-55 s; ladder 35-40 s; deep-dive 100-120 s (the cleft reel is 118 s) | |
| Purple / teal / yellow keyword in the one caption | Headline keyword in **teal** (or purple on "creepy/too far"), subtitle keyword on a **yellow box** | |

---

## 2. Visual tokens (`src/theme.ts`)

| Token | Value | Status |
|---|---|---|
| Canvas | 1080x1920, 30 fps, `#9CADBB`; full-bleed beats repaint the canvas with the still's own background (sampled into `assets/<reel>/stills.json`) | built |
| Navy | `#0B1F3A` (headline, chip text and outline) | built |
| Teal | `#10738F` headline keyword; `#1A93B0` ✓ badge, end dots, active-card border | built |
| Purple | `#7C3AED` negative keyword, "creepy" tint, negative ring | built |
| Yellow | `#FACC15` subtitle box, metric highlight | built |
| Headline font | Anton (bundled), navy, 3 px white outline, 104 px for <= 4 words, 72 px for a long persistent header (ladder) | built (104); todo (72 px header variant) |
| Headline highlight | teal text; **variant**: white text on a teal box (ladder header "JAW PROJECTION") | built (text); todo (box) |
| Subtitle font | Montserrat 900, 62 px, white, 4 px navy outline + soft shadow; centre at y 1500 on full-bleed, inside the card bottom on card beats | built |
| Chip font | Montserrat 800, 34 px, 4 px navy outline, white fill; small chips at 80% | built |
| Card | radius 44, 8 px white border, shadow `0 18px 40px rgba(10,30,60,.22)` | built |
| Lines | white 5 px, 26 px ticks, 8 px teal end dots, draw-on over 10 frames, drop shadow | built |
| Footer | "AI-edited images", Montserrat 700 26 px, **white** 65% (navy is invisible on dark clothes) | built |
| Music | none in the pilot (the reels use a quiet electronic bed) | — |

**Stills (house prompt v2).** "Photorealistic studio portrait of one <man|woman>, age <N>, <face>, front-facing, centred, head and
shoulders, <plain dark crew neck | grey crew neck | dark suit>, flat light dusty blue-grey seamless background (#9CADBB), soft
even front light, 85mm, neutral expression, no text." Keep wardrobe and background identical across all stills of one face.
Profile: "in exact side profile facing left" (ladder faces face right in the reference; either works, keep it constant in a reel).

---

## 3. Beat grammar (the format)

A reel is a list of **beats**. One beat = one voice sentence = one shot or framing. Inside a beat, things appear on a
fixed stagger: headline + first subtitle at frame 0, first line at 6, its chip at 14, every further anim 9 frames later.

### 3.1 Rules every reel must follow

1. **Hook in beat 1, answer in the last beat.** Beat 1's headline is the question; the last beat's headline repeats or
   resolves it (`BETTER OR CREEPY?`, `SOFT CLEFT WINS`).
2. **Headlines are section titles, not transcripts.** <= 4 words (hook up to 9). The same headline stays on 2-4
   consecutive beats; change it when the section changes. The voice is in the subtitles, so the headline never
   repeats the sentence.
3. **One highlighted word or phrase per headline**, marked `**like this**`.
4. **Voice:** one sentence per beat, 6-16 words, no sentence longer than ~3.5 s at 1.15x speed.
5. **Something changes on screen at least every 2.5 s.** A beat longer than 2.5 s needs an anim, a `then` step,
   or a framing change. Target 25-30 visible changes/min for contrast reels, 20-25 for deep-dives, 12-15 for ladders.
6. **Full-frame cuts 8-12/min.** Alternate full-bleed, card and split framings; do not run more than 3 full-bleed
   beats of the same still in a row without a zoom change.
7. **Every claim is drawn.** A beat that names a feature (upper lip, brows, jaw) puts a line, brackets, dots or a
   label chip on that feature.
8. **Labels > sentences on screen.** Chips are 1-3 words (`LONG UPPER LIP`, `NO MATCH`, `DEEP SPLIT`).
9. **Positive = teal, negative = purple, metric = yellow.** Applies to headline keyword, chip outline / ✓, payoff ring and tint.
10. **Same face, same pose, only the trait changes** between comparison stills (QA-checked).
11. **Footer "AI-edited images" on every frame.** Celebrity reels add "Photos: Wikimedia Commons" to the post caption.

### 3.2 Templates

**C - Contrast pair (45-55 s, 16-18 beats).** Reference: moustache.
| # | Section | Headline (example) | Framing | Graphics |
|---|---|---|---|---|
| 1-2 | Hook | `WHY DO SOME MEN LOOK **BETTER WITH ONE?**` / `WHILE OTHERS JUST LOOK **CREEPY?**` | full-frame close-up of face A, then B; push between | underline on the keyword; purple tint on B |
| 3-4 | Metric | `THE **UPPER LIP**` / `FROM THE **SIDE**` | card (front), card (profile) | measure line + label chip ✓; profile dotted contour + 2 label chips ✓ |
| 5-7 | Pick your shape | `PICK YOUR **SHAPE**` (held 3 beats) | split, active side moves | in-card labels, one line on the active side |
| 8-11 | What suits it | `THICK, DARK **BROWS?**` / `LOOKS **DELIBERATE**` | full-bleed, zoom varies | brackets, line + MATCH, width line + WIDER, jaw dots |
| 12 | Too far / neglected | `KEEP IT **TIDY**` | split (or one face split down the middle), `then` switches side | small purple chips on the bad side |
| 13-16 | Counter-example | `SHORT **UPPER LIP?**` / `TO THE **MIDDLE**` | face B full-bleed | line, brackets + NO MATCH, dots, circle; purple tint |
| 17-18 | Payoff | `**BETTER** OR CREEPY?` | 2x2 grid; last beat reveals rings + payoff labels | column labels, row pill |

**A - Ladder (35-40 s, 8-9 beats).** Reference: jaw projection.
- One persistent 2-line header for the whole reel (72 px, keyword on a teal box): `HERE IS WHAT DIFFERENT LEVELS OF **JAW PROJECTION** LOOK LIKE`.
- Same face, same full-bleed profile framing on every level; **no hard cuts**. The change per beat is the still itself (the edit level) plus the inset.
- Per level: value text above the inset (`-12MM`, Anton, navy, no pill), level pill below it (`SEVERELY RECESSED`),
  `AGE 28` pill bottom-left of the face, rounded-square inset (chin close-up, 2x) at the right.
- Middle levels (balanced, +/- mild) draw the dashed jaw contour.
- One citation card when a study is named (`ONE STUDY / ON MEN: THE PREFERRED PROFILE`).
- Close: 7-up strip with level labels, voice asks "Comment where you sit."

**B - Deep-dive (90-120 s, 25-35 beats).** Reference: cleft chin.
- Section headers are short and change often: `SMOOTH CHIN` (navy) then `CLEFT CHIN` (teal) as a pair,
  `DEEPER =`, `IT DEPENDS`, `SOFT CLEFT **WINS**`. Some beats drop the headline and put a top chip instead (`TWO HALVES`, `READS WIDER`).
- Uses tight crops in cards (chin only), full-bleed faces, a second face for "natural" examples.
- Extra graphics: **arc gauge** (arc above the head, a dot that slides to a chip: `IDEAL?`, `SOFT, DEFINED`),
  **citation card** (`THAYER AND DOBSON, 2010` / `American Journal of Physical Anthropology`), **pointer chips** with a
  leader line (`DEEP SPLIT`, `NOTCHED EDGE`), **ellipse** around a region, **midline** vertical line,
  **paired circle close-ups** (parent / parent / child).
- Ends on the hook question and the rule: `SMOOTH OR **CLEFT?**` then `SOFT CLEFT **WINS**`.

**Q - Quiz (40-50 s).** Not in the references; keep v1's outline (split hook "CUTE EYES OR **HOT** EYES?", measured
differences on each side, "if you said X you probably like...", payoff "neither is better, which one are you?") but use
the C-template graphics. The cleft reel's opening ("IF YOU SAID SMOOTH CHIN YOU PROBABLY LIKE A SOFTER, CLEANER LOOK")
is the model for the "if you said" beat.

### 3.3 Graphic vocabulary

| Graphic | Script | Status |
|---|---|---|
| Measure line (white, ticks, teal end dots) + optional small chip | `{"t":"measure","from","to","chip"}` | built |
| Label chip with ✓, stacked above the photo | `{"t":"chip","text"}` (no `at`) | built |
| Small chip on the face | `{"t":"chip","at","text"}` | built |
| Corner brackets | `{"t":"box","from","to","chip"}` | built |
| Dotted path (jaw, profile contour) | `{"t":"dots","path"}` | built |
| Circle | `{"t":"circle","at","r"}` | built |
| Split with in-card labels, active border, dimmed side | `"imgs":[a,b],"labels","active"` | built |
| 2x2 grid, row pill, payoff rings | `"grid"`, `"row"`, `"arrows":true` (reveal) | built |
| Purple / teal tint | `"tint"` | built |
| Hook underline | `"underline":true` | built |
| Full-frame close-up | `"view":"closeup","focus","zoom"` | built |
| Circular inset (2x) | `"inset":{"at","label"}` | built (circle) |
| Rounded-square inset + value + level pill + AGE pill (ladder) | `"inset":{"at","label","value","shape":"square"}`, `"age"` | todo |
| Header variant (72 px, keyword on teal box, persistent) | `"header"` on the script | todo |
| Arc gauge | `{"t":"gauge","pos","chip"}` | todo |
| Citation card | `{"t":"cite","title","source"}` | todo |
| Pointer chip with leader line | `{"t":"pointer","at","to","text"}` | todo |
| Ellipse | `{"t":"ellipse","at","rx","ry"}` | todo |
| Paired circle close-ups | `"layout":"circles"` | todo |
| One face split down the middle (trimmed / neglected) | `"layout":"halves"` | todo |
| Close-up -> full face inside one beat | `then.view` | todo |

---

## 4. Script schema (current, enforced by zod in `src/schema.ts`)

```jsonc
{
  "id": "R01", "template": "C", "title": "optional",
  "faces":  { "A_base": "assets/R01/A_base.jpg", ... },
  "stills": { "A_base": {"base": "man, age 38, <face>"}, "A_mustache": {"from": "A_base", "edit": "<change>"} },
  "beats": [{
    "img": "A_mustache" | "imgs": [..] | "grid": [[still, label, tone?] x4],
    "layout": "single" | "split" | "grid2x2" | "strip",
    "view": "front" | "profile" | "closeup", "focus": point, "zoom": 1.5,
    "card": true,                     // single: rounded card instead of full-bleed
    "caption": "THE **UPPER LIP**",   // headline (always top)
    "hl": "teal" | "purple" | "yellow",
    "underline": true, "subs": true, "tint": "purple",
    "vo": "One sentence, 6-16 words.",
    "anim": [ ... see 3.3 ... ],
    "inset": {"at": point, "label": "-12MM"},
    "labels": ["PENCIL", "CHEVRON"], "active": 0, "row": "+ MOUSTACHE", "arrows": true,
    "then": {"at": 0.45, "active": 1, "caption": "...", "hl": "...", "anim": [...]},
    "transition": "cut" | "push" | "flash"
  }]
}
```
Points are `[x, y]` (0-1 on the still), a landmark name (`"subnasale"`), or `["name", dx, dy]`.
Removed in v2: `captionPos` (the headline is always top; the voice is in the subtitles).

---

## 5. Checks (`lintScript`, run on every tool and on render)

Hard errors: unknown keys, unknown face keys, layout not matching img/imgs/grid.
Warnings: headline > 4 words (hook > 9), no `**highlight**`, vo outside 6-16 words, beat count outside the template
range, a headline used on more than 4 consecutive beats, more than 3 full-bleed beats of one still in a row without a
zoom change, a beat > 2.5 s with no anim / `then` (needs `timing.json`, checked by `tools/tts.ts`).
