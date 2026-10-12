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
| **Skin** | 15% | clear skin, glow, acne, SPF, simple routines | question, mythbust, category | 3 |
| **Face & jawline** | 15% | definition through body fat, de-bloating, sleep, chewing, posture | question, mythbust | 2 |
| **Body & gym** | 15% | V-taper, shoulders, neck, the 'looks better in clothes' lifts | category, question, contrast | 3 |
| **Posture** | 5% | standing taller, desk setup, anti-slouch habits | contrast, question | 2 |
| **Hair, teeth, eyes & grooming** | 10% | haircare, brows, oral care, under-eyes | category, mythbust, question | 3 |
| **Sleep & discipline** | 10% | sleep, mornings, dopamine, consistency | routine, contrast, mythbust | 4 |
| **Style & scent** | 5% | basics that look expensive, scent, accessories | category, contrast | 2 |
| **Progress & creator** | 5% | glow-up arcs, progress pics, tracking | progress, category, question | 3 |
| **Documenting the journey (creator humor)** | 10% | self-aware joke: softmaxxers spend more time filming, editing and posting the glow-up than actually doing it. Relatable for the creators in the audience, very shareable | category, contrast, progress, question, routine | 5 |

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
| **Skin** | SK01 | · | SK02 | SK03 | · | · | · |
| **Face & jawline** | FJ01 | · | FJ02 | · | · | · | · |
| **Body & gym** | GY02 | GY03 | · | GY01 | · | · | · |
| **Posture** | PO02 | PO01 | · | · | · | · | · |
| **Hair, teeth, eyes & grooming** | HG01 | · | HG02 | HG03 | · | · | · |
| **Sleep & discipline** | · | DH01 | DH03 | · | · | DH02, DH04 | · |
| **Style & scent** | · | ST02 | · | ST01 | · | · | · |
| **Progress & creator** | PG03 | · | · | PG02 | · | · | PG01 |
| **Documenting the journey (creator humor)** | CR05 | CR03 | · | CR01 | · | CR04 | CR02 |

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

### SK02 · This isn't X / but this is.: skin-ruining habits  (priority 4)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is ruining your skin** | a greasy smudged phone screen | a dirty old pillowcase | a steaming very hot shower | a harsh gritty face scrub | Statue (facepalm) |
| 2 | **do this instead.** | 👤 *good face* | lukewarm water running from a bathroom tap | a fresh clean white pillowcase | a tube of sunscreen | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **skincare routine checklist**

Description: *"sorry not sorry"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

### SK03 · real <CATEGORY> list: minimal routines  (priority 9)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **real SKINCARE** | a plain white cleanser bottle | a plain moisturiser jar | a sunscreen tube | a clean folded white face towel | — |
| 2 | **real HAIRCARE** | a plain shampoo bottle | a wide-tooth wooden comb | a scalp massager brush | a white silk pillowcase | — |
| 3 | **real ORAL CARE** | an electric toothbrush | a dental floss container | a metal tongue scraper | a glass of water on a bathroom sink | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily routine checklist with streak**

Description: *"save this"* · #skincareformen #softmaxxing #clearskin #glowup #fyp

## Pillar: Face & jawline

### FJ01 · Humble-brag question: jawline & definition  (priority 2)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my jawline so sharp?** | 🗿 *statue: sharp jawline side profile of a young man's head* | pieces of hard mastic chewing gum | a glass of water with lemon slices | a smooth green jade gua sha stone | — |
| 2 | **Why is my face never puffy?** | a glass bowl of ice water | a pillow on a neatly made bed in a dark room | a cup of green tea | a jump rope coiled on a gym floor | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **face / jawline score with progress chart** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

### FJ02 · This isn't X / but this is.: jawline gadgets  (priority 6)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this won't fix your jawline** | a silicone jawline exerciser ball | a chin strap face slimming band | a vibrating face roller gadget | a face slimming V-line mask | Statue (facepalm) |
| 2 | **this will.** | 👤 *good face* | a lean high-protein meal of chicken, rice and vegetables | a dark bedroom at night with blackout curtains | running shoes on a pavement at sunrise | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **face score with body-fat and sleep goals**

Description: *"sorry not sorry"* · #jawline #softmaxxing #looksmaxxing #glowup #fyp

## Pillar: Body & gym

### GY01 · real <CATEGORY> list: aesthetic lifts  (priority 3)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **for WIDE shoulders** | a pair of light dumbbells on a gym floor | a cable machine with a single handle | a barbell on an overhead press rack | a resistance band hanging from a rack | — |
| 2 | **for a THICK neck** | a leather neck harness with a weight plate | a weight plate resting on a flat bench | a thick resistance band | a padded gym mat | — |
| 3 | **for a V-TAPER** | a pull-up bar in a gym | a lat pulldown machine | a rowing machine | a loaded barbell on a deadlift platform | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **workout plan for aesthetics**

Description: *"save this"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY02 · Humble-brag question: gym consistency  (priority 7)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why are my shoulders so wide?** | 🗿 *statue: broad muscular shoulders and back seen from behind* | a pair of dumbbells on a gym floor | a cable machine | a pull-up bar | — |
| 2 | **Why do I never skip the gym?** | a packed gym bag by the front door | gym clothes laid out neatly on a bed | wireless headphones on a bench | a water bottle in an empty gym at 6am | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **workout streak calendar** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

### GY03 · Average X vs average Y: gym bro vs softmaxxer  (priority 8)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **gym bro routine** | a protein shake bottle | a tub of pre-workout powder | 👤 *weak face* | cans of energy drinks | — |
| 2 | **softmaxxer routine** | a gym with dumbbells at sunrise | a minimal skincare shelf with three products | 👤 *good face* | a dark bedroom with blackout curtains | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **full daily routine (gym, skin, sleep)**

Description: *"which one are you?"* · #gymtok #softmaxxing #aesthetic #vtaper #fyp

## Pillar: Posture

### PO01 · Average X vs average Y: gamer vs softmaxxer posture  (priority 5)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **average gamer posture** | a gaming chair with an RGB desk setup at night | a laptop on an unmade bed | 👤 *weak face* | energy drink cans on a messy desk | — |
| 2 | **softmaxxer posture** | a laptop on a stand at eye level on a clean desk | a foam roller on a yoga mat | 👤 *good face* | a resistance band attached to a door frame | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **posture routine checklist**

Description: *"which one are you?"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

### PO02 · Humble-brag question: standing taller  (priority 12)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why do I look taller?** | 🗿 *statue: perfectly upright standing posture, side view* | a pull-up bar for dead hangs | a foam roller | a monitor raised to eye level | — |
| 2 | **Why don't I slouch anymore?** | a phone held up at eye level | a resistance band for face pulls | a yoga mat with stretching strap | a firm mattress with a thin pillow | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **posture score / daily stretch timer** (screenshot replaces the TR tile, statue stays)

Description: *"it's not genetics"* · #posture #softmaxxing #looksmaxxing #selfimprovement #fyp

## Pillar: Hair, teeth, eyes & grooming

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

### DH02 · Routine grid ⚗️: morning & night routine  (priority 3)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer morning routine** | sunrise light through a bedroom window | a cold shower head running | a glass of water with lemon | running shoes by the door | — |
| 2 | **softmaxxer night routine** | a minimal skincare routine on a bathroom sink | an open book on a nightstand | a phone in a drawer | a dark bedroom with blackout curtains | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning / night routine planner**

Description: *"steal my routine"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH03 · This isn't X / but this is.: looks-lowering habits  (priority 6)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **this is lowering your looks** | doomscrolling a phone in bed at night | energy drink cans | beer cans on a coffee table | a messy unmade bed at noon | Statue (facepalm) |
| 2 | **this is raising them.** | 👤 *good face* | a sunrise walk on an empty street | a made bed in a bright room | a gym at 6am | — |

**Slide 3 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **habit tracker**

Description: *"sorry not sorry"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

### DH04 · Routine grid ⚗️: sunday reset  (priority 11)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **softmaxxer sunday reset** | fresh clean bedsheets | meal prep containers with chicken and rice | a weekly planner notebook | laundry folded neatly | — |
| 2 | **softmaxxer sunday self-care** | a clay face mask bowl and brush | a beard trimmer | nail clippers on a towel | a foam roller | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **weekly planner**

Description: *"steal my routine"* · #softmaxxing #discipline #thatguy #selfimprovement #fyp

## Pillar: Style & scent

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

### PG01 · Day-N progress checkpoints ⚗️: 90-day softmaxxing arc  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **day 1 of softmaxxing** | a messy bedroom at night lit by a phone | a fast-food bag | 🗿 *statue: young man's head looking down* | energy drink cans | — |
| 2 | **day 30** | a packed gym bag | a minimal skincare shelf | 🗿 *statue: young man's head looking straight ahead* | meal prep containers | — |
| 3 | **day 90** | an empty gym at sunrise | a made bed in a bright room | 🗿 *statue: young man's head looking up confidently, sharp jawline* | a fresh fruit and steak plate | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress timeline with photos**

Description: *"day 180 next?"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

### PG02 · real <CATEGORY> list: how to take progress pics  (priority 5)

`9:16` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **progress pics: same LIGHT** | soft daylight from a window | a bathroom with bright even light | a ring light switched off in a corner | a sunny window with sheer curtains | — |
| 2 | **same ANGLE** | a phone on a small tripod | a phone leaning on a mirror shelf | a tape mark on the floor | a phone at eye level on a shelf | — |
| 3 | **same TIME** | an alarm clock at sunrise | a bathroom mirror in the morning | a glass of water on a sink | a calendar with checkmarks | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress photo timeline / side-by-side compare**

Description: *"save this"* · #softmaxxing #glowup #progress #looksmaxxing #fyp

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

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **FILMING: 3 hours** | a ring light glowing in a dark bedroom | a phone on a tripod facing a mirror | a bathroom mirror with a phone clamp | a small clip-on microphone on a desk | — |
| 2 | **EDITING: 2 hours** | a laptop showing a video editing timeline at night | a phone with a video editing app open | headphones on a messy desk | a cold half-drunk coffee | — |
| 3 | **actual JAWMAXXING: 4 minutes** | a single piece of mastic chewing gum | a jade gua sha stone | 🗿 *statue: young man's head with an unchanged soft jawline, side profile* | a glass of water | — |

**Slide 4 (CTA):** Store card, caption **get the '<APP>' app**, showing **progress tracker: track the real work, not the views**

Description: *"the math isn't mathing"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR02 · Day-N progress checkpoints ⚗️: the setup glowed up, the jaw didn't  (priority 2)

`3:4` · Casual phone · overlay: — · CTA: Phone in dark

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **day 1 of jawmaxxing** | an old cracked phone leaning on a cereal box | a single gua sha stone on a desk | 🗿 *statue: young man's head, side profile, neutral* | a dim desk lamp | — |
| 2 | **day 30** | a ring light in a bedroom | a phone tripod | 🗿 *statue: the exact same young man's head, side profile, neutral* | a clip-on microphone | — |
| 3 | **day 90** | a full home studio with two softbox lights | a mirrorless camera on a tripod with a shotgun mic | 🗿 *statue: the exact same young man's head, side profile, neutral, unchanged* | a second monitor showing an editing timeline | — |

**Slide 4 (CTA):** Phone in dark, caption **get the '<APP>' app**, showing **progress photo timeline**

Description: *"the setup glowed up more than me"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR03 · Average X vs average Y: how followers think I jawmax vs reality  (priority 3)

`3:4` · Casual phone · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **how my followers think I jawmax** | a spotless gym at sunrise | a jade gua sha on a marble counter | 🗿 *statue: heroic young man's head looking up, sharp jawline* | a clean high-protein meal | — |
| 2 | **how I actually jawmax** | a phone propped on a stack of books filming in a messy bedroom | a ring light next to an unmade bed | 🗿 *statue: man covering his face with his hand in shame* | a chewed piece of gum stuck on a desk edge | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **daily jaw / face routine checklist**

Description: *"we all know which one it is"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR04 · Routine grid ⚗️: the 5am routine and what it took to film it  (priority 4)

`9:16` · Moody dark · overlay: — · CTA: Store card

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **my 5am softmaxxing routine** | sunrise light through a bedroom window | a cold shower head running | a glass of water with lemon | running shoes by the door | — |
| 2 | **what it took to film it** | an alarm clock showing 4am in a dark room | a ring light set up in a dark bedroom before sunrise | a phone gallery full of near-identical takes | a phone tripod standing in a shower cubicle | — |

**Slide 3 (CTA):** Store card, caption **get the '<APP>' app**, showing **morning routine planner**

Description: *"14 takes for a 7 second clip"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

### CR05 · Humble-brag question: why isn't my jawline improving  (priority 5)

`9:16` · Macro fill · overlay: Statue (back) · CTA: In-grid screenshot

| # | Caption | TL | TR | BL | BR | Overlay |
|---|---|---|---|---|---|---|
| 1 | **Why is my jawline not improving?** | a ring light glowing at night | a phone on a tripod | a laptop with a video editing timeline at 2am | a phone gallery full of hundreds of selfies | Statue (back) |
| 2 | **Why is my screen time 9 hours?** | a phone showing an analytics graph | a phone with a video editing app open | a messy desk with energy drinks at night | a phone charging next to a pillow | Statue (back) |

**Slide 3 (CTA):** In-grid screenshot, caption **get the '<APP>' app**, showing **screen-time vs routine-time tracker** (screenshot replaces the TR tile, statue stays)

Description: *"no idea what's going on tbh"* · #softmaxxing #jawmaxxing #creatorlife #relatable #fyp

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
