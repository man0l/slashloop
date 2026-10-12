# Content matrix: faceless softmaxxing slideshows

The machine-readable version is `scripts/slideshow/content_matrix.json`, which this page mirrors.
Based on the teardown in `docs/slideshow-teardown-clear-food.md`.

**Audience:** softmaxxers, i.e. people doing the safe, habit-based side of looksmaxxing: diet, workouts,
skincare, face and jaw, posture, grooming, sleep. Many are TikTok creators who post their own
progress. Food is **one pillar out of ten**. The account should feel like it covers their
whole day.

**How to use it:** pick post IDs (e.g. "make SK01, FJ01 and DH01"). Each row is a complete
slideshow: captions, all 4 tiles per slide (TL, TR, BL, BR), the overlay, the CTA variant and the
app screen the CTA should show. App slides say `<APP>`; that gets swapped for your app at build time.

Priority is a heuristic within each pillar (hook strength + comment bait + closeness to the
proven reference posts), **not measured performance data**. Formulas marked ⚗️ are new formats
extrapolated from the proven ones. They're untested, so test them before you scale them.

---

## 1. Content pillars

| Pillar | Suggested mix | Angle | Best formulas | Posts |
|---|---|---|---|---|
| **Food & diet** | 15% | food -> looks (skin, jaw, body fat) | question, mythbust, contrast, category, sprite | 18 |
| **Skin** | 15% | clear skin, glow, acne, SPF, simple routines | question, mythbust, category | 10 |
| **Face & jawline** | 15% | definition through body fat, de-bloating, sleep, chewing, posture | question, mythbust | 10 |
| **Body & gym** | 15% | V-taper, shoulders, neck, the 'looks better in clothes' lifts | category, question, contrast | 10 |
| **Posture** | 5% | standing taller, desk setup, anti-slouch habits | contrast, question | 10 |
| **Hair, teeth, eyes & grooming** | 10% | haircare, brows, oral care, under-eyes | category, mythbust, question | 10 |
| **Sleep & discipline** | 10% | sleep, mornings, dopamine, consistency | routine, contrast, mythbust | 10 |
| **Style & scent** | 5% | basics that look expensive, scent, accessories | category, contrast | 10 |
| **Progress & creator** | 5% | glow-up arcs, progress pics, tracking | progress, category, question | 10 |
| **Documenting the journey (creator humor)** | 10% | self-aware joke: softmaxxers spend more time filming, editing and posting the glow-up than actually doing it. Relatable for the creators in the audience, very shareable | category, contrast, progress, question, routine | 10 |

At 1 post/day, the mix works out to roughly 1 food, 1 skin, 1 face, 1 gym, 1 creator-humor and 1 habits/progress post per week, with posture, style and grooming rotating in.

**Creator humor direction:** the joke is that softmaxxers spend more time filming, editing and
posting their glow-up than actually doing it. Use the *same* serious visual system (grids, statue,
outline captions) and let the captions deliver the punchline. Keep it self-aware ("us"), never
mocking a specific creator. These should be the most shareable posts in the matrix, because
creators send them to each other.

## 2. Formula × format matrix

| Formula | Pattern | Content slides | Ratio | Photo look | Overlay | CTA | Origin |
|---|---|---|---|---|---|---|---|
| **Humble-brag question** (`question`) | Why is my <body part/outcome> so <good adjective>?  (x2)  ->  CTA inside the same grid | 2 | 9:16 | Macro fill | Statue (back) | In-grid screenshot | post D (blood flow / eyes) |
| **Average X vs average Y** (`contrast`) | average <group A> <meal>  ->  average <group B> <meal>  ->  CTA | 2 | 3:4 | Casual phone | — | Store card | post A (american vs european) |
| **This isn't X / but this is.** (`mythbust`) | <this isn't healthy> (popular 'healthy' or junk foods)  ->  but this is.  ->  CTA | 2 | 3:4 | Casual phone | — | Phone in dark | post E (junk food vs steak, eggs, fruit) |
| **real <CATEGORY> list** (`category`) | real <CAT 1>  ->  real <CAT 2>  ->  real <CAT 3>  ->  CTA | 3 | 9:16 | Casual phone | — | Store card | post C (real PROTEIN / FATS / CARBS) |
| **Game-item meme pairing** (`sprite`) | <food> & <food> with real photo + pixel-art item icon on a diagonal  (x3)  ->  CTA | 3 | 3:4 | Casual phone | — | Store card | post B (eggs & milk / melon & tomatoes / apples & potatoes) |
| **Routine grid** ⚗️ (`routine`) | softmaxxer <morning/night/sunday> routine: 4 tiles = 4 steps, read left to right (x2)  ->  CTA | 2 | 9:16 | Moody dark | — | Store card | derived: the category-list visual applied to a daily routine |
| **Day-N progress checkpoints** ⚗️ (`progress`) | day 1  ->  day 30  ->  day 90: the grids get cleaner and more disciplined, and the statue tile stays constant  ->  CTA | 3 | 3:4 | Casual phone | — | Phone in dark | derived: the contrast formula stretched over time, for progress-posting creators |

### Why each formula works

- **Humble-brag question:** Reads as a flex, not advice. Viewers comment to ask what the foods do. The same statue on every slide makes it a recognisable series.
- **Average X vs average Y:** Group rivalry gets defensive comments from both sides. The bottom-left face tile turns 'food' into 'what you'll look like'.
- **This isn't X / but this is.:** Calls out foods people love or think are healthy, so the comments fill with people defending them. The facepalm statue on slide 1 is the punchline.
- **real <CATEGORY> list:** Built to be saved: a cheat-sheet people screenshot. The word 'real' implies everyone else is eating fake versions.
- **Game-item meme pairing:** Nostalgia hits gamers and stops the scroll. The implied joke ('eat like a block game character') makes it shareable.
- **Routine grid ⚗️:** Creators copy routines, and 'what's your routine' comments bait replies. The moody look signals discipline and is a different look from the food posts.
- **Day-N progress checkpoints ⚗️:** Glow-up arcs are the native story of the niche, and the follow-to-see-day-180 tension gets follows. Faceless, so viewers project themselves onto it.

## 3. Coverage grid: pillar × formula (post IDs)

| Pillar | Humble-brag question | Average X vs average Y | This isn't X / but this is. | real <CATEGORY> list | Game-item meme pairing | Routine grid | Day-N progress checkpoints |
|---|---|---|---|---|---|---|---|
| **Food & diet** | Q01, Q02, Q03, Q04, Q05, Q06 | C01, C02, C03 | M01, M02, M03, M04 | L01, L02, L03 | S01, S02 | · | · |
| **Skin** | SK01, SK05, SK10 | SK04 | SK02, SK06 | SK03, SK07 | · | SK08 | SK09 |
| **Face & jawline** | FJ01, FJ05, FJ10 | FJ03, FJ09 | FJ02, FJ06 | FJ04 | · | FJ08 | FJ07 |
| **Body & gym** | GY02, GY09 | GY03, GY04, GY10 | GY05 | GY01, GY06 | · | GY07 | GY08 |
| **Posture** | PO02, PO05 | PO01, PO07, PO10 | PO03, PO09 | PO04 | · | PO06 | PO08 |
| **Hair, teeth, eyes & grooming** | HG01, HG05, HG08 | HG04 | HG02, HG06 | HG03, HG10 | · | HG07 | HG09 |
| **Sleep & discipline** | DH05, DH10 | DH01, DH07 | DH03, DH08 | DH06 | · | DH02, DH04, DH09 | · |
| **Style & scent** | ST05 | ST02, ST03, ST09 | ST06 | ST01, ST04, ST08 | · | ST07 | ST10 |
| **Progress & creator** | PG03, PG06, PG10 | PG07 | PG04 | PG02, PG09 | · | PG05 | PG01, PG08 |
| **Documenting the journey (creator humor)** | CR05 | CR03, CR07, CR10 | CR06 | CR01, CR08 | · | CR04, CR09 | CR02 |

Empty cells (·) are open slots. Copy a row from the same column and swap the subjects to fill them.

## 4. Format dimensions (mix and match)

| Dimension | Options | Rule of thumb |
|---|---|---|
| **Ratio** | 3:4 (1080×1440) · 9:16 (1080×1920) | 3:4 for contrast, myth-bust, sprite and progress posts. 9:16 for question, category and routine posts, where the 2-line caption needs room. |
| **Photo look** | Macro fill · Casual phone · Moody dark ⚗️ · Pixel sprite | Macro = premium (pairs with the statue). Casual = relatable. Moody = discipline/routine. Sprite = meme. **One look per post.** |
| **Tiles** | Subject photo · 👤 face · 🗿 statue tile · 🟫 pixel sprite | Non-food pillars need objects people *use* (products, gym kit, bedroom setup), not faces. That keeps the account faceless. The statue stands in for "the result". |
| **Overlay** | None · Statue (back) · Statue (facepalm) | Statue (back) on *every* slide of a question post. Facepalm only on the "bad" slide of a myth-bust. |
| **Face tile** | 👤 good / 👤 weak | Bottom-left on contrast posts, top-left on the myth-bust "good" slide. Always AI-generated, never a real person. |
| **Caption** | Outline · Box | Outline everywhere. Box only on the phone-in-dark CTA. 2–6 words, lowercase, one ALL-CAPS word max. |
| **Colour** | 3–4 different dominant colours per grid | Never two same-colour tiles side by side. Moody posts are the exception: keep all 4 dark. |
| **CTA** | Store card · In-grid screenshot · Phone in dark | The app screen must pay off the post's topic (skin post → skin score/routine, gym post → workout streak). |

## 5. Formula → CTA pairing

| Formula | Best CTA | Why |
|---|---|---|
| Question | In-grid screenshot | Keeps the visual rhythm, so it doesn't feel like an ad |
| Myth-bust, Progress ⚗️ | Phone in dark | Feels like proof: "here's my actual tracker" |
| Contrast, Category, Sprite, Routine ⚗️ | Store card | Clean break after a list, with clear download intent |

## 6. Topics to keep off the account

These get videos removed, suppressed or reported in this niche, and they're risky for a young audience:
- **Bone smashing**, hard mewing claims ("mewing changes your bone structure"), DIY face-slimming hacks
- **PEDs / SARMs / hormones**, finasteride or minoxidil dosing, any "stack" content
- **Extreme cuts**, water/sodium manipulation for "face gains", dehydration before photos
- Rating or mocking **real people's** faces/bodies, "looksmin" self-hate framing, and shirtless content that looks underage
- Medical promises ("cures acne", "fixes recession"). Keep claims *implied* by the images, as the reference posts do.

## 6b. Quality rules (learned from the first 15 slideshows)

1. One story per post that reads in 1 second without the caption: before/after, expectation/reality, a progression, or a punchline on the last slide.
2. Tiles must be desirable or identity-signalling, not a tool catalogue. Food works because it's visceral; dumbbells and floss aren't. Mix tools with result or scene tiles (statue, sunrise gym, made bed).
3. Every tile must be recognisable at thumbnail size without the caption. If you need the caption to understand a tile (spoons in a freezer, a foam mat), swap it.
4. No repeated subject inside a post (two ice tiles), and the CTA grid should not copy the previous slide.
5. One photo style per post. Macro for product/food, casual for scenes. Never macro for screens or furniture (they turn into abstract gradients).
6. Colour: 3-4 distinct dominant colours per grid. All-black gym gear and all-dark moody grids turn to mush at thumbnail size.
7. Captions: 2 balanced lines max, no single-word orphan on line 2. Keep the punchline word in CAPS.
8. The statue cut-out must not cover the two bottom tiles' subjects. Use it on question posts only, or make it a tile.
9. Faces: one stable face per post, never the same face across posts, and keep them believable (no flawless model gloss).
10. Slide 1 is the cover: it must carry the strongest hook, because it decides whether anyone swipes.

---

## 7. Post bank (pick by ID)

## Pillar: Food & diet

### Q01 · Humble-brag question: testosterone  (priority 1)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my testosterone so high?** | raw oysters on crushed ice | bright orange egg yolks | raw red beef steak cubes | brazil nuts | Statue (back) |
| 2 | **Why is my energy so stable?** | fresh blueberries | rolled oats | roasted sweet potato cubes | raw salmon fillet slices | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Steak and eggs** at **94 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### Q02 · Humble-brag question: skin & hair  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my skin so clear?** | sliced avocado halves | fresh raspberries | baby spinach leaves | sliced cucumber | Statue (back) |
| 2 | **Why is my hair so thick?** | boiled eggs cut in half | shelled walnuts | sardines | pumpkin seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Avocado and eggs** at **92 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### M01 · This isn't X / but this is.: fake healthy foods  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't healthy** | an acai bowl overloaded with granola, syrup and chocolate | a supermarket granola bar | a giant sugary fruit smoothie in a plastic cup | flavoured fruit yogurt cups | Statue (facepalm) |
| 2 | **but this is.** | 👤 *good face* | a wooden board with steak slices and fried eggs | a big tray of fresh mixed fruit | plain greek yogurt with honey | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Steak, eggs and fruit plate** at **90 Good**

Description: *"sorry not sorry"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### Q03 · Humble-brag question: sleep & recovery  (priority 4)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my sleep so deep?** | halved kiwis | dark red cherries | raw almonds | pumpkin seeds | Statue (back) |
| 2 | **Why do I recover so fast?** | pineapple chunks | thick greek yogurt | seared beef steak slices | raw salmon fillet | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Kiwi and cherries** at **95 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### M02 · This isn't X / but this is.: protein products  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't protein** | a stack of wrapped protein bars | protein chips in a bag | protein cookies | a sugary protein cereal bowl | Statue (facepalm) |
| 2 | **this is.** | 👤 *good face* | a pan of fried eggs | a seared ribeye steak on a cutting board | grilled chicken breasts in a pan | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Ribeye steak** at **93 Good**

Description: *"sorry not sorry"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### Q04 · Humble-brag question: focus & mood  (priority 6)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my focus so sharp?** | fresh blueberries | dark chocolate pieces | shelled walnuts | sunny side up eggs | Statue (back) |
| 2 | **Why is my mood so good?** | ripe bananas | raw salmon fillet slices | baby spinach leaves | pumpkin seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Blueberries** at **97 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### C01 · Average X vs average Y: US vs Greece breakfast  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average american breakfast** | a stack of pancakes drowning in syrup | glazed donuts in a box | 👤 *weak face* | a breakfast sandwich in fast-food paper | — |
| 2 | **average greek breakfast** | greek yogurt with honey | olives and feta cheese | 👤 *good face* | fresh figs cut in half | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Greek yogurt and figs** at **95 Good**

Description: *"which one are you?"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### Q05 · Humble-brag question: immune & blood flow  (priority 8)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I never get sick?** | halved oranges | peeled garlic cloves | fresh ginger root slices | sliced red bell peppers | Statue (back) |
| 2 | **Why is my blood flow so good?** | sliced red beetroot | dark chocolate pieces | watermelon cubes | pomegranate seeds | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Mixed fruit bowl** at **96 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### M03 · This isn't X / but this is.: breakfast  (priority 9)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **stop eating this for breakfast** | a bowl of sugary colourful cereal | frosted toaster pastries | giant blueberry muffins | a glass of orange juice from a carton | Statue (facepalm) |
| 2 | **eat this instead.** | 👤 *good face* | steak and eggs on a plate | fresh berries in a bowl | sourdough toast with butter | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Steak and eggs** at **92 Good**

Description: *"sorry not sorry"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### Q06 · Humble-brag question: gut & lean  (priority 10)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my digestion so good?** | kefir in a glass | sauerkraut | halved kiwis | fresh ginger root | Statue (back) |
| 2 | **Why am I so lean?** | grilled chicken breast slices | fresh strawberries | steamed broccoli florets | boiled potatoes | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, scanning **Chicken and potatoes** at **91 Good** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### C02 · Average X vs average Y: gym bro vs grandpa protein  (priority 11)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym bro protein** | protein shake bottles | wrapped protein bars | 👤 *weak face* | processed deli ham slices | — |
| 2 | **grandpa protein** | a cast iron pan of fried eggs | sardines in a tin | 👤 *good face* | a slow cooked beef stew | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Fried eggs** at **90 Good**

Description: *"which one are you?"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### M04 · This isn't X / but this is.: snacks  (priority 12)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **your 'healthy' snacks** | chocolate-coated rice cakes | fruit gummies | veggie straws | trail mix full of candy | Statue (facepalm) |
| 2 | **actual healthy snacks** | 👤 *good face* | sliced apples with peanut butter | a bowl of mixed nuts | cottage cheese with berries | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, scanning **Apple and peanut butter** at **88 Good**

Description: *"sorry not sorry"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### L01 · real <CATEGORY> list: real snacks / sweets / drinks  (priority 13)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real SNACKS** | a bowl of mixed nuts | sliced apples | beef jerky strips | boiled eggs | — |
| 2 | **real SWEETS** | medjool dates | a honeycomb | dark chocolate pieces | fresh strawberries | — |
| 3 | **real DRINKS** | a glass of water with lemon | a glass of whole milk | a cup of green tea | fresh coconut water in a coconut | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Mixed nuts** at **89 Good**

Description: *"save this"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### C03 · Average X vs average Y: school lunch US vs Japan  (priority 14)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **school lunch in america** | a cafeteria tray with pizza slice and tater tots | chocolate milk cartons | 👤 *weak face* | chicken nuggets and fries on a tray | — |
| 2 | **school lunch in japan** | a bento tray with rice, grilled fish and vegetables | miso soup in a bowl | 👤 *good face* | fresh fruit slices on a small plate | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Grilled fish and rice** at **93 Good**

Description: *"which one are you?"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### L02 · real <CATEGORY> list: foods for goals  (priority 15)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **foods for CLEAR SKIN** | sliced avocado | fresh blueberries | raw salmon fillet | sliced cucumbers | — |
| 2 | **foods for MUSCLE** | seared steak slices | fried eggs | grilled chicken breast | greek yogurt | — |
| 3 | **foods for SLEEP** | halved kiwis | cherries | a glass of warm milk | almonds | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Salmon and avocado** at **96 Good**

Description: *"save this"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### S01 · Game-item meme pairing: survival-mode foods  (priority 16)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **steak & carrots** | a seared steak on a cutting board | 🟫 *pixel cooked steak* | 🟫 *pixel carrot* | fresh carrots with green tops | — |
| 2 | **bread & honey** | a crusty sourdough loaf | 🟫 *pixel bread loaf* | 🟫 *pixel honey bottle* | a jar of golden honey | — |
| 3 | **salmon & berries** | a cooked salmon fillet | 🟫 *pixel cooked salmon fish* | 🟫 *pixel sweet berries* | a bowl of fresh red berries | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Salmon fillet** at **94 Good**

Description: *"eat like it's survival mode"* · #minecraft #healthyfood #softmaxxing #gamer #fyp

### L03 · real <CATEGORY> list: ancient diets  (priority 17)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **ancient GREEK diet** | green olives | fresh figs | a jar of honey | grilled lamb chops | — |
| 2 | **ancient ROMAN diet** | crusty bread loaf | bunches of grapes | a wedge of hard cheese | grilled fish | — |
| 3 | **ancient SPARTAN diet** | a dark pork and lentil stew | barley grains | roasted wild boar meat | goat cheese | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Lamb chops** at **90 Good**

Description: *"save this"* · #healthyfood #softmaxxing #looksmaxxing #nutrition #fyp

### S02 · Game-item meme pairing: survival-mode foods 2  (priority 18)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **baked potatoes & beetroot** | baked potatoes with butter | 🟫 *pixel baked potato* | 🟫 *pixel beetroot* | fresh beetroots | — |
| 2 | **chicken & mushroom stew** | a roast chicken | 🟫 *pixel cooked chicken leg* | 🟫 *pixel mushroom stew bowl* | a bowl of mushroom stew | — |
| 3 | **pumpkin pie & cookies** | a pumpkin pie | 🟫 *pixel pumpkin pie* | 🟫 *pixel chocolate chip cookie* | chocolate chip cookies | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, scanning **Baked potato** at **82 Good**

Description: *"eat like it's survival mode"* · #minecraft #healthyfood #softmaxxing #gamer #fyp

## Pillar: Skin

### SK01 · Humble-brag question: clear skin habits  (priority 1)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my skin so clear?** | a gentle facial cleanser bottle on a white bathroom sink | a tube of sunscreen on a sunny windowsill | a fresh white silk pillowcase on a bed | a tall glass of ice water | Statue (back) |
| 2 | **Why is my skin glowing?** | a glass bowl of ice water for a face dip | a vitamin C serum dropper bottle | a dark bedroom with blackout curtains at night | raw salmon fillet slices | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **skin score / skincare routine streak** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK04 · Average X vs average Y: average guy vs softmaxxer skincare  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average guy skincare** | a cracked dry bar of soap on a dirty sink | a crumpled damp towel on a bathroom floor | 👤 *weak face* | a greasy smudged phone screen | — |
| 2 | **softmaxxer skincare** | a minimal three-step skincare set on a white marble sink | a sunscreen tube in bright sunlight | 👤 *good face* | a fresh folded white towel | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **skin score / skincare routine**

Description: *"which one are you?"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK06 · This isn't X / but this is.: fake skincare hacks  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't skincare** | toothpaste dabbed on a fingertip | a squeezed lemon half | a jar of gritty walnut scrub | a bottle of alcohol hand sanitiser | Statue (facepalm) |
| 2 | **this is.** | 👤 *good face* | a sunscreen tube in sunlight | a serum dropper bottle | a white moisturiser jar | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **skincare routine**

Description: *"please stop"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK02 · This isn't X / but this is.: skin-ruining habits  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is ruining your skin** | a greasy smudged phone screen | a dirty old pillowcase | a steaming very hot shower | a harsh gritty face scrub | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | lukewarm water running from a bathroom tap | a fresh clean white pillowcase | a tube of sunscreen | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **skincare routine checklist**

Description: *"sorry not sorry"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK09 · Day-N progress checkpoints ⚗️: skin day 1 to day 90  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

**Slide 0 (cover):** **what 90 days of softmaxxing did to my skin**, over 🗿 *statue: young man's marble face split down the middle, left half rough and cracked, right half perfectly smooth, polished and glowing*

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **skin day 1** | a messy sink crowded with random products | a greasy fast-food bag | 🗿 *statue: young man's face carved from rough, cracked, pitted marble* | a phone glowing in bed at 2am | — |
| 2 | **day 30** | a minimal three-product skincare shelf | a tall glass of water | 🗿 *statue: the same young man's face, marble partly smoothed, fewer cracks* | a fresh pillowcase | — |
| 3 | **day 90** | a sunscreen tube in sunlight | a bowl of fresh berries | 🗿 *statue: the same young man's face carved from perfectly smooth, polished, glowing white marble* | a dark bedroom with blackout curtains | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **skin progress timeline**

Description: *"trust the process"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK05 · Humble-brag question: acne & oil  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why don't I get acne?** | a fresh white pillowcase on a bed | pumpkin seeds | a glass of iced green tea | a phone screen being wiped with a cloth | Statue (back) |
| 2 | **Why is my skin never oily?** | a clear gel cleanser bottle | blotting paper sheets | cucumber slices | an oil-free moisturiser jar | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **skin routine checklist** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK07 · real <CATEGORY> list: morning / night / weekly skin  (priority 6)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **skin routine: MORNING** | a gel cleanser bottle | a vitamin C serum dropper | a moisturiser jar | a sunscreen tube | — |
| 2 | **skin routine: NIGHT** | a cleansing balm jar | a retinol serum bottle | a thick night cream | a white silk pillowcase | — |
| 3 | **skin routine: WEEKLY** | a green clay mask in a bowl with a brush | an exfoliating toner bottle | a fresh pillowcase being changed | a frosty ice roller | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning / night routine planner**

Description: *"save this"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK08 · Routine grid ⚗️: 6am vs 11pm skin  (priority 8)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **skin at 6am** | cold water splashing in a sink at dawn | a gel cleanser on a dark bathroom shelf | a sunscreen tube by a window at sunrise | a glass of water with lemon | — |
| 2 | **skin at 11pm** | a cleansing balm on a dark sink | a serum dropper in low warm light | a silk pillowcase in a dark bedroom | a phone face-down in a drawer | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **skin routine streak**

Description: *"steal my routine"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK03 · real <CATEGORY> list: minimal routines  (priority 9)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real SKINCARE** | a plain white cleanser bottle | a plain moisturiser jar | a sunscreen tube | a clean folded white face towel | — |
| 2 | **real HAIRCARE** | a plain shampoo bottle | a wide-tooth wooden comb | a scalp massager brush | a white silk pillowcase | — |
| 3 | **real ORAL CARE** | an electric toothbrush | a dental floss container | a metal tongue scraper | a glass of water on a bathroom sink | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily routine checklist with streak**

Description: *"save this"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK10 · Humble-brag question: skin people notice  (priority 9)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why does my skin glow in photos?** | a frosty ice roller | a sunscreen tube | raw salmon slices | a tall glass of ice water | Statue (back) |
| 2 | **Why do people ask about my skin?** | a serum dropper bottle | a white silk pillowcase | halved kiwis | a dark quiet bedroom | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **skin score** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

## Pillar: Face & jawline

### FJ01 · Humble-brag question: jawline & definition  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my jawline so sharp?** | 🗿 *statue: sharp jawline side profile of a young man's head* | pieces of hard mastic chewing gum | a glass of water with lemon slices | a smooth green jade gua sha stone | — |
| 2 | **Why is my face never puffy?** | a glass bowl of ice water | a pillow on a neatly made bed in a dark room | a cup of green tea | a jump rope coiled on a gym floor | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **face / jawline score with progress chart** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ04 · real <CATEGORY> list: jaw / debloat / lean face  (priority 2)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **for a SHARP JAW** | hard mastic gum pieces | grilled chicken breast slices | a tall glass of water | a low-salt plate of steamed fish and vegetables | — |
| 2 | **for LESS BLOAT** | a glass bowl of ice water | ripe bananas | a cup of green tea | cucumber slices | — |
| 3 | **for a LEANER FACE** | a jump rope on a gym floor | running shoes on a pavement at sunrise | a bowl of fresh berries | boiled eggs | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **face routine**

Description: *"save this"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ03 · Average X vs average Y: average vs softmaxxer jaw habits  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average jaw routine** | pink bubble gum | a can of sugary soda | 👤 *weak face* | a phone glowing in bed at 2am | — |
| 2 | **softmaxxer jaw routine** | hard mastic gum pieces | a glass of water with lemon | 👤 *good face* | a dark bedroom with blackout curtains | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **jawline score**

Description: *"which one are you?"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ06 · This isn't X / but this is.: puffy face causes  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

**Slide 0 (cover):** **why your face is puffy every morning**, over a bowl of salty instant ramen at 3am lit only by a glowing phone screen in a dark room

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is making your face puffy** | salty instant ramen | beer cans on a coffee table | a late-night pizza box | a phone glowing in bed at 3am | Statue (facepalm) |
| 2 | **this de-puffs it.** | 👤 *good face* | a glass bowl of ice water | a cup of green tea | ripe bananas | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **debloat tracker**

Description: *"the 3am pizza is not your friend"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ05 · Humble-brag question: side profile & photos  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my side profile so clean?** | 🗿 *statue: perfect side profile of a young man's head with a sharp jawline* | a laptop raised to eye level on a stand | hard mastic gum pieces | a firm pillow on a made bed | — |
| 2 | **Why do I photograph so well?** | soft window light in a bright room | a phone on a tripod at eye level | a glass bowl of ice water | a jade gua sha stone | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **jawline score** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ02 · This isn't X / but this is.: jawline gadgets  (priority 6)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this won't fix your jawline** | a silicone jawline exerciser ball | a chin strap face slimming band | a vibrating face roller gadget | a face slimming V-line mask | Statue (facepalm) |
| 2 | **this will.** | 👤 *good face* | a lean high-protein meal of chicken, rice and vegetables | a dark bedroom at night with blackout curtains | running shoes on a pavement at sunrise | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **face score with body-fat and sleep goals**

Description: *"sorry not sorry"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ09 · Average X vs average Y: bloated vs sharp face diet  (priority 6)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **bloated face diet** | a fast-food burger and fries | a big cola cup with ice | 👤 *weak face* | a bag of salty chips | — |
| 2 | **sharp face diet** | a seared steak on a board | a bowl of fresh berries | 👤 *good face* | a tall glass of water | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **face score**

Description: *"which one are you?"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ07 · Day-N progress checkpoints ⚗️: jawline arc  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **jawline day 1** | a fast-food burger and fries | pink bubble gum | 🗿 *statue: young man's head side profile with a soft rounded jaw* | cans of soda | — |
| 2 | **day 60** | hard mastic gum pieces | a tall glass of water | 🗿 *statue: the same young man's head side profile, jaw more defined* | running shoes | — |
| 3 | **day 120** | a plate of steak and vegetables | a jump rope | 🗿 *statue: the same young man's head side profile with a razor-sharp chiselled jawline* | a dark bedroom at night | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **jawline progress timeline**

Description: *"day 180 next?"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ08 · Routine grid ⚗️: 10-minute face routine  (priority 8)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my 10 min morning face routine** | a glass bowl of ice water at dawn | a jade gua sha stone on a dark counter | hard mastic gum pieces | a sunscreen tube by a window | — |
| 2 | **my 10 min night face routine** | a cleanser on a dark sink | a gua sha with face oil in warm low light | a firm pillow in a dark bedroom | a phone in a drawer | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **face routine timer**

Description: *"steal my routine"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ10 · Humble-brag question: cheekbones & lean face  (priority 10)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do my cheekbones show?** | 🗿 *statue: young man's face three-quarter view with high sharp cheekbones* | grilled chicken breast slices | a tall glass of water | a rowing machine | — |
| 2 | **Why is my face so lean?** | a jump rope | a bowl of fresh berries | a cup of green tea | boiled eggs cut in half | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **face score** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

## Pillar: Body & gym

### GY04 · Average X vs average Y: what you train vs what looks good  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **you're training the wrong muscles**, over 🗿 *statue: marble bust of a muscular athlete seen from behind, cropped at the mid-back, very broad shoulders and wide upper back, cloth draped over the lower back, dramatic side light*

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **what you train** | a crowded flat bench press | dumbbells for bicep curls | 👤 *weak face* | an ab crunch machine | — |
| 2 | **what makes you look good** | light dumbbells for lateral raises | a pull-up bar | 👤 *good face* | a leather neck harness with a weight plate | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **workout plan for aesthetics**

Description: *"train for the mirror AND the street"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY09 · Humble-brag question: t-shirt physique  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I look good in a t-shirt?** | 🗿 *statue: broad muscular shoulders and back seen from behind* | light dumbbells for lateral raises | a pull-up bar | a folded fitted white t-shirt | — |
| 2 | **Why is my back so wide?** | a lat pulldown machine | a rowing machine | a pull-up bar | a plate of chicken and rice | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **workout plan** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY01 · real <CATEGORY> list: aesthetic lifts  (priority 3)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **for WIDE shoulders** | a pair of light dumbbells on a gym floor | a cable machine with a single handle | a barbell on an overhead press rack | a resistance band hanging from a rack | — |
| 2 | **for a THICK neck** | a leather neck harness with a weight plate | a weight plate resting on a flat bench | a thick resistance band | a padded gym mat | — |
| 3 | **for a V-TAPER** | a pull-up bar in a gym | a lat pulldown machine | a rowing machine | a loaded barbell on a deadlift platform | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **workout plan for aesthetics**

Description: *"save this"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY08 · Day-N progress checkpoints ⚗️: gym arc  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym day 1** | light dumbbells on an empty rack | a phone showing a workout tutorial | 🗿 *statue: slim skinny young athlete torso* | a tiny gym bag | — |
| 2 | **day 100** | a loaded barbell | a pull-up bar | 🗿 *statue: the same young athlete torso, visibly more muscular* | meal prep containers | — |
| 3 | **day 365** | a heavy loaded deadlift barbell | a leather neck harness | 🗿 *statue: the same young athlete, broad heroic muscular torso, V-taper* | worn-out training shoes | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **workout progress chart**

Description: *"day 1 is the hardest"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY05 · This isn't X / but this is.: fake aesthetic shortcuts  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this won't make you aesthetic** | a plastic ab roller gadget | a vibrating fat-burning belt | a sauna sweat suit | a tub of fat-burner powder | Statue (facepalm) |
| 2 | **this will.** | 👤 *good face* | a pull-up bar | light dumbbells for lateral raises | a plate of chicken, rice and vegetables | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **workout plan**

Description: *"sorry not sorry"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY06 · real <CATEGORY> list: no-gym training  (priority 5)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **no-gym SHOULDERS** | a resistance band on a door handle | two full water jugs | a backpack filled with books | a sturdy chair for dips | — |
| 2 | **no-gym BACK** | a doorframe pull-up bar | a towel looped around a door handle | a resistance band | a heavy backpack | — |
| 3 | **no-gym LEGS** | a flight of stairs | a wooden step box | a jump rope | a heavy backpack on a floor | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **home workout plan**

Description: *"save this"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY07 · Routine grid ⚗️: 5:45am gym routine  (priority 6)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **5:45am gym routine** | an alarm clock in a dark bedroom | a banana and a glass of water on a dark counter | an empty gym in blue morning light | a chalked barbell | — |
| 2 | **post-gym routine** | a high-protein meal of eggs and steak | a steaming shower | a foam roller on a mat | a dark bedroom at 10pm | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **workout streak**

Description: *"steal my routine"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY02 · Humble-brag question: gym consistency  (priority 7)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why are my shoulders so wide?** | 🗿 *statue: broad muscular shoulders and back seen from behind* | a pair of dumbbells on a gym floor | a cable machine | a pull-up bar | — |
| 2 | **Why do I never skip the gym?** | a packed men's gym bag by the front door | men's black gym t-shirt and shorts folded neatly on a bed | wireless headphones on a gym bench | an empty gym at 6am in early morning light | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **workout streak calendar** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY10 · Average X vs average Y: gym at 7pm vs 6am  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym at 7pm** | a crowded gym with every bench taken | a queue for the squat rack | 👤 *weak face* | a loud speaker on a gym floor | — |
| 2 | **gym at 6am** | an empty gym at sunrise | a free squat rack | 👤 *good face* | a quiet gym with morning light | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **workout streak**

Description: *"6am gym is a different world"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY03 · Average X vs average Y: gym bro vs softmaxxer  (priority 8)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym bro routine** | a protein shake bottle | a tub of pre-workout powder | 👤 *weak face* | cans of energy drinks | — |
| 2 | **softmaxxer routine** | a gym with dumbbells at sunrise | a minimal skincare shelf with three products | 👤 *good face* | a dark bedroom with blackout curtains | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **full daily routine (gym, skin, sleep)**

Description: *"which one are you?"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

## Pillar: Posture

### PO03 · This isn't X / but this is.: posture-ruining habits  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is ruining your posture** | a phone held low at chest level | a laptop on a lap on a couch | a heavy bag on one shoulder | a slouched gaming chair | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | a laptop on a stand at eye level | a backpack worn on both shoulders | a standing desk | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **posture routine**

Description: *"sorry not sorry"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO04 · real <CATEGORY> list: posture fixes  (priority 3)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **posture fix: DESK** | a monitor raised to eye level | an external keyboard on a clean desk | a lumbar support pillow on a chair | a small footrest under a desk | — |
| 2 | **posture fix: GYM** | a cable machine set up for face pulls | light dumbbells for rear-delt flyes | a pull-up bar for dead hangs | a foam roller | — |
| 3 | **posture fix: SLEEP** | a firm mattress | a thin pillow | a pillow between knees for side sleeping | a dark tidy bedroom | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **posture plan**

Description: *"save this"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO07 · Average X vs average Y: 8h gaming vs 8 weeks training  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **8 hours of gaming did this to your posture**, over 🗿 *statue: classical marble statue of a young man hunched forward over a desk in a gaming chair, forward head posture, lit by RGB gaming lights, side view*

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **after 8 hours of gaming** | a gaming chair with RGB lights at night | 👤 *weak face* | empty energy drink cans | a glowing gaming mouse | — |
| 2 | **after 8 weeks of training** | a pull-up bar | 👤 *good face* | a foam roller | a laptop on a stand at eye level | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **posture progress**

Description: *"which one are you?"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO01 · Average X vs average Y: gamer vs softmaxxer posture  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average gamer posture** | a gaming chair with an RGB desk setup at night | a laptop on an unmade bed | 👤 *weak face* | energy drink cans on a messy desk | — |
| 2 | **softmaxxer posture** | a laptop on a stand at eye level on a clean desk | a foam roller on a yoga mat | 👤 *good face* | a resistance band attached to a door frame | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **posture routine checklist**

Description: *"which one are you?"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO05 · Humble-brag question: confidence posture  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I look so confident?** | 🗿 *statue: upright young man, chest proud, shoulders back, side view* | a pull-up bar for dead hangs | a resistance band | a laptop at eye level | — |
| 2 | **Why does my neck look longer?** | a book balanced on a shelf at eye level | a doorframe for a chest stretch | a phone held up at eye level | a foam roller under a mat | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **posture score** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO06 · Routine grid ⚗️: 5-minute posture routine  (priority 6)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **5 min posture routine** | a pull-up bar in a doorframe | a doorframe in morning light | a foam roller on a mat | a resistance band | — |
| 2 | **desk posture routine** | a kitchen timer on a desk | a standing desk | a water bottle on a desk | a stretching strap | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily stretch timer**

Description: *"steal my routine"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO08 · Day-N progress checkpoints ⚗️: posture arc  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **posture day 1** | a slouched gaming chair | 🗿 *statue: young man standing hunched with forward head posture, side view* | a phone held at chest level | a laptop on a bed | — |
| 2 | **day 30** | a foam roller | 🗿 *statue: the same young man standing straighter, side view* | a laptop stand | a resistance band | — |
| 3 | **day 90** | a pull-up bar | 🗿 *statue: the same young man standing perfectly upright, chest proud, side view* | a standing desk | running shoes | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **posture timeline**

Description: *"day 180 next?"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO09 · This isn't X / but this is.: posture gadgets  (priority 8)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this won't fix your posture** | a posture corrector brace | a vibrating posture sensor gadget | an inflatable exercise ball as a chair | a neck massager gadget | Statue (facepalm) |
| 2 | **this will.** | 👤 *good face* | a cable machine set up for face pulls | a rowing machine | a pull-up bar | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **posture plan**

Description: *"sorry not sorry"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO10 · Average X vs average Y: how you sit vs how you should  (priority 9)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **how you sit** | a slumped sofa with a laptop | a laptop on an unmade bed | a high bar stool at a kitchen counter | a reclined gaming chair | — |
| 2 | **how you should sit** | an ergonomic office chair | a standing desk | a kneeling chair | a laptop on a stand with external keyboard | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **desk setup checklist**

Description: *"which one are you?"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO02 · Humble-brag question: standing taller  (priority 12)

`9:16` · Casual phone · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I look taller?** | 🗿 *statue: perfectly upright standing posture, side view* | a pull-up bar for dead hangs | a foam roller | a monitor raised to eye level | — |
| 2 | **Why don't I slouch anymore?** | a phone held up at eye level | a resistance band for face pulls | a yoga mat with stretching strap | a firm mattress with a thin pillow | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **posture score / daily stretch timer** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

## Pillar: Hair, teeth, eyes & grooming

### HG04 · Average X vs average Y: bathroom shelf identity  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **your bathroom shelf says a lot about you**, over a cluttered bathroom shelf with a 3-in-1 shampoo, an aerosol body spray can, a cracked bar of soap and an old razor

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average guy bathroom shelf** | a 3-in-1 shampoo bottle | an aerosol body spray can | a cracked bar of soap | an old rusty disposable razor | — |
| 2 | **softmaxxer bathroom shelf** | a minimal skincare set | an electric toothbrush | a beard trimmer | an unlabelled glass fragrance bottle | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **grooming checklist**

Description: *"your shelf says everything"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG08 · Humble-brag question: smell & hair compliments  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I smell so good?** | an unlabelled glass fragrance bottle | an unscented body lotion | freshly washed laundry | a stick deodorant | Statue (back) |
| 2 | **Why do people compliment my hair?** | a scalp massager brush | a white silk pillowcase | a tin of matte hair clay | an empty barber chair | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **grooming checklist** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG05 · Humble-brag question: brows & beard  (priority 3)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why are my brows so clean?** | an eyebrow trimmer | slanted tweezers | an eyebrow spoolie brush | a small pair of grooming scissors | Statue (back) |
| 2 | **Why is my beard line so sharp?** | a beard trimmer | white shaving foam | a safety razor | a beard oil dropper bottle | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **grooming checklist** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG06 · This isn't X / but this is.: teeth staining  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is yellowing your teeth** | a black coffee | a can of energy drink | a glass of cola | a cup of strong black tea | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | an iced coffee with a metal straw | an electric toothbrush | a glass of water | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **grooming checklist**

Description: *"sorry not sorry"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG09 · Day-N progress checkpoints ⚗️: grooming arc  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **grooming day 1** | an old rusty razor | 🗿 *statue: young man's head with messy overgrown marble hair and patchy stubble* | a cracked bar of soap | a crumpled towel | — |
| 2 | **day 30** | a beard trimmer | 🗿 *statue: the same young man's head with neater hair* | a minimal skincare set | an electric toothbrush | — |
| 3 | **day 90** | an empty barber chair | 🗿 *statue: the same young man's head with sharply sculpted short hair and a clean jawline* | an unlabelled fragrance bottle | a silk pillowcase | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **grooming timeline**

Description: *"day 180 next?"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG07 · Routine grid ⚗️: hair wash / no-wash day  (priority 6)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **hair routine: wash day** | a sulfate-free shampoo bottle | a conditioner bottle | a microfibre hair towel | a sea salt spray bottle | — |
| 2 | **hair routine: no-wash day** | a water spray bottle | a wide-tooth comb | a tin of matte hair clay | a scalp massager brush | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **haircare routine**

Description: *"steal my routine"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG10 · real <CATEGORY> list: nails, eyes, lips  (priority 7)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real NAIL CARE** | nail clippers | a glass nail file | a cuticle oil bottle | a hand cream tube | — |
| 2 | **real EYE CARE** | two metal spoons chilling in a freezer | a black sleep mask | an eye cream tube | classic black sunglasses | — |
| 3 | **real LIP CARE** | a lip balm | an SPF lip balm | a glass of water | a jar of honey | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **grooming checklist**

Description: *"save this"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG01 · Humble-brag question: smile & eyes  (priority 10)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my smile so bright?** | an electric toothbrush | a dental floss container | a glass of water | a reusable metal straw in an iced coffee | Statue (back) |
| 2 | **Why do my eyes look so awake?** | two metal spoons chilling in a freezer | sliced cucumber | a dark bedroom at night | a tall glass of ice water | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **grooming checklist** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG02 · This isn't X / but this is.: hair-killing habits  (priority 13)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is killing your hair** | a very hot steamy shower | a cheap 2-in-1 shampoo bottle | a hair dryer on maximum heat | a tight baseball cap | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | cool water running from a shower head | a scalp massager brush | a white silk pillowcase | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **haircare routine**

Description: *"sorry not sorry"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

### HG03 · real <CATEGORY> list: grooming kit  (priority 16)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real GROOMING kit** | an electric beard trimmer | small grooming scissors | a pair of tweezers | an eyebrow spoolie brush | — |
| 2 | **real SHOWER kit** | a plain body wash bottle | a gentle face cleanser | a plain shampoo | a clean folded white towel | — |
| 3 | **real NIGHT kit** | a moisturiser jar | a lip balm | a silk pillowcase | a sleep mask | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **routine checklist**

Description: *"save this"* · #groomingtips #softmaxxing #glowup #selfcare #fyp

## Pillar: Sleep & discipline

### DH01 · Average X vs average Y: average 19yo vs softmaxxer  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average 19 year old** | a phone glowing in a dark bed at 3am | energy drink cans | 👤 *weak face* | a fast-food bag on a messy desk | — |
| 2 | **19 year old softmaxxer** | an empty gym at sunrise | a minimal skincare shelf | 👤 *good face* | meal prep containers in a fridge | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **glow-up routine / streak**

Description: *"which one are you?"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH06 · real <CATEGORY> list: free / cheap / worth paying  (priority 1)

`9:16` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **free looksmaxxing nobody does**, over golden morning sunlight streaming through a bedroom window onto a made bed and a glass of water

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **FREE looksmaxxing** | morning sunlight on a street | a tall glass of water | a dark bedroom at night | a walking path in a park | — |
| 2 | **CHEAP looksmaxxing** | a sunscreen tube | hard mastic gum pieces | a resistance band | a carton of eggs | — |
| 3 | **worth PAYING for** | an empty barber chair | an electric toothbrush | a gym entrance at sunrise | a good firm mattress | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **routine planner**

Description: *"save this before your next paycheck"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH10 · Humble-brag question: discipline  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why am I so disciplined?** | a neatly made bed | gym clothes laid out the night before | meal prep containers in a fridge | a phone in a drawer | Statue (back) |
| 2 | **Why do I never doomscroll?** | a phone face-down in a drawer | an open book on a nightstand | an analog alarm clock | a journal and pen on a desk | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **habit tracker** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH02 · Routine grid ⚗️: morning & night routine  (priority 3)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer morning routine** | sunrise light through a bedroom window | a cold shower head running | a glass of water with lemon | running shoes by the door | — |
| 2 | **softmaxxer night routine** | a minimal skincare routine on a bathroom sink | an open book on a nightstand | a phone in a drawer | a dark bedroom with blackout curtains | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning / night routine planner**

Description: *"steal my routine"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH05 · Humble-brag question: energy & waking  (priority 3)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I wake up before my alarm?** | sunrise through a bedroom window | a dark bedroom with blackout curtains | a phone charging outside the bedroom | a glass of water on a nightstand | Statue (back) |
| 2 | **Why do I never feel tired?** | a morning walk on an empty street at sunrise | a tall glass of water | eggs and fruit for breakfast | an analog alarm clock set for 10pm | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **sleep tracker** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH07 · Average X vs average Y: weekend average vs softmaxxer  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average weekend** | an alarm clock showing 2pm in a messy room | beer cans on a table | 👤 *weak face* | a gaming setup at 4am | — |
| 2 | **softmaxxer weekend** | a sunrise hike trail | a farmers market stall with vegetables | 👤 *good face* | fresh sheets on a made bed | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **weekly planner**

Description: *"which one are you?"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH08 · This isn't X / but this is.: fake rest  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't rest** | doomscrolling a phone in bed at night | a TV glowing at 3am | energy drink cans | a 4-hour afternoon nap in a messy bed | Statue (facepalm) |
| 2 | **this is.** | 👤 *good face* | a walk in a green park | a dark bedroom at 10pm | an open book on a nightstand | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **sleep tracker**

Description: *"sorry not sorry"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH03 · This isn't X / but this is.: looks-lowering habits  (priority 6)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is lowering your looks** | doomscrolling a phone in bed at night | energy drink cans | beer cans on a coffee table | a messy unmade bed at noon | Statue (facepalm) |
| 2 | **this is raising them.** | 👤 *good face* | a sunrise walk on an empty street | a made bed in a bright room | a gym at 6am | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **habit tracker**

Description: *"sorry not sorry"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH09 · Routine grid ⚗️: 9pm shutdown & 6am start  (priority 6)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer 9pm shutdown** | a phone placed in a drawer | a skincare routine on a dark sink | an open book under a warm lamp | blackout curtains being closed | — |
| 2 | **softmaxxer 6am start** | sunrise through a window | a glass of water with lemon | a cold shower head running | a packed gym bag by the door | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **routine planner**

Description: *"steal my routine"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH04 · Routine grid ⚗️: sunday reset  (priority 11)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer sunday reset** | fresh clean bedsheets | meal prep containers with chicken and rice | a weekly planner notebook | laundry folded neatly | — |
| 2 | **softmaxxer sunday self-care** | a clay face mask bowl and brush | a beard trimmer | nail clippers on a towel | a foam roller | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **weekly planner**

Description: *"steal my routine"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

## Pillar: Style & scent

### ST06 · This isn't X / but this is.: looks cheap vs expensive  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

**Slide 0 (cover):** **why you look cheap (it's not the price)**, over a flat lay of a logo-heavy hoodie, dirty white sneakers and wrinkled baggy jeans on a bedroom floor

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this makes you look cheap** | a logo-heavy hoodie | dirty white sneakers | a wrinkled shirt | oversized baggy jeans | Statue (facepalm) |
| 2 | **this looks expensive.** | 👤 *good face* | a crisp white t-shirt | clean white leather sneakers | a simple silver watch | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **style checklist**

Description: *"it's not the price"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST03 · Average X vs average Y: fast fashion vs 5 pieces  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **fast fashion haul** | a pile of cheap polyester clothes | a logo-heavy hoodie | ripped skinny jeans | chunky dad sneakers | — |
| 2 | **5 pieces that work** | a crisp plain white t-shirt | a navy overshirt | dark straight-leg jeans | clean white leather sneakers | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **style checklist**

Description: *"which one are you?"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST04 · real <CATEGORY> list: outfit by occasion  (priority 3)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **outfit for the GYM** | a fitted black t-shirt | black training shorts | white crew socks | clean training shoes | — |
| 2 | **outfit for a DATE** | a white oxford shirt | dark straight-leg jeans | brown leather loafers | a minimal silver watch | — |
| 3 | **outfit for CLASS** | a grey crewneck sweater | beige chinos | white leather sneakers | a canvas backpack | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **outfit planner**

Description: *"save this"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST08 · real <CATEGORY> list: scent by season  (priority 4)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **scent for SUMMER** | an unlabelled citrus fragrance bottle with lemon slices | a white linen shirt | sunglasses on a beach towel | a glass of sparkling water | — |
| 2 | **scent for WINTER** | an unlabelled amber fragrance bottle with cinnamon sticks | a chunky wool sweater | a leather jacket | a lit candle | — |
| 3 | **scent for DATE NIGHT** | a dark glass fragrance bottle | a black shirt on a hanger | a minimal watch | a candlelit table | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **style checklist**

Description: *"save this"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST05 · Humble-brag question: put-together look  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I always look put together?** | a lint roller | a handheld clothes steamer | a sneaker cleaning kit | a fitted plain t-shirt on a hanger | Statue (back) |
| 2 | **Why do my clothes fit so well?** | a tailor's measuring tape and pins | an ironed white shirt | neatly folded dark jeans | a fitted navy t-shirt | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **style checklist** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST07 · Routine grid ⚗️: getting ready  (priority 6)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **getting ready routine** | a steaming shower | a minimal skincare set on a sink | a tin of matte hair clay | an unlabelled fragrance bottle | — |
| 2 | **outfit check** | a full-length mirror | a lint roller | freshly wiped white sneakers | a minimal silver watch | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **routine planner**

Description: *"steal my routine"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST09 · Average X vs average Y: new money vs old money  (priority 7)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **new money fit** | a flashy logo belt | a chunky gold chain | bright logo sneakers | a glossy logo cap | — |
| 2 | **old money fit** | a navy knitted polo | brown suede loafers | beige linen trousers | a simple leather-strap watch | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **style checklist**

Description: *"which one are you?"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST10 · Day-N progress checkpoints ⚗️: style arc  (priority 8)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **style day 1** | a pile of wrinkled hoodies | 🗿 *statue: young man's marble bust wearing a baggy hoodie* | dirty sneakers | a messy closet | — |
| 2 | **day 30** | a folded white t-shirt | 🗿 *statue: the same marble bust wearing a plain fitted white t-shirt* | dark jeans | clean white sneakers | — |
| 3 | **day 90** | a navy overshirt on a hanger | 🗿 *statue: the same marble bust wearing a tailored navy overshirt* | brown loafers | a minimal silver watch | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **style timeline**

Description: *"day 180 next?"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST01 · real <CATEGORY> list: look-expensive basics  (priority 14)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real WARDROBE** | a folded plain white t-shirt | dark straight-leg jeans | clean white leather sneakers | a black crewneck sweater | — |
| 2 | **real ACCESSORIES** | a minimal silver watch | a thin silver chain | a black leather belt | classic black sunglasses | — |
| 3 | **real SCENT** | an unlabelled glass fragrance bottle | an unscented body lotion | a stick deodorant | freshly washed laundry | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **style / outfit checklist**

Description: *"save this"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

### ST02 · Average X vs average Y: outfit contrast  (priority 17)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average guy outfit** | an oversized graphic hoodie | baggy grey sweatpants | 👤 *weak face* | worn-out dirty sneakers | — |
| 2 | **softmaxxer outfit** | a fitted plain white tee | dark straight-leg jeans | 👤 *good face* | clean white leather sneakers | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **style checklist**

Description: *"which one are you?"* · #mensstyle #softmaxxing #oldmoney #glowup #fyp

## Pillar: Progress & creator

### PG04 · This isn't X / but this is.: bad progress pics  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **your progress pics look like this** | a bathroom with harsh yellow overhead light | a dirty smudged mirror | a phone held too close at a low angle | a messy room in the background | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | soft window daylight in a clean room | a phone on a tripod at chest height | a clean bright mirror | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress photo guide**

Description: *"sorry not sorry"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG01 · Day-N progress checkpoints ⚗️: 90-day softmaxxing arc  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **day 1 of softmaxxing** | a messy bedroom at night lit by a phone | a fast-food bag | 🗿 *statue: young man's head looking down* | energy drink cans | — |
| 2 | **day 30** | a packed gym bag | a minimal skincare shelf | 🗿 *statue: young man's head looking straight ahead* | meal prep containers | — |
| 3 | **day 90** | an empty gym at sunrise | a made bed in a bright room | 🗿 *statue: young man's head looking up confidently, sharp jawline* | a fresh fruit and steak plate | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress timeline with photos**

Description: *"day 180 next?"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG07 · Average X vs average Y: what people see vs what it took  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **what people see** | a phone showing a selfie with many likes | 🗿 *statue: heroic young man's head looking up, sharp jawline* | a sunny beach | a sharp outfit on a hanger | — |
| 2 | **what it took** | a calendar full of checkmarks | 🗿 *statue: young man's head bowed, tired, determined* | an alarm clock at 5am | worn-out running shoes | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress timeline**

Description: *"nobody sees day 47"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG08 · Day-N progress checkpoints ⚗️: marble block to statue  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

**Slide 0 (cover):** **you're not ugly. you're unfinished.**, over 🗿 *statue: rough unfinished marble block with a young man's face half-emerging, chisel marks, a sculptor's chisel resting beside it*

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **month 1** | a dusty chisel and hammer | 🗿 *statue: rough unfinished marble block with a face barely emerging* | a fast-food bag | a messy desk | — |
| 2 | **month 6** | a gym bag | 🗿 *statue: half-carved marble bust with visible chisel marks* | meal prep containers | a skincare shelf | — |
| 3 | **month 12** | an empty gym at sunrise | 🗿 *statue: finished perfectly polished marble bust of a handsome young man* | a made bed | a fresh fruit plate | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress timeline**

Description: *"you're the sculptor"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG05 · Routine grid ⚗️: weekly & monthly check-in  (priority 4)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **weekly check-in** | a tape measure on a desk | a phone on a tripod by a window | a journal and pen | a habit tracker full of checkmarks | — |
| 2 | **monthly check-in** | a laptop showing two side-by-side photos | an empty barber chair | a calendar with a month of checkmarks | a sunrise through a window | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress check-in**

Description: *"steal my routine"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG02 · real <CATEGORY> list: how to take progress pics  (priority 5)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **progress pics: same LIGHT** | soft daylight from a window | a bathroom with bright even light | a ring light switched off in a corner | a sunny window with sheer curtains | — |
| 2 | **same ANGLE** | a phone on a small tripod | a phone leaning on a mirror shelf | a tape mark on the floor | a phone at eye level on a shelf | — |
| 3 | **same TIME** | an alarm clock at sunrise | a bathroom mirror in the morning | a glass of water on a sink | a calendar with checkmarks | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress photo timeline / side-by-side compare**

Description: *"save this"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG06 · Humble-brag question: visible progress  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my progress so visible?** | a phone on a tripod by a window | soft window daylight | a habit tracker full of checkmarks | a tape measure | Statue (back) |
| 2 | **Why do I never lose motivation?** | a laptop showing a photo timeline | a paper habit tracker | sunrise through a window | a packed gym bag | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **progress timeline** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG09 · real <CATEGORY> list: what to track  (priority 6)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **track your SLEEP** | a dark bedroom at night | an analog alarm clock | a smart ring on a nightstand | a journal and pen | — |
| 2 | **track your FOOD** | a digital kitchen scale | meal prep containers | a tall glass of water | a bowl of eggs | — |
| 3 | **track your FACE** | a phone on a tripod by a window | soft morning window light | a clean bathroom mirror | a calendar with checkmarks | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress tracker**

Description: *"save this"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG10 · Humble-brag question: people think I edit  (priority 7)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do people think I edit my pics?** | soft window daylight | a frosty ice roller | an empty barber chair | a sunscreen tube | Statue (back) |
| 2 | **Why is my day 90 so different?** | meal prep containers | an empty gym at sunrise | a minimal skincare shelf | a dark bedroom with blackout curtains | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **progress photo compare** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG03 · Humble-brag question: fast glow-up  (priority 8)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my glow up so fast?** | 🗿 *statue: young man's face, three-quarter view, sharp jawline* | a paper habit tracker full of checkmarks | a minimal skincare shelf | a gym at sunrise | — |
| 2 | **Why do I never miss a day?** | clothes laid out the night before | a phone charging outside the bedroom | a meal prep fridge | running shoes by the door | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **streak counter / progress chart** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

## Pillar: Documenting the journey (creator humor)

### CR01 · real <CATEGORY> list: time audit: filming vs jawmaxxing  (priority 1)

`9:16` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **where my softmaxxing time actually goes**, over a glowing ring light on a tripod in a dark messy bedroom at night, a phone clamped in the centre

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **FILMING: 3 hours** | a ring light glowing in a dark bedroom | a phone on a tripod facing a mirror | a bathroom mirror with a phone clamp | a small clip-on microphone on a desk | — |
| 2 | **EDITING: 2 hours** | a laptop showing a video editing timeline at night | a phone with a video editing app open | headphones on a messy desk | a cold half-drunk coffee | — |
| 3 | **actual JAWMAXXING: 4 minutes** | a single piece of mastic chewing gum | a jade gua sha stone | 🗿 *statue: young man's head with an unchanged soft jawline, side profile* | a glass of water | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress tracker: track the real work, not the views**

Description: *"the math isn't mathing"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR06 · This isn't X / but this is.: this isn't jawmaxxing  (priority 1)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this isn't jawmaxxing** | a ring light glowing in a bedroom | a phone on a tripod | a laptop with a video editing timeline | a phone gallery full of near-identical selfies | Statue (facepalm) |
| 2 | **this is.** | 🗿 *statue: young man's head side profile with a sharp jawline* | hard mastic gum pieces | a tall glass of water | a dark bedroom at night | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **jaw routine checklist**

Description: *"I said what I said"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR02 · Day-N progress checkpoints ⚗️: the setup glowed up, the jaw didn't  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **day 1 of jawmaxxing** | an old cracked phone leaning on a cereal box | a single gua sha stone on a desk | 🗿 *statue: young man's head, side profile, neutral* | a dim desk lamp | — |
| 2 | **day 30** | a ring light in a bedroom | a phone tripod | 🗿 *statue: the exact same young man's head, side profile, neutral* | a clip-on microphone | — |
| 3 | **day 90** | a full home studio with two softbox lights | a mirrorless camera on a tripod with a shotgun mic | 🗿 *statue: the exact same young man's head, side profile, neutral, unchanged* | a second monitor showing an editing timeline | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress photo timeline**

Description: *"the setup glowed up more than me"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR07 · Average X vs average Y: gua sha on camera vs off camera  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Store card

**Slide 0 (cover):** **softmaxxers will understand this one**, over a jade gua sha stone on a white marble counter beside lit candles and eucalyptus, golden hour light, overly perfect aesthetic setup

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my gua sha in the video** | a jade gua sha on a white marble counter | lit candles and eucalyptus | soft golden window light | a folded white towel | — |
| 2 | **my gua sha the other 23 hours** | a jade gua sha buried under a pile of laundry | a gua sha in a cluttered drawer full of cables | a dusty gua sha behind a gaming headset | a gua sha under an unmade bed | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily face routine**

Description: *"it's somewhere in my room"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR03 · Average X vs average Y: how followers think I jawmax vs reality  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **how my followers think I jawmax** | a spotless gym at sunrise | a jade gua sha on a marble counter | 🗿 *statue: heroic young man's head looking up, sharp jawline* | a clean high-protein meal | — |
| 2 | **how I actually jawmax** | a phone propped on a stack of books filming an empty messy bedroom, nobody in frame | a ring light next to an unmade bed | 🗿 *statue: man covering his face with his hand in shame* | a chewed piece of gum stuck on a desk edge | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily jaw / face routine checklist**

Description: *"we all know which one it is"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR08 · real <CATEGORY> list: creator kit vs actual kit  (priority 3)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer creator KIT** | a ring light | a phone tripod | a clip-on microphone | a phone with a video editing app open | — |
| 2 | **actual softmaxxer KIT** | hard mastic gum pieces | a sunscreen tube | light dumbbells | a tall glass of water | — |
| 3 | **kit I ACTUALLY use** | a ring light | a phone tripod | a clip-on microphone | a single piece of mastic gum | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **routine tracker**

Description: *"be honest"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR04 · Routine grid ⚗️: the 5am routine and what it took to film it  (priority 4)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my 5am softmaxxing routine** | sunrise light through a bedroom window | a cold shower head running | a glass of water with lemon | running shoes by the door | — |
| 2 | **what it took to film it** | an alarm clock showing 4am in a dark room | a ring light set up in a dark bedroom before sunrise | a phone gallery full of near-identical takes | a phone tripod standing in a shower cubicle | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning routine planner**

Description: *"14 takes for a 7 second clip"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR09 · Routine grid ⚗️: filmed morning vs real morning  (priority 4)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my morning (as filmed)** | golden sunrise through a window | a matcha latte on a wooden table | a journal and pen in soft light | an empty gym at sunrise | — |
| 2 | **my morning (not filmed)** | an alarm clock knocked over on the floor | a bowl of soggy cereal | a phone glowing in an unmade bed | clothes piled on a chair | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning routine planner**

Description: *"the 5am routine was filmed at 11"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR05 · Humble-brag question: why isn't my jawline improving  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my jawline not improving?** | a ring light glowing at night | a phone on a tripod | a laptop with a video editing timeline at 2am | a phone gallery full of hundreds of selfies | Statue (back) |
| 2 | **Why is my screen time 9 hours?** | a phone showing an analytics graph | a phone with a video editing app open | a messy desk with energy drinks at night | a phone charging next to a pillow | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **screen-time vs routine-time tracker** (screenshot replaces the TR tile, statue stays)

Description: *"no idea what's going on tbh"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR10 · Average X vs average Y: my posts vs my camera roll  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my posts** | a sunrise gym through a window | 🗿 *statue: heroic young man's head with a sharp jawline, looking up* | a clean healthy meal | a minimal skincare shelf | — |
| 2 | **my camera roll** | a phone gallery of 47 near-identical blurry selfies | 🗿 *statue: young man's head looking down, double chin angle* | screenshots of other creators' jawlines on a phone | a phone storage-full warning glowing in the dark | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress photo timeline**

Description: *"the camera roll knows the truth"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

---

## 8. Suggested first test batch (one per pillar)

| Order | ID | Why it's in the first batch |
|---|---|---|
| 1 | **DH01** | "average 19 year old" vs softmaxxer: identity contrast, the strongest comment bait in the niche |
| 2 | **FJ01** | jawline is the #1 search intent in looksmaxxing. Proven question format + statue |
| 3 | **SK01** | clear skin is the broadest softmaxxing goal. Exact copy of the proven question format |
| 4 | **Q01** | food pillar. Closest to the reference post that's already proven |
| 5 | **GY01** | built to be saved (cheat-sheet), and the gym crowd overlaps heavily with this audience |
| 6 | **PG01** ⚗️ | the progress-arc test. If it works, it becomes a recurring series (day 180, day 365) |
| 7 | **CR01** | creator-humor test: "FILMING: 3 hours / EDITING: 2 hours / actual JAWMAXXING: 4 minutes". The punchline lands on the last slide, which rewards swiping all the way through and gets shared |

## 9. Building new rows

Copy any row, keep the formula, ratio, look and CTA, and change only the subjects and caption.
When a post outperforms, make 3 variants of it **in the same pillar and formula** before
trying something new. The reference channel works this way: one format, rotating subjects.
