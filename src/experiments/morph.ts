// SLA-867: morph identity mode. One synthetic subject is graded slide by slide along
// a fixed vocabulary of visible facial attributes (the "tier ladder" carousel). The
// grades are ordinal and monotone across the deck, the image prompt describes them
// in neutral photographic words only, and every valuation label (tiers, scores,
// percentages, hormone claims) is drawn onto the picture in code, never rendered.
// Pure module: no I/O.

export const MORPH_ATTRIBUTES = [
  'jaw definition', 'cheek fullness', 'neck width', 'hairline', 'under-eye hooding', 'skin texture', 'facial hair', 'expression',
] as const;
export type MorphAttribute = (typeof MORPH_ATTRIBUTES)[number];
export const MORPH_MAX_GRADE = 4;
export interface MorphStep { attribute: MorphAttribute; grade: number }
/** The deck-level morph: the axis label (shown to the user, never to the image model) and the attributes it grades. */
export interface MorphSpec { axis: string; attributes: MorphAttribute[] }

/** What each grade looks like, 0..4. Neutral, visible, photographic: no grade is "better" than another. */
export const MORPH_GRADES: Record<MorphAttribute, readonly [string, string, string, string, string]> = {
  'jaw definition': ['a soft, rounded jawline with no visible angle', 'a soft jawline with a faint angle', 'a moderately defined jawline', 'a clearly defined, angular jawline', 'a sharply defined, very angular jawline with a crisp edge under the chin'],
  'cheek fullness': ['lean, hollow cheeks with visible cheekbones', 'slim cheeks', 'medium cheek fullness', 'full, rounded cheeks', 'very full, round cheeks that soften the cheekbones'],
  'neck width': ['a slim neck clearly narrower than the jaw', 'a slim-to-medium neck', 'a medium neck about as wide as the jaw', 'a thick neck slightly wider than the jaw', 'a very thick neck clearly wider than the jaw'],
  hairline: ['a high hairline with deep recession at both temples', 'a high hairline with clear temple recession', 'a medium hairline with slight temple recession', 'a low, full hairline', 'a low, straight, dense hairline'],
  'under-eye hooding': ['smooth, flat under-eyes with no bags', 'faint under-eye shadows', 'visible under-eye bags', 'pronounced under-eye bags with darker shadows', 'deep, heavy under-eye bags with dark circles'],
  'skin texture': ['very smooth, even, clear skin', 'smooth skin with a few visible pores', 'some visible pores and slight unevenness', 'uneven skin with visible pores and redness', 'very uneven skin with large visible pores, redness and blemishes'],
  'facial hair': ['clean-shaven', 'light stubble', 'heavy stubble', 'a short full beard', 'a thick full beard'],
  expression: ['a slack, tired expression with lips slightly parted and an unfocused gaze', 'a relaxed neutral expression', 'a calm, composed expression', 'a focused gaze with closed lips', 'an intense, steady gaze with a firmly set jaw and closed lips'],
};

/** Valuation and rating words. They never reach the image model (the provider filter trips on them) and the QA judge never rates them. */
export const VALUATION_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['chad', /\bchad(?:lite)?s?\b/i], ['htn/mtn/ltn', /\b[hml]tn\b/i], ['sub', /\bsub(?:\s*-?\s*\d+(?:\.\d+)?)?\b/i], ['tier', /\btiers?\b/i],
  ['psl', /\bpsl\b/i], ['testosterone', /testosterone/i], ['attractive', /attractive/i], ['ugly', /\bugl(?:y|ier|iest|iness)\b/i],
  ['handsome', /\bhandsome\b/i], ['score', /\bscor(?:e|es|ed|ing)\b/i], ['percent', /percent|%/i], ['rating', /\brat(?:ing|ed)\b/i],
  ['looksmax', /looks?max/i], ['mog', /\bmog(?:s|ged|ging)?\b/i],
];

/** The valuation words a text contains, by label, in list order. */
export function valuationWords(text: string): string[] {
  return VALUATION_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** Free text (QA fixes, human feedback) with every valuation word replaced, so it can travel to the image model. */
export function redactValuation(text: string): string {
  return VALUATION_PATTERNS.reduce((t, [, re]) => t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[label]'), text);
}

export class MorphError extends Error {
  constructor(public code: 'morph_invalid' | 'morph_not_monotone' | 'morph_flat' | 'morph_valuation_words', message: string) { super(message); }
}

const ATTRIBUTE_ALIASES: Record<string, MorphAttribute> = {
  jaw: 'jaw definition', jawline: 'jaw definition', 'jawline definition': 'jaw definition',
  cheeks: 'cheek fullness', 'face fullness': 'cheek fullness', neck: 'neck width', 'neck thickness': 'neck width',
  'under eye hooding': 'under-eye hooding', 'under-eye bags': 'under-eye hooding', 'under eye bags': 'under-eye hooding', 'under-eyes': 'under-eye hooding',
  skin: 'skin texture', beard: 'facial hair', 'facial expression': 'expression',
};

/** A vocabulary attribute for a free-form name, or null. Case, spacing and a few common names are forgiven. */
export function morphAttribute(name: string): MorphAttribute | null {
  const n = name.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  return (MORPH_ATTRIBUTES as readonly string[]).includes(n) ? n as MorphAttribute : ATTRIBUTE_ALIASES[n] ?? null;
}

const clampGrade = (g: number) => Math.min(MORPH_MAX_GRADE, Math.max(0, Math.round(g)));

/**
 * One deck's per-slide grades, validated: every slide grades the same attribute set (a slide that omits an
 * attribute keeps the previous slide's grade; slide 1 must name them all), each attribute's grades never change
 * direction across the deck, and at least one attribute differs between the first and the last slide.
 */
export function normalizeMorphSlides(raw: ReadonlyArray<ReadonlyArray<{ attribute: string; grade: number }>>, attributes?: readonly MorphAttribute[]): MorphStep[][] {
  if (!raw.length) throw new MorphError('morph_invalid', 'A morph deck needs per-slide grades.');
  const parse = (steps: ReadonlyArray<{ attribute: string; grade: number }>, i: number) => {
    const out = new Map<MorphAttribute, number>();
    for (const s of steps) {
      const a = morphAttribute(s.attribute);
      if (!a) throw new MorphError('morph_invalid', `Slide ${i + 1} grades "${s.attribute}", which is not a morph attribute. Use only: ${MORPH_ATTRIBUTES.join(', ')}.`);
      if (!Number.isFinite(s.grade)) throw new MorphError('morph_invalid', `Slide ${i + 1} has no numeric grade for "${a}".`);
      out.set(a, clampGrade(s.grade));
    }
    return out;
  };
  const first = parse(raw[0]!, 0);
  const attrs = (attributes?.length ? attributes : [...first.keys()]).filter((a, i, xs) => xs.indexOf(a) === i);
  if (!attrs.length) throw new MorphError('morph_invalid', 'Slide 1 must grade at least one morph attribute.');
  const missing = attrs.filter(a => !first.has(a));
  if (missing.length) throw new MorphError('morph_invalid', `Slide 1 must grade every morph attribute; missing: ${missing.join(', ')}.`);
  const decks: MorphStep[][] = [];
  let prev = first;
  raw.forEach((steps, i) => {
    const got = i === 0 ? first : parse(steps, i);
    const row = new Map(attrs.map(a => [a, got.get(a) ?? prev.get(a)!] as const));
    decks.push(attrs.map(a => ({ attribute: a, grade: row.get(a)! })));
    prev = row;
  });
  for (const a of attrs) {
    const grades = decks.map(d => d.find(s => s.attribute === a)!.grade);
    const up = grades.some((g, i) => i > 0 && g > grades[i - 1]!);
    const down = grades.some((g, i) => i > 0 && g < grades[i - 1]!);
    if (up && down) throw new MorphError('morph_not_monotone', `"${a}" must move one way across the deck (grades ${grades.join(', ')}); it goes both up and down.`);
  }
  const firstRow = decks[0]!, lastRow = decks[decks.length - 1]!;
  if (decks.length > 1 && firstRow.every((s, k) => s.grade === lastRow[k]!.grade)) throw new MorphError('morph_flat', 'The last slide grades every attribute the same as the first, so nothing visibly changes.');
  return decks;
}

/** Fails when any prompt-bound text carries a valuation word. Field names make the message actionable. */
export function assertNoValuationWords(fields: Record<string, string>): void {
  const hits = Object.entries(fields).flatMap(([field, text]) => { const w = valuationWords(text); return w.length ? [`${field} (${w.join(', ')})`] : []; });
  if (hits.length) throw new MorphError('morph_valuation_words', `Valuation words cannot reach the image model; describe only what is visible. Found in: ${hits.join('; ')}.`);
}

export const gradeWords = (s: MorphStep): string => MORPH_GRADES[s.attribute][clampGrade(s.grade)]!;

/** The attributes of `slide` whose grade differs from the anchor's (slide 1), anchor grade first. */
export function morphDelta(anchor: readonly MorphStep[], slide: readonly MorphStep[]): Array<{ attribute: MorphAttribute; from: number; to: number }> {
  return slide.flatMap(s => {
    const from = anchor.find(a => a.attribute === s.attribute)?.grade;
    return from === undefined || from === s.grade ? [] : [{ attribute: s.attribute, from, to: s.grade }];
  });
}

/** The visible change from slide 1 in plain words; also stored as the slide's visibleChange. "" for the anchor. */
export function morphChangeText(anchor: readonly MorphStep[], slide: readonly MorphStep[]): string {
  return morphDelta(anchor, slide).map(d => `${d.attribute}: ${gradeWords({ attribute: d.attribute, grade: d.to })}`).join('; ');
}

/** The slide-1 description of the graded attributes (the anchor's starting state). */
export function morphAnchorText(anchor: readonly MorphStep[]): string {
  return anchor.map(s => `${s.attribute}: ${gradeWords(s)}`).join('; ');
}

/** The MORPH block of an anchor-edit prompt: same person as the attached frame, only the graded attributes change. */
export function morphBlock(anchor: readonly MorphStep[], slide: readonly MorphStep[]): string {
  const delta = morphDelta(anchor, slide);
  const kept = slide.filter(s => !delta.some(d => d.attribute === s.attribute)).map(s => s.attribute);
  return [
    'MORPH: this is the SAME person as the attached frame (same age, ethnicity, eye colour, hair colour, outfit, backdrop, framing, lighting, camera and head angle).',
    delta.length
      ? `Change ONLY these visible attributes:\n- ${delta.map(d => `${d.attribute}: now ${gradeWords({ attribute: d.attribute, grade: d.to })} (in the attached frame: ${gradeWords({ attribute: d.attribute, grade: d.from })})`).join('\n- ')}`
      : 'Change nothing about the face or body.',
    `Everything else stays identical${kept.length ? `, including ${kept.join(', ')}` : ''}. Make each change clearly visible at phone size.`,
  ].join('\n');
}

/** One QA check per graded attribute of a slide after the first, phrased relative to slide 1. */
export function morphChecks(anchor: readonly MorphStep[], slide: readonly MorphStep[]): Array<{ attribute: MorphAttribute; check: string }> {
  return slide.map(s => {
    const from = anchor.find(a => a.attribute === s.attribute)?.grade ?? s.grade;
    const check = from === s.grade
      ? `${s.attribute} is unchanged from slide 1 (${gradeWords(s)})`
      : `${s.attribute} has visibly changed from slide 1 (${gradeWords({ attribute: s.attribute, grade: from })}) to ${gradeWords(s)}`;
    return { attribute: s.attribute, check };
  });
}
