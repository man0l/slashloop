// SLA-868: facial geometry for the photo-annotation format. The vision call
// returns landmark pixel coordinates ONLY; every measure and every verdict is
// computed here, so a verdict is reproducible and re-thresholdable from the
// stored landmarks/measures without another model call.
import { z } from 'zod/v4';

export const LANDMARK_NAMES = [
  'nasion', 'gonion', 'chin', 'earTragus', 'condyle',
  'canthusInner', 'canthusOuter', 'subnasale', 'pogonion',
] as const;
export type LandmarkName = (typeof LANDMARK_NAMES)[number];
export interface Point { x: number; y: number }
export type Landmarks = Partial<Record<LandmarkName, Point>>;

export const FEATURES = ['ramus', 'gonial_angle', 'canthal_tilt', 'forward_growth'] as const;
export type Feature = (typeof FEATURES)[number];
export const VERDICTS = ['pos', 'neg', 'unknown'] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Verdicts = Partial<Record<Feature, Verdict>>;

export const PointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export const LandmarksSchema = z.object(
  Object.fromEntries(LANDMARK_NAMES.map(n => [n, PointSchema.optional()])) as Record<LandmarkName, z.ZodOptional<typeof PointSchema>>,
);

export interface Measures {
  ramusLengthRatio?: number;
  gonialAngleDeg?: number;
  canthalTiltDeg?: number;
  chinProjectionRatio?: number;
}
export type MeasureName = keyof Measures;

export const FEATURE_MEASURE: Record<Feature, MeasureName> = {
  ramus: 'ramusLengthRatio',
  gonial_angle: 'gonialAngleDeg',
  canthal_tilt: 'canthalTiltDeg',
  forward_growth: 'chinProjectionRatio',
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const finite = (n: number) => (Number.isFinite(n) ? n : undefined);

/** Nasion to chin: the face-height unit every ratio is taken over. */
function faceHeight(l: Landmarks): number | undefined {
  if (!l.nasion || !l.chin) return undefined;
  const h = dist(l.nasion, l.chin);
  return h > 0 ? h : undefined;
}

/** Interior angle at `vertex` between the rays to `a` and `b`, in degrees. */
function angleAt(vertex: Point, a: Point, b: Point): number | undefined {
  const ua = { x: a.x - vertex.x, y: a.y - vertex.y };
  const ub = { x: b.x - vertex.x, y: b.y - vertex.y };
  const la = Math.hypot(ua.x, ua.y);
  const lb = Math.hypot(ub.x, ub.y);
  if (!la || !lb) return undefined;
  const cos = Math.min(1, Math.max(-1, (ua.x * ub.x + ua.y * ub.y) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Measures from landmarks. Image y grows downward, so "up" is negative y.
 *  - ramusLengthRatio: gonion to condyle (ear tragus as proxy) over face height.
 *  - gonialAngleDeg: ear -> gonion -> chin.
 *  - canthalTiltDeg: inner to outer canthus against horizontal; positive when the outer corner sits higher.
 *  - chinProjectionRatio: pogonion forward of subnasale, along the facing direction, over face height.
 * A measure whose landmarks are absent is omitted, never guessed.
 */
export function computeMeasures(l: Landmarks): Measures {
  const out: Measures = {};
  const h = faceHeight(l);
  const ear = l.condyle ?? l.earTragus;
  if (h && l.gonion && ear) out.ramusLengthRatio = finite(round(dist(l.gonion, ear) / h));
  if (l.gonion && ear && l.chin) {
    const a = angleAt(l.gonion, ear, l.chin);
    if (a !== undefined) out.gonialAngleDeg = round(a, 2);
  }
  if (l.canthusInner && l.canthusOuter) {
    const run = Math.abs(l.canthusOuter.x - l.canthusInner.x);
    if (run > 0) out.canthalTiltDeg = round((Math.atan2(l.canthusInner.y - l.canthusOuter.y, run) * 180) / Math.PI, 2);
  }
  if (h && l.subnasale && l.pogonion && l.nasion && l.earTragus) {
    // The face looks toward the nose: from the ear to the nasion.
    const facing = Math.sign(l.nasion.x - l.earTragus.x) || 1;
    out.chinProjectionRatio = finite(round(((l.pogonion.x - l.subnasale.x) * facing) / h));
  }
  return out;
}

export interface Interval { min?: number; max?: number }
export interface FeatureThreshold { pos: Interval; neg: Interval[] }
export type Thresholds = Record<Feature, FeatureThreshold>;

/**
 * Starting thresholds. They are re-fitted against the niche's own labelled
 * frames (calibrateMonotone below, run over gallery_frame rows) so the split
 * matches what the source already calls short/tall. The band between pos and
 * neg is `unknown`: a borderline face is never given a verdict.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  ramus: { pos: { min: 0.42 }, neg: [{ max: 0.34 }] },
  gonial_angle: { pos: { min: 108, max: 128 }, neg: [{ max: 100 }, { min: 140 }] },
  canthal_tilt: { pos: { min: 4 }, neg: [{ max: -1 }] },
  forward_growth: { pos: { min: 0.03 }, neg: [{ max: -0.03 }] },
};

const within = (v: number, i: Interval) => (i.min === undefined || v >= i.min) && (i.max === undefined || v <= i.max);

export function verdictFor(feature: Feature, measures: Measures, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const v = measures[FEATURE_MEASURE[feature]];
  if (v === undefined || !Number.isFinite(v)) return 'unknown';
  const t = thresholds[feature];
  if (within(v, t.pos)) return 'pos';
  if (t.neg.some(i => within(v, i))) return 'neg';
  return 'unknown';
}

export function verdictsFor(measures: Measures, thresholds: Thresholds = DEFAULT_THRESHOLDS): Verdicts {
  return Object.fromEntries(FEATURES.map(f => [f, verdictFor(f, measures, thresholds)])) as Verdicts;
}

/**
 * Fit a one-sided threshold to labelled samples. `higher_better`: pos at or
 * above `posMin`, neg at or below `negMax`, with the unknown band as narrow as
 * the data allows. Returns null when the labelled classes overlap, because a
 * threshold that cannot reproduce the niche's own labels must not ship.
 */
export function calibrateMonotone(
  samples: ReadonlyArray<{ value: number; verdict: 'pos' | 'neg' }>,
  direction: 'higher_better' | 'lower_better',
): FeatureThreshold | null {
  const pos = samples.filter(s => s.verdict === 'pos').map(s => s.value);
  const neg = samples.filter(s => s.verdict === 'neg').map(s => s.value);
  if (!pos.length || !neg.length) return null;
  if (direction === 'higher_better') {
    const posMin = Math.min(...pos);
    const negMax = Math.max(...neg);
    if (negMax >= posMin) return null;
    return { pos: { min: posMin }, neg: [{ max: negMax }] };
  }
  const posMax = Math.max(...pos);
  const negMin = Math.min(...neg);
  if (negMin <= posMax) return null;
  return { pos: { max: posMax }, neg: [{ min: negMin }] };
}

/** Map a source overlay such as "short ramus ❌" or "tall ramus ✅" to its feature and verdict. */
const FEATURE_WORDS: Array<[Feature, RegExp]> = [
  ['ramus', /\bramus\b/i],
  ['gonial_angle', /\bgonial\b|\bjaw ?angle\b/i],
  ['canthal_tilt', /\bcanthal\b|\beye ?tilt\b/i],
  ['forward_growth', /\bforward ?growth\b|\bchin ?projection\b|\brecessed chin\b/i],
];
export function parseOverlayVerdict(text: string): { feature: Feature; verdict: 'pos' | 'neg'; label: string } | null {
  const label = text.replace(/[✅❌✔✓✗✘]/gu, '').replace(/\s+/g, ' ').trim();
  const feature = FEATURE_WORDS.find(([, re]) => re.test(text))?.[0];
  if (!feature) return null;
  const positive = /✅|✔|✓/u.test(text);
  const negative = /❌|✗|✘/u.test(text);
  if (positive === negative) return null;
  return { feature, verdict: positive ? 'pos' : 'neg', label };
}

export function featureFromText(text: string): Feature | null {
  return FEATURE_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;
}
