# Content matrix: faceless 2×2 food-grid slideshows

The machine-readable version is `scripts/slideshow/content_matrix.json`, which this page mirrors.
Based on the teardown in `docs/slideshow-teardown-clear-food.md`.

**How to use it:** pick post IDs (e.g. "make Q01, M01 and C01"). Each row is a complete
slideshow: the captions, all 4 tiles per slide (TL, TR, BL, BR), the cutout overlay, the CTA
variant and the food scanned on the CTA slide.

Priority is a heuristic ranking (hook strength + comment bait + how closely it matches the
proven reference posts), **not measured performance data**. Treat the first 5 as the test batch.

---

## 1. Formula × format matrix

| Formula | Pattern | Content slides | Ratio | Photo look | Overlay | CTA | Proven in |
|---|---|---|---|---|---|---|---|
| **Humble-brag question** (`question`) | Why is my <body part/outcome> so <good adjective>?  (x2)  ->  CTA inside the same grid | 2 | 9:16 | Macro fill | Statue (back) | In-grid screenshot | post D (blood flow / eyes) |
| **Average X vs average Y** (`contrast`) | average <group A> <meal>  ->  average <group B> <meal>  ->  CTA | 2 | 3:4 | Casual phone | — | Store card | post A (american vs european) |
| **This isn't X / but this is.** (`mythbust`) | <this isn't healthy> (popular 'healthy' or junk foods)  ->  but this is.  ->  CTA | 2 | 3:4 | Casual phone | — | Phone in dark | post E (junk food vs steak, eggs, fruit) |
| **real <CATEGORY> list** (`category`) | real <CAT 1>  ->  real <CAT 2>  ->  real <CAT 3>  ->  CTA | 3 | 9:16 | Casual phone | — | Store card | post C (real PROTEIN / FATS / CARBS) |
| **Game-item meme pairing** (`sprite`) | <food> & <food> with real photo + pixel-art item icon on a diagonal  (x3)  ->  CTA | 3 | 3:4 | Casual phone | — | Store card | post B (eggs & milk / melon & tomatoes / apples & potatoes) |

### Why each formula works

- **Humble-brag question:** Reads as a flex, not advice. Viewers comment to ask what the foods do. The same statue on every slide makes it a recognisable series.
- **Average X vs average Y:** Group rivalry gets defensive comments from both sides. The bottom-left face tile turns 'food' into 'what you'll look like'.
- **This isn't X / but this is.:** Calls out foods people love or think are healthy, so the comments fill with people defending them. The facepalm statue on slide 1 is the punchline.
- **real <CATEGORY> list:** Built to be saved: a cheat-sheet people screenshot. The word 'real' implies everyone else is eating fake versions.
- **Game-item meme pairing:** Nostalgia hits gamers and stops the scroll. The implied joke ('eat like a block game character') makes it shareable.

## 2. Format dimensions (mix and match)

| Dimension | Options | Rule of thumb |
|---|---|---|
| **Ratio** | 3:4 (1080×1440) · 9:16 (1080×1920) | 3:4 for contrast, myth-bust and sprite posts. 9:16 for question and category posts, where the 2-line caption needs room. |
| **Photo look** | Macro fill · Casual phone · Pixel sprite | Macro = premium and graphic (pairs with the statue). Casual = relatable and real. Sprite = meme. Keep **one look per post**. |
| **Overlay** | None · Statue (back) · Statue (facepalm) · Face tile | Statue (back) on *every* slide of a question post. Facepalm only on the "bad" slide. Face tile always bottom-left (contrast) or top-left (myth-bust "good" slide). |
| **Caption** | Outline (white + black stroke) · Box (black on white) | Outline everywhere. Box only on the phone-in-dark CTA. 2–6 words, lowercase, one ALL-CAPS word max. |
| **Colour** | 3–4 different dominant colours per grid | Never two same-colour tiles side by side. |
| **CTA** | Store card · In-grid screenshot · Phone in dark | The scanned food must appear earlier in the post. Score is 85–97, shown as green "Good". |

## 3. Pairing rules (formula → which CTA)

| Formula | Best CTA | Why |
|---|---|---|
| Question | In-grid screenshot | Keeps the visual rhythm, so it doesn't feel like an ad |
| Myth-bust | Phone in dark | Feels like proof: "I scanned the good plate" |
| Contrast / Category / Sprite | Store card | Clean break after a list, with clear download intent |

---

## 4. Post bank (pick by ID)

### Q01 · Humble-brag question: testosterone  (priority 1)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my testosterone so high?** | raw oysters on crushed ice | bright orange egg yolks | raw red beef steak cubes | brazil nuts | Statue (back) |
| 2 | **Why is my energy so stable?** | fresh blueberries | rolled oats | roasted sweet potato cubes | raw salmon fillet slices | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Steak and eggs** at **94 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### Q02 · Humble-brag question: skin & hair  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my skin so clear?** | sliced avocado halves | fresh raspberries | baby spinach leaves | sliced cucumber | Statue (back) |
| 2 | **Why is my hair so thick?** | boiled eggs cut in half | shelled walnuts | sardines | pumpkin seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Avocado and eggs** at **92 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### M01 · This isn't X / but this is.: fake healthy foods  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't healthy** | an acai bowl overloaded with granola, syrup and chocolate | a supermarket granola bar | a giant sugary fruit smoothie in a plastic cup | flavoured fruit yogurt cups | Statue (facepalm) |
| 2 | **but this is.** | 👤 *good face* | a wooden board with steak slices and fried eggs | a big tray of fresh mixed fruit | plain greek yogurt with honey | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Steak, eggs and fruit plate** at **90 Good**

Description: *"sorry not sorry"* · #healthyfood #nutritiontips #wholefoods #diet #fyp

### Q03 · Humble-brag question: sleep & recovery  (priority 4)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my sleep so deep?** | halved kiwis | dark red cherries | raw almonds | pumpkin seeds | Statue (back) |
| 2 | **Why do I recover so fast?** | pineapple chunks | thick greek yogurt | seared beef steak slices | raw salmon fillet | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Kiwi and cherries** at **95 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### M02 · This isn't X / but this is.: protein products  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't protein** | a stack of wrapped protein bars | protein chips in a bag | protein cookies | a sugary protein cereal bowl | Statue (facepalm) |
| 2 | **this is.** | 👤 *good face* | a pan of fried eggs | a seared ribeye steak on a cutting board | grilled chicken breasts in a pan | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Ribeye steak** at **93 Good**

Description: *"sorry not sorry"* · #healthyfood #nutritiontips #wholefoods #diet #fyp

### Q04 · Humble-brag question: focus & mood  (priority 6)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my focus so sharp?** | fresh blueberries | dark chocolate pieces | shelled walnuts | sunny side up eggs | Statue (back) |
| 2 | **Why is my mood so good?** | ripe bananas | raw salmon fillet slices | baby spinach leaves | pumpkin seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Blueberries** at **97 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### C01 · Average X vs average Y: US vs Greece breakfast  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average american breakfast** | a stack of pancakes drowning in syrup | glazed donuts in a box | 👤 *weak face* | a breakfast sandwich in fast-food paper | — |
| 2 | **average greek breakfast** | greek yogurt with honey | olives and feta cheese | 👤 *good face* | fresh figs cut in half | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Greek yogurt and figs** at **95 Good**

Description: *"which one are you?"* · #healthyfood #diet #looksmax #mealideas #fyp

### Q05 · Humble-brag question: immune & blood flow  (priority 8)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I never get sick?** | halved oranges | peeled garlic cloves | fresh ginger root slices | sliced red bell peppers | Statue (back) |
| 2 | **Why is my blood flow so good?** | sliced red beetroot | dark chocolate pieces | watermelon cubes | pomegranate seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Mixed fruit bowl** at **96 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### M03 · This isn't X / but this is.: breakfast  (priority 9)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **stop eating this for breakfast** | a bowl of sugary colourful cereal | frosted toaster pastries | giant blueberry muffins | a glass of orange juice from a carton | Statue (facepalm) |
| 2 | **eat this instead.** | 👤 *good face* | steak and eggs on a plate | fresh berries in a bowl | sourdough toast with butter | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Steak and eggs** at **92 Good**

Description: *"sorry not sorry"* · #healthyfood #nutritiontips #wholefoods #diet #fyp

### Q06 · Humble-brag question: gut & lean  (priority 10)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my digestion so good?** | kefir in a glass | sauerkraut | halved kiwis | fresh ginger root | Statue (back) |
| 2 | **Why am I so lean?** | grilled chicken breast slices | fresh strawberries | steamed broccoli florets | boiled potatoes | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Chicken and potatoes** at **91 Good** (screenshot replaces the TR tile, statue stays)

Description: *"the answer is on your plate"* · #looksmax #healthyfood #nutrition #selfimprovement #fyp

### C02 · Average X vs average Y: gym bro vs grandpa protein  (priority 11)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym bro protein** | protein shake bottles | wrapped protein bars | 👤 *weak face* | processed deli ham slices | — |
| 2 | **grandpa protein** | a cast iron pan of fried eggs | sardines in a tin | 👤 *good face* | a slow cooked beef stew | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Fried eggs** at **90 Good**

Description: *"which one are you?"* · #healthyfood #diet #looksmax #mealideas #fyp

### M04 · This isn't X / but this is.: snacks  (priority 12)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **your 'healthy' snacks** | chocolate-coated rice cakes | fruit gummies | veggie straws | trail mix full of candy | Statue (facepalm) |
| 2 | **actual healthy snacks** | 👤 *good face* | sliced apples with peanut butter | a bowl of mixed nuts | cottage cheese with berries | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Apple and peanut butter** at **88 Good**

Description: *"sorry not sorry"* · #healthyfood #nutritiontips #wholefoods #diet #fyp

### L01 · real <CATEGORY> list: real snacks / sweets / drinks  (priority 13)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real SNACKS** | a bowl of mixed nuts | sliced apples | beef jerky strips | boiled eggs | — |
| 2 | **real SWEETS** | medjool dates | a honeycomb | dark chocolate pieces | fresh strawberries | — |
| 3 | **real DRINKS** | a glass of water with lemon | a glass of whole milk | a cup of green tea | fresh coconut water in a coconut | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Mixed nuts** at **89 Good**

Description: *"save this"* · #healthyfood #groceryhaul #nutrition #wholefoods #fyp

### C03 · Average X vs average Y: school lunch US vs Japan  (priority 14)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **school lunch in america** | a cafeteria tray with pizza slice and tater tots | chocolate milk cartons | 👤 *weak face* | chicken nuggets and fries on a tray | — |
| 2 | **school lunch in japan** | a bento tray with rice, grilled fish and vegetables | miso soup in a bowl | 👤 *good face* | fresh fruit slices on a small plate | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Grilled fish and rice** at **93 Good**

Description: *"which one are you?"* · #healthyfood #diet #looksmax #mealideas #fyp

### L02 · real <CATEGORY> list: foods for goals  (priority 15)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **foods for CLEAR SKIN** | sliced avocado | fresh blueberries | raw salmon fillet | sliced cucumbers | — |
| 2 | **foods for MUSCLE** | seared steak slices | fried eggs | grilled chicken breast | greek yogurt | — |
| 3 | **foods for SLEEP** | halved kiwis | cherries | a glass of warm milk | almonds | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Salmon and avocado** at **96 Good**

Description: *"save this"* · #healthyfood #groceryhaul #nutrition #wholefoods #fyp

### S01 · Game-item meme pairing: survival-mode foods  (priority 16)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **steak & carrots** | a seared steak on a cutting board | 🟫 *pixel cooked steak* | 🟫 *pixel carrot* | fresh carrots with green tops | — |
| 2 | **bread & honey** | a crusty sourdough loaf | 🟫 *pixel bread loaf* | 🟫 *pixel honey bottle* | a jar of golden honey | — |
| 3 | **salmon & berries** | a cooked salmon fillet | 🟫 *pixel cooked salmon fish* | 🟫 *pixel sweet berries* | a bowl of fresh red berries | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Salmon fillet** at **94 Good**

Description: *"eat like it's survival mode"* · #minecraft #healthyfood #gamer #nutrition #fyp

### L03 · real <CATEGORY> list: ancient diets  (priority 17)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **ancient GREEK diet** | green olives | fresh figs | a jar of honey | grilled lamb chops | — |
| 2 | **ancient ROMAN diet** | crusty bread loaf | bunches of grapes | a wedge of hard cheese | grilled fish | — |
| 3 | **ancient SPARTAN diet** | a dark pork and lentil stew | barley grains | roasted wild boar meat | goat cheese | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Lamb chops** at **90 Good**

Description: *"save this"* · #healthyfood #groceryhaul #nutrition #wholefoods #fyp

### S02 · Game-item meme pairing: survival-mode foods 2  (priority 18)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **baked potatoes & beetroot** | baked potatoes with butter | 🟫 *pixel baked potato* | 🟫 *pixel beetroot* | fresh beetroots | — |
| 2 | **chicken & mushroom stew** | a roast chicken | 🟫 *pixel cooked chicken leg* | 🟫 *pixel mushroom stew bowl* | a bowl of mushroom stew | — |
| 3 | **pumpkin pie & cookies** | a pumpkin pie | 🟫 *pixel pumpkin pie* | 🟫 *pixel chocolate chip cookie* | chocolate chip cookies | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Baked potato** at **82 Good**

Description: *"eat like it's survival mode"* · #minecraft #healthyfood #gamer #nutrition #fyp

---

## 5. Building new rows

Copy any row and change one variable at a time (topic, foods, or caption).
Keep the formula, ratio, look and CTA the same. When a post outperforms, make 3 variants
of it before trying a new formula. That's how the reference channel works: same
format, rotating foods.
