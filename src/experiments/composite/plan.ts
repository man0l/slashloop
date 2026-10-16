// SLA-868: the composite plan — what a photo-annotation deck is made of, and the
// rules that keep it legal. Pure module: no I/O, so every rule is a unit test.
import { z } from 'zod/v4';
import {
  FEATURES, LANDMARK_NAMES, type Feature, type Landmarks, type LandmarkName, type Measures, type Verdicts,
  FEATURE_MEASURE,
} from './landmarks.js';

export const FACE_SOURCES = ['gallery_frame', 'commons', 'synthetic'] as const;
export type FaceSource = (typeof FACE_SOURCES)[number];
export const FACE_VIEWS = ['profile', 'three_quarter', 'frontal'] as const;
export type FaceView = (typeof FACE_VIEWS)[number];

/** A library row, decoded. */
export interface FaceRecord {
  id: string;
  workspaceId: string;
  imageKey: string;
  source: FaceSource;
  sourceRef: string;
  personName: string | null;
  sex: 'male' | 'female' | 'unknown';
  view: FaceView;
  landmarks: Landmarks;
  measures: Measures;
  verdicts: Verdicts;
  licence: string | null;
  attribution: string | null;
  createdAt: Date;
}

export class CompositeError extends Error {
  constructor(public code: string, message = code) { super(message); }
}

export const ANNOTATION_KINDS = ['line', 'arrow', 'bracket'] as const;
export const MAX_COMPOSITE_SLIDES = 11;
export const MIN_COMPOSITE_SLIDES = 7;
export const LABEL_MAX = 40;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const FaceSlide = z.object({
  type: z.literal('face'),
  faceId: z.string().min(1).max(128),
  feature: z.enum(FEATURES),
  annotation: z.object({
    kind: z.enum(ANNOTATION_KINDS),
    from: z.enum(LANDMARK_NAMES),
    to: z.enum(LANDMARK_NAMES),
    color: hexColor,
  }),
  badge: z.enum(['pos', 'neg']),
  label: z.string().trim().min(1).max(LABEL_MAX),
  attribution: z.string().trim().min(1).max(160).optional(),
});
export type FaceSlideT = z.infer<typeof FaceSlide>;

export const ScoreCardSlide = z.object({
  type: z.literal('score_card'),
  appName: z.string().trim().min(1).max(40).default('PSL'),
  name: z.string().trim().min(1).max(40),
  score: z.number().min(0).max(10).transform(n => Math.round(n * 10) / 10),
  tier: z.string().trim().max(24).optional(),
});
export type ScoreCardSlideT = z.infer<typeof ScoreCardSlide>;

export const CompositeSlide = z.discriminatedUnion('type', [FaceSlide, ScoreCardSlide]);
export type CompositeSlideT = z.infer<typeof CompositeSlide>;

export const CompositePlan = z.object({
  renderKind: z.literal('composite'),
  slides: z.array(CompositeSlide).min(2).max(MAX_COMPOSITE_SLIDES),
});
export type CompositePlanT = z.infer<typeof CompositePlan>;

/** Which landmarks a feature's annotation line connects, and which must exist on the face. */
export const FEATURE_ANNOTATION: Record<Feature, { kind: (typeof ANNOTATION_KINDS)[number]; from: LandmarkName; to: LandmarkName; needs: LandmarkName[] }> = {
  ramus: { kind: 'line', from: 'gonion', to: 'earTragus', needs: ['gonion', 'earTragus', 'nasion', 'chin'] },
  gonial_angle: { kind: 'bracket', from: 'gonion', to: 'chin', needs: ['gonion', 'earTragus', 'chin'] },
  canthal_tilt: { kind: 'arrow', from: 'canthusInner', to: 'canthusOuter', needs: ['canthusInner', 'canthusOuter'] },
  forward_growth: { kind: 'arrow', from: 'subnasale', to: 'pogonion', needs: ['subnasale', 'pogonion', 'nasion', 'chin', 'earTragus'] },
};

export const FEATURE_LABELS: Record<Feature, { pos: string; neg: string }> = {
  ramus: { pos: 'tall ramus', neg: 'short ramus' },
  gonial_angle: { pos: 'sharp gonial angle', neg: 'wide gonial angle' },
  canthal_tilt: { pos: 'positive canthal tilt', neg: 'negative canthal tilt' },
  forward_growth: { pos: 'forward growth', neg: 'recessed chin' },
};

export const BADGE_COLORS = { pos: '#22c55e', neg: '#ef4444' } as const;

const CC_BY = /\bcc[ -]?by\b/i;
/** True when the licence obliges the slide to carry a credit line. CC0, public domain, synthetic and gallery frames do not. */
export const requiresAttribution = (licence: string | null | undefined): boolean => !!licence && CC_BY.test(licence);

/** The credit line drawn on the slide, or null when the face's licence asks for none. */
export function attributionFor(face: Pick<FaceRecord, 'licence' | 'attribution' | 'sourceRef'>): string | null {
  if (!requiresAttribution(face.licence)) return null;
  const credit = (face.attribution ?? '').trim() || face.sourceRef.replace(/^File:/i, '').trim();
  return `${credit} / Wikimedia Commons / ${face.licence}`.slice(0, 160);
}

/** Can this face carry this feature's annotation at all? */
export const hasLandmarksFor = (face: Pick<FaceRecord, 'landmarks'>, feature: Feature): boolean =>
  FEATURE_ANNOTATION[feature].needs.every(n => !!face.landmarks[n]);

/** A face that may stand on the negative side: synthetic or unnamed, never a named real person. */
export const mayBeNegative = (face: Pick<FaceRecord, 'personName' | 'source'>): boolean =>
  face.personName === null && face.source !== 'commons';

export interface PlanIssue { slide: number; code: string; message: string }

/**
 * Enforced in code, not in prompts (SLA-860 decision 2): a real, recognisable
 * person appears only on the positive side. Also checks each slide against the
 * face it names so the plan cannot disagree with the library.
 */
export function validateCompositePlan(plan: CompositePlanT, faces: ReadonlyMap<string, FaceRecord>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (slide: number, code: string, message: string) => issues.push({ slide, code, message });
  const used = new Set<string>();
  plan.slides.forEach((slide, i) => {
    if (slide.type === 'score_card') {
      if (i !== plan.slides.length - 1) add(i, 'score_card_must_close', 'The score card closes the deck.');
      return;
    }
    const face = faces.get(slide.faceId);
    if (!face) { add(i, 'face_not_found', `Face ${slide.faceId} is not in the workspace library.`); return; }
    if (slide.badge === 'neg' && !mayBeNegative(face)) {
      add(i, 'named_person_on_negative_side', 'A real named person may only appear on a positive (✅) slide.');
    }
    if (used.has(face.id)) add(i, 'face_reused', 'A face appears once per deck.');
    used.add(face.id);
    const verdict = face.verdicts[slide.feature];
    if (verdict !== slide.badge) add(i, 'badge_contradicts_face_verdict', `Face verdict for ${slide.feature} is ${verdict ?? 'unknown'}, slide badge is ${slide.badge}.`);
    for (const end of [slide.annotation.from, slide.annotation.to]) {
      if (!face.landmarks[end]) add(i, 'landmark_missing', `Face has no ${end} landmark.`);
    }
    if (requiresAttribution(face.licence) && !slide.attribution) add(i, 'attribution_required', `${face.licence} requires a credit line.`);
  });
  if (plan.slides.filter(s => s.type === 'score_card').length > 1) add(plan.slides.length - 1, 'one_score_card', 'A deck has at most one score card.');
  return issues;
}

export function assertValidCompositePlan(plan: CompositePlanT, faces: ReadonlyMap<string, FaceRecord>): void {
  const issues = validateCompositePlan(plan, faces);
  if (issues.length) throw new CompositeError(issues[0]!.code, issues.map(i => `slide ${i.slide}: ${i.code}`).join('; '));
}

// ---- face selection -------------------------------------------------------

function seeded(seed: string): (id: string) => number {
  return id => {
    let h = 2166136261;
    for (const ch of `${seed}:${id}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
}

export interface FaceSlot { feature: Feature; badge: 'pos' | 'neg'; label?: string }

/**
 * Fill each slot with a distinct library face whose own verdict for the slot's
 * feature matches the slot's badge. Positive slots may take a commons person;
 * negative slots never do. Deterministic for a seed, so a retry rebuilds the
 * same deck. `subset` restricts the pool to named face ids.
 */
export function selectFaces(
  library: readonly FaceRecord[],
  slots: readonly FaceSlot[],
  opts: { seed: string; subset?: readonly string[]; pinned?: ReadonlyMap<number, string> } = { seed: '' },
): Array<{ slot: FaceSlot; face: FaceRecord }> {
  const rank = seeded(opts.seed);
  const allowed = opts.subset ? new Set(opts.subset) : null;
  const pool = library.filter(f => !allowed || allowed.has(f.id)).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  const taken = new Set<string>();
  const out: Array<{ slot: FaceSlot; face: FaceRecord }> = [];
  const short: string[] = [];
  slots.forEach(slot => {
    const face = pool.find(f =>
      !taken.has(f.id)
      && f.verdicts[slot.feature] === slot.badge
      && hasLandmarksFor(f, slot.feature)
      && (slot.badge === 'pos' || mayBeNegative(f)));
    if (!face) { short.push(`${slot.feature}:${slot.badge}`); return; }
    taken.add(face.id);
    out.push({ slot, face });
  });
  if (short.length) {
    const counts = Object.fromEntries(short.map(s => [s, pool.filter(f => f.verdicts[s.split(':')[0] as Feature] === s.split(':')[1]).length]));
    throw new CompositeError('library_too_small', `Not enough tagged faces for: ${short.join(', ')} (pool matches: ${JSON.stringify(counts)}).`);
  }
  return out;
}

export function faceSlide(slot: FaceSlot, face: FaceRecord): FaceSlideT {
  const a = FEATURE_ANNOTATION[slot.feature];
  const attribution = attributionFor(face);
  return {
    type: 'face', faceId: face.id, feature: slot.feature,
    annotation: { kind: a.kind, from: a.from, to: a.to, color: slot.badge === 'pos' ? BADGE_COLORS.pos : BADGE_COLORS.neg },
    badge: slot.badge,
    label: (slot.label ?? FEATURE_LABELS[slot.feature][slot.badge]).slice(0, LABEL_MAX),
    ...(attribution ? { attribution } : {}),
  };
}

export const measureNameOf = (feature: Feature) => FEATURE_MEASURE[feature];
