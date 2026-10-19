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
  z.strictObject({t: z.literal('chip'), at: Point, text: z.string(), card: common.card, tone: common.tone}),
  z.strictObject({t: z.literal('box'), from: Point, to: Point, pad: z.number().optional(), ...common}),
  z.strictObject({t: z.literal('dots'), path: z.array(Point).min(2), ...common}),
  z.strictObject({t: z.literal('circle'), at: Point, r: z.number(), ...common}),
]);
export type Anim = z.infer<typeof Anim>;

const GridCell = z.union([
  z.tuple([z.string(), z.string()]),
  z.tuple([z.string(), z.string(), Tone]), // [still, label, label colour]
]);

const Inset = z.strictObject({at: Point, label: z.string().optional(), tone: Tone.optional()});

export const Beat = z.strictObject({
  img: z.string().optional(),
  imgs: z.array(z.string()).min(2).max(7).optional(),
  grid: z.array(GridCell).length(4).optional(),
  layout: z.enum(['single', 'split', 'grid2x2', 'strip']).default('single'),
  view: z.enum(['front', 'profile', 'closeup']).default('front'),
  focus: Point.optional(),
  zoom: z.number().optional(), // closeup zoom (default 2)
  caption: z.string(),
  captionPos: z.enum(['top', 'bottom']).default('bottom'),
  hl: Hl.default('yellow'),
  vo: z.string(),
  anim: z.array(Anim).optional(),
  inset: Inset.optional(),
  active: z.number().int().optional(),
  labels: z.array(z.string()).optional(), // split chips above each card / strip labels
  row: z.string().optional(), // grid2x2 row header for the bottom row
  arrows: z.boolean().optional(), // grid2x2: arrows from payoff labels to the cards
  grey: z.boolean().optional(), // selective-colour still (greyscale except the masked colour)
  then: z
    .strictObject({
      at: z.number().min(0).max(1).optional(), // fraction of the beat (default theme.stagger.thenFraction)
      active: z.number().int().optional(),
      caption: z.string().optional(),
      captionPos: z.enum(['top', 'bottom']).optional(),
      hl: Hl.optional(),
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
    id: z.string().regex(/^R\d\d$/),
    template: z.enum(['A', 'B', 'C', 'Q']),
    title: z.string().optional(),
    faces: z.record(z.string(), z.string()),
    stills: z.record(z.string(), StillSpec).optional(),
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
  landmarks: Record<string, Landmarks>;
  total: number;
};

// Style rules from the brief that are warnings, not errors (the R01 brief itself has 10-word captions).
export const lintScript = (s: Script): string[] => {
  const out: string[] = [];
  s.beats.forEach((b, i) => {
    const words = (b.caption.match(/[A-Z0-9'’+-]+/gi) ?? []).length;
    if (words > 9) out.push(`beat ${i + 1}: caption has ${words} words (rule: <= 9)`);
    const vo = b.vo.split(/\s+/).length;
    if (vo < 8 || vo > 16) out.push(`beat ${i + 1}: vo has ${vo} words (rule: 8-16)`);
    if (!/\*\*.+\*\*/.test(b.caption)) out.push(`beat ${i + 1}: caption has no **highlight**`);
  });
  if (s.beats.length < 10 || s.beats.length > 18) out.push(`${s.beats.length} beats (rule: 10-16, R01 brief: 18)`);
  return out;
};

export const parseScript = (raw: unknown): Script => {
  const r = Script.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid reel script:\n${msg}`);
  }
  return r.data;
};
