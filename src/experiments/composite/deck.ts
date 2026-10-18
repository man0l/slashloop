// SLA-868: from a source analysis plus the face library to a composite plan.
// Deterministic code, no model call: the source's own per-shot overlay
// ("short ramus ❌") says which feature and verdict each slot needs, and the
// library says which faces satisfy it.
import { z } from 'zod/v4';
import { MAX_STORY_SLIDES } from '../slide-count.js';
import { featureFromText, parseOverlayVerdict, type Feature } from './landmarks.js';
import {
  CompositeError, CompositePlan, MIN_COMPOSITE_SLIDES, assertValidCompositePlan, faceSlide, selectFaces,
  type CompositePlanT, type FaceRecord, type FaceSlot, type ScoreCardSlideT,
} from './plan.js';

export interface PatternSlot { timestampSec: number; durationSec?: number; feature: Feature; badge: 'pos' | 'neg'; label: string }

/** Mid-shot, so a cut that lands a few tenths off the analysis timestamp cannot show the neighbouring shot. */
export const frameSecFor = (slot: Pick<PatternSlot, 'timestampSec' | 'durationSec'>): number =>
  Math.round((slot.timestampSec + (slot.durationSec ?? 0.5) / 2) * 100) / 100;
export interface AnnotationPattern { slots: PatternSlot[]; scoreCard: boolean }

/** At least this many shots must carry a parseable verdict overlay for the source to count as photo-annotation. */
export const MIN_VERDICT_SHOTS = 3;
// Only the fields the pattern reads, so an analysis with unrelated drift still counts.
const PatternSource = z.object({
  shots: z.array(z.object({
    timestampSec: z.number(), durationSec: z.number().positive().optional().catch(undefined), description: z.string().catch(''), onScreenText: z.string().nullable().catch(null),
  })).nullable().catch(null),
  onScreenText: z.array(z.object({ timestampSec: z.number(), text: z.string().catch('') })).nullable().catch(null),
});
const SCORE_CARD_HINT = /\b(score|psl|rating|rated|\d(?:\.\d)?\s*\/\s*10)\b/i;

/**
 * The photo-annotation pattern: shots whose on-screen text is a feature plus a
 * ✅/❌ verdict. Returns null for any other source, so the composite path never
 * claims a deck it cannot reproduce.
 */
export function detectAnnotationPattern(analysisJson: unknown): AnnotationPattern | null {
  const parsed = PatternSource.safeParse(analysisJson);
  if (!parsed.success) return null;
  const a = parsed.data;
  const byTime = new Map<number, string>();
  const durations = new Map<number, number>();
  for (const s of a.shots ?? []) {
    const t = s.onScreenText?.trim();
    if (t) byTime.set(s.timestampSec, t);
    if (s.durationSec) durations.set(s.timestampSec, s.durationSec);
  }
  for (const o of a.onScreenText ?? []) { const t = o.text?.trim(); if (t && !byTime.has(o.timestampSec)) byTime.set(o.timestampSec, t); }
  const slots: PatternSlot[] = [];
  for (const [timestampSec, text] of [...byTime.entries()].sort((x, y) => x[0] - y[0])) {
    const v = parseOverlayVerdict(text);
    if (v) slots.push({ timestampSec, ...(durations.has(timestampSec) ? { durationSec: durations.get(timestampSec)! } : {}), feature: v.feature, badge: v.verdict, label: v.label });
  }
  if (slots.length < MIN_VERDICT_SHOTS) return null;
  const shots = [...(a.shots ?? [])].sort((x, y) => x.timestampSec - y.timestampSec);
  const last = shots[shots.length - 1];
  const scoreCard = !!last && !parseOverlayVerdict(last.onScreenText ?? '') && SCORE_CARD_HINT.test(`${last.description} ${last.onScreenText ?? ''}`);
  return { slots, scoreCard };
}

export interface BuildDeckOptions {
  /** Free-text direction; a feature named in it replaces the source's feature on every slot. */
  direction?: string;
  /** Explicit feature; wins over one named in `direction`. */
  feature?: Feature;
  /** Restrict faces to these library ids. */
  subset?: readonly string[];
  /** Override the source's order/ratio, e.g. ['neg','pos','pos']. Cycled to fill the deck. */
  order?: ReadonlyArray<'pos' | 'neg'>;
  scoreCard?: { appName?: string; name?: string; score?: number; tier?: string };
  seed: string;
}

export interface BuiltDeck { plan: CompositePlanT; feature: Feature | null; faceIds: string[]; slides: DeckStampSlide[] }

/** One face slide as stamped on the video, so a reader can audit the deck without re-deriving the plan. */
export interface DeckStampSlide { index: number; faceId: string; badge: 'pos' | 'neg'; label: string }

/**
 * Deck size: the source's verdict slots (+ a closing card), kept inside 7..8.
 * Every experiment clamps its source deck to MAX_STORY_SLIDES, so a larger
 * deck would be stamped whole and then partially dropped by whatever is laid over it.
 */
export function deckSize(pattern: AnnotationPattern): number {
  return Math.min(MAX_STORY_SLIDES, Math.max(MIN_COMPOSITE_SLIDES, pattern.slots.length + (pattern.scoreCard ? 1 : 0)));
}

export function buildCompositePlan(pattern: AnnotationPattern, library: readonly FaceRecord[], o: BuildDeckOptions): BuiltDeck {
  const override = o.feature ?? (o.direction ? featureFromText(o.direction) : null);
  const total = deckSize(pattern);
  const faceCount = total - 1;
  const base = pattern.slots;
  const slots: FaceSlot[] = Array.from({ length: faceCount }, (_, i) => {
    const src = base[i % base.length]!;
    const badge = o.order?.length ? o.order[i % o.order.length]! : src.badge;
    const feature = override ?? src.feature;
    // Source wording survives only while the feature does; a different feature gets its own label.
    return { feature, badge, ...(override || o.order?.length ? {} : { label: src.label }) };
  });
  const picked = selectFaces(library, slots, { seed: o.seed, subset: o.subset });
  const posRatio = picked.filter(p => p.slot.badge === 'pos').length / picked.length;
  const card = o.scoreCard ?? {};
  const scoreCard: ScoreCardSlideT = {
    type: 'score_card',
    appName: card.appName ?? 'PSL',
    // Never auto-fill a real person's name into a numeric rating.
    name: card.name ?? 'Your result',
    score: card.score ?? Math.round((4 + 6 * posRatio) * 10) / 10,
    ...(card.tier ? { tier: card.tier } : {}),
  };
  const plan = CompositePlan.parse({ renderKind: 'composite', slides: [...picked.map(p => faceSlide(p.slot, p.face)), scoreCard] });
  assertValidCompositePlan(plan, new Map(library.map(f => [f.id, f])));
  return { plan, feature: override ?? (new Set(base.map(b => b.feature)).size === 1 ? base[0]!.feature : null), faceIds: picked.map(p => p.face.id),
    slides: plan.slides.flatMap((s, index): DeckStampSlide[] => s.type === 'face' ? [{ index, faceId: s.faceId, badge: s.badge, label: s.label }] : []) };
}

/**
 * What building a composite deck costs: nothing. Rasterising is code and the
 * planner is deterministic, so no render credit and no image-model call is ever
 * made. The planning and judge calls of an experiment laid over the deck are
 * priced by that experiment's own estimate, as for any other slideshow source.
 */
export function compositeDeckEstimate(slideCount: number) {
  if (!Number.isInteger(slideCount) || slideCount < 1) throw new CompositeError('bad_slide_count');
  return { slides: slideCount, renderCredits: 0, totalCredits: 0, imageModelCalls: 0 } as const;
}
