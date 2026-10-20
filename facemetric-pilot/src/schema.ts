import {z} from 'zod';

// Every object is strict: an unknown key in a script fails loudly at load.

const Hl = z.enum(['teal', 'purple', 'yellow']);
const Tone = z.enum(['white', 'teal', 'purple', 'yellow', 'navy']);
const XY = z.tuple([z.number(), z.number()]);

// A point on the still: raw normalized [x, y], a landmark name ("subnasale"),
// or a landmark with an offset ["subnasale", dx, dy].
export const Point = z.union([XY, z.string(), z.tuple([z.string(), z.number(), z.number()])]);
export type Point = z.infer<typeof Point>;

const common = {
  card: z.number().int().min(0).max(3).optional(), // which card in split / grid (default 0)
  chip: z.string().optional(),
  chipAt: Point.optional(), // override where the anim's chip sits
  tone: Tone.optional(), // chip colour
};

export const Anim = z.discriminatedUnion('t', [
  z.strictObject({t: z.literal('measure'), from: Point, to: Point, ...common}),
  // No `at`: a label chip stacked above the photo (reference: "STRONG NOSE ✓"). With `at`: a small chip on the face.
  z.strictObject({t: z.literal('chip'), at: Point.optional(), text: z.string(), card: common.card, tone: common.tone, check: z.boolean().optional()}),
  z.strictObject({t: z.literal('box'), from: Point, to: Point, pad: z.number().optional(), ...common}),
  z.strictObject({t: z.literal('dots'), path: z.array(Point).min(2), ...common}),
  z.strictObject({t: z.literal('circle'), at: Point, r: z.number(), ...common}),
  // Citation card under the headline / header: "PESHEK ET AL. 2011" + "Evolutionary Psychology".
  z.strictObject({t: z.literal('cite'), title: z.string(), source: z.string(), card: common.card, tone: common.tone}),
]);
export type Anim = z.infer<typeof Anim>;

const GridCell = z.union([
  z.tuple([z.string(), z.string()]),
  z.tuple([z.string(), z.string(), Tone]), // [still, label, label colour]
]);

// Close-up of a region. circle (default): bottom-right of the photo. square (ladder): right side, with the level
// value above it and the label as a pill below it.
const Inset = z.strictObject({
  at: Point,
  label: z.string().optional(),
  value: z.string().optional(),
  shape: z.enum(['circle', 'square']).optional(),
  zoom: z.number().optional(),
  tone: Tone.optional(),
});

export const Beat = z.strictObject({
  img: z.string().optional(),
  imgs: z.array(z.string()).min(2).max(7).optional(),
  grid: z.array(GridCell).length(4).optional(),
  layout: z.enum(['single', 'split', 'grid2x2', 'strip']).default('single'),
  view: z.enum(['front', 'profile', 'closeup']).default('front'),
  focus: Point.optional(),
  zoom: z.number().optional(), // closeup zoom (default 2)
  caption: z.string().default(''), // the top headline; **marks** the highlighted words ('' under a script header)
  hl: Hl.default('teal'), // teal / purple colour the highlight, yellow puts it on a yellow box
  underline: z.boolean().optional(), // draw an underline under the highlighted words (hook beats)
  subs: z.boolean().default(true), // voice-synced subtitles
  card: z.boolean().optional(), // single layout: rounded card instead of the full-bleed photo
  tint: z.enum(['purple', 'teal']).optional(), // colour vignette, e.g. purple on "creepy" beats
  vo: z.string(),
  anim: z.array(Anim).optional(),
  inset: Inset.optional(),
  active: z.number().int().optional(),
  labels: z.array(z.string()).optional(), // split / strip labels
  values: z.array(z.string()).optional(), // strip: value above each card ("+6°", "9 HOURS")
  age: z.string().optional(), // small pill bottom-left of the face: "AGE 28" or a ladder stat ("10% OF MEN")
  row: z.string().optional(), // grid2x2 row header for the bottom row
  arrows: z.boolean().optional(), // grid2x2: reveal the payoff labels and coloured rings on the bottom row
  grey: z.boolean().optional(), // selective-colour still (greyscale except the masked colour)
  then: z
    .strictObject({
      at: z.number().min(0).max(1).optional(), // fraction of the beat (default theme.stagger.thenFraction)
      active: z.number().int().optional(),
      caption: z.string().optional(),
      hl: Hl.optional(),
      // Reframe mid-beat (reference hooks cut from a close-up to the full face): single layout only.
      view: z.enum(['front', 'profile', 'closeup']).optional(),
      zoom: z.number().optional(),
      focus: Point.optional(),
      anim: z.array(Anim).optional(),
    })
    .optional(),
  transition: z.enum(['cut', 'push', 'flash']).default('cut'),
});
export type Beat = z.infer<typeof Beat>;

// How tools/gen-stills.ts makes each still. Either a fresh base face or an edit of another still.
export const StillSpec = z.union([
  z.strictObject({base: z.string(), profile: z.boolean().optional(), seed: z.number().optional()}),
  z.strictObject({from: z.string(), edit: z.string()}),
]);

export const Script = z
  .strictObject({
    id: z.string().regex(/^[RM]\d\d$/), // R = original brief reels, M = content-matrix items
    template: z.enum(['A', 'B', 'C', 'Q']),
    title: z.string().optional(),
    // Ladder header: one persistent 2-line header for the whole reel, keyword **on a teal box** (spec v2 3.2 A).
    header: z.string().optional(),
    faces: z.record(z.string(), z.string()),
    stills: z.record(z.string(), StillSpec).optional(),
    // Lint warnings the script accepts on purpose: warning prefix (e.g. "beat 18: vo") -> one-line reason.
    lintAccept: z.record(z.string(), z.string()).optional(),
    beats: z.array(Beat).min(1),
  })
  .superRefine((s, ctx) => {
    const keys = new Set(Object.keys(s.faces));
    const need = (k: string, path: (string | number)[]) => {
      if (!keys.has(k)) ctx.addIssue({code: 'custom', message: `unknown face "${k}"`, path});
    };
    s.beats.forEach((b, i) => {
      const n = [b.img, b.imgs, b.grid].filter(Boolean).length;
      if (n !== 1) ctx.addIssue({code: 'custom', message: 'beat needs exactly one of img | imgs | grid', path: ['beats', i]});
      if (b.img) need(b.img, ['beats', i, 'img']);
      b.imgs?.forEach((k, j) => need(k, ['beats', i, 'imgs', j]));
      b.grid?.forEach((c, j) => need(c[0], ['beats', i, 'grid', j]));
      const want = b.grid ? 'grid2x2' : b.imgs ? (b.imgs.length === 2 ? 'split' : 'strip') : 'single';
      if (b.layout !== want) ctx.addIssue({code: 'custom', message: `layout should be "${want}"`, path: ['beats', i, 'layout']});
    });
  });
export type Script = z.infer<typeof Script>;

// Data calculateMetadata resolves from the asset folder and hands to the component.
export type Landmarks = Record<string, [number, number]>;
export type Resolved = {
  beatFrames: number[];
  beatStarts: number[];
  audio: (string | null)[];
  leads: number[]; // seconds of silence trimmed off the start of each clip
  words: {w: string; start: number; end: number}[][]; // subtitle timings per beat, seconds from the beat start
  bg: Record<string, string>; // still key -> background colour; `_reel` = average
  landmarks: Record<string, Landmarks>;
  total: number;
};

// Style rules from the brief that are warnings, not errors (the R01 brief itself has 10-word captions).
// Format rules from SPEC.md section 5. Warnings, not errors: a script can break a rule on purpose.
const BEAT_RANGE: Record<Script['template'], [number, number]> = {C: [14, 18], A: [8, 10], B: [20, 35], Q: [12, 16]};

export const lintScript = (s: Script): string[] => {
  const out: string[] = [];
  const words = (t: string) => (t.replace(/\*/g, '').match(/[A-Z0-9'’+=-]+/gi) ?? []).length;
  s.beats.forEach((b, i) => {
    if (!b.caption) {
      if (!s.header) out.push(`beat ${i + 1}: no headline and no script header`);
    } else {
      const n = words(b.caption);
      const max = i < 2 ? 9 : 4;
      if (n > max) out.push(`beat ${i + 1}: headline has ${n} words (rule: <= ${max})`);
      if (!/\*\*.+\*\*/.test(b.caption)) out.push(`beat ${i + 1}: headline has no **highlight**`);
    }
    const vo = b.vo.split(/\s+/).length;
    if (vo < 6 || vo > 16) out.push(`beat ${i + 1}: vo has ${vo} words (rule: 6-16)`);
  });
  if (s.header && !/\*\*.+\*\*/.test(s.header)) out.push('header has no **highlight**');
  const [lo, hi] = BEAT_RANGE[s.template];
  if (s.beats.length < lo || s.beats.length > hi) out.push(`${s.beats.length} beats (template ${s.template}: ${lo}-${hi})`);
  // Same headline on more than 4 consecutive beats (the ladder's persistent header is exempt).
  let run = 1;
  for (let i = 1; i < s.beats.length; i++) {
    run = s.beats[i].caption === s.beats[i - 1].caption ? run + 1 : 1;
    if (run === 5 && s.template !== 'A') out.push(`beats ${i - 3}-${i + 1}: same headline on 5+ beats (rule: <= 4)`);
  }
  // More than 3 full-bleed beats of one still in a row without a zoom change.
  const bleedKey = (b: Script['beats'][number]) => (b.layout === 'single' && !b.card && b.view !== 'closeup' ? `${b.img}@${b.zoom ?? 1}` : null);
  run = 1;
  for (let i = 1; i < s.beats.length; i++) {
    const k = bleedKey(s.beats[i]);
    run = k && k === bleedKey(s.beats[i - 1]) ? run + 1 : 1;
    if (run === 4) out.push(`beats ${i - 2}-${i + 1}: 4 full-bleed beats of ${s.beats[i].img} at one zoom (rule: <= 3)`);
  }
  // 9.3: skull / hairline metrics need a still whose edit removes or flattens the hair.
  const SKULL = new Set(['hairline', 'forehead_top', 'vertex', 'occiput']);
  const HAIR_OFF = /buzz|shav|bald|skin fade|crew cut|pulled back|tied back|slicked|scalp/i;
  const chain = (key: string, depth = 0): string => {
    const sp = s.stills?.[key];
    if (!sp || depth > 6) return '';
    return 'base' in sp ? sp.base : `${sp.edit} ${chain(sp.from, depth + 1)}`;
  };
  const names = (p: Point): string[] => (typeof p === 'string' ? [p] : typeof p[0] === 'string' ? [p[0] as string] : []);
  s.beats.forEach((b, i) => {
    for (const a of [...(b.anim ?? []), ...(b.then?.anim ?? [])]) {
      const pts = a.t === 'measure' || a.t === 'box' ? [a.from, a.to] : a.t === 'dots' ? a.path : a.t === 'circle' ? [a.at] : a.t === 'chip' && a.at ? [a.at] : [];
      if (!pts.flatMap(names).some((n) => SKULL.has(n))) continue;
      const ci = 'card' in a ? a.card ?? 0 : 0;
      const key = b.img ?? b.imgs?.[ci] ?? b.grid?.[ci]?.[0];
      if (key && s.stills?.[key] && !HAIR_OFF.test(chain(key))) out.push(`beat ${i + 1}: skull/hairline metric drawn on ${key}, whose hair is not removed or flattened (rule 9.3)`);
    }
  });
  // 9.4: "too far" stills must name three visible signs and say "clearly visible at a glance".
  for (const [k, sp] of Object.entries(s.stills ?? {})) {
    if (!('from' in sp) || !TOO_FAR.test(`${k} ${sp.edit}`)) continue;
    const signs = sp.edit.split(/[,:;]/).length - 1;
    if (signs < 3 || !/clearly visible at a glance/i.test(sp.edit)) out.push(`still ${k}: too-far edit should name 3 visible signs and say "clearly visible at a glance" (rule 9.4)`);
  }
  return out;
};

// Keys / edits that are the "too far" or neglected side of a comparison (brief 9.4).
export const TOO_FAR = /grown ?out|neglect|overfill|ragged|untidy|scruffy/i;

// Timing-aware rule (needs timing.json): a beat longer than 2.5 s must change something on screen.
export const lintTiming = (s: Script, seconds: number[]): string[] =>
  s.beats.flatMap((b, i) =>
    seconds[i] > 2.5 && !b.anim?.length && !b.then && !b.inset && !b.age && !(b.layout === 'grid2x2' && b.arrows)
      ? [`beat ${i + 1}: ${seconds[i].toFixed(1)} s with nothing changing on screen (rule: a change every 2.5 s)`]
      : [],
  );

export const parseScript = (raw: unknown): Script => {
  const r = Script.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid reel script:\n${msg}`);
  }
  return r.data;
};
