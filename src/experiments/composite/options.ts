// SLA-868: the caller-facing knobs of a composite deck and the identity of one.
// Light module (no photon/opentype): the Worker request path imports it.
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { FEATURES, featureFromText, type Feature } from './landmarks.js';

export const CompositeOptions = z.object({
  /** The feature every slide demonstrates; wins over a feature named in `direction`. */
  feature: z.enum(FEATURES).optional(),
  /** Library face ids the deck may draw from. */
  subset: z.array(z.string().min(1).max(128)).min(1).max(60).optional(),
  /** Badge order, cycled to fill the deck: the ✅/❌ ratio and sequence. */
  order: z.array(z.enum(['pos', 'neg'])).min(1).max(11).optional(),
  scoreCard: z.object({
    appName: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(40).optional(),
    score: z.number().min(0).max(10).optional(),
    tier: z.string().trim().max(24).optional(),
  }).optional(),
  /** Reshuffles which faces are drawn without changing anything else. */
  seed: z.string().trim().min(1).max(64).optional(),
});
export type CompositeOptionsT = z.infer<typeof CompositeOptions>;

export interface DeckRequest extends CompositeOptionsT { direction?: string }

/** The feature a request asks for: explicit first, then one named in free-text direction. */
export const requestedFeature = (req: DeckRequest): Feature | null => req.feature ?? (req.direction ? featureFromText(req.direction) : null);

/**
 * Stable identity of the deck a request describes. Direction counts only through
 * the feature it names, so rewording a brief does not rebuild the deck.
 */
export function deckFingerprint(videoId: string, req: DeckRequest): string {
  const canon = {
    videoId,
    feature: requestedFeature(req),
    subset: req.subset ? [...new Set(req.subset)].sort() : null,
    order: req.order ?? null,
    scoreCard: req.scoreCard ? Object.fromEntries(Object.entries(req.scoreCard).sort()) : null,
    seed: req.seed ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

export interface CompositeDeckStamp { fingerprint: string; feature: string | null; faceIds: string[]; builtAt: string }

/** The deck stamped on a video's rawJson, if its current recreation is a composite deck. */
export function compositeDeckOf(rawJson: string | null | undefined): CompositeDeckStamp | null {
  if (!rawJson) return null;
  try {
    const d = (JSON.parse(rawJson) as { compositeDeck?: Partial<CompositeDeckStamp> }).compositeDeck;
    return d && typeof d.fingerprint === 'string' ? { fingerprint: d.fingerprint, feature: d.feature ?? null, faceIds: d.faceIds ?? [], builtAt: d.builtAt ?? '' } : null;
  } catch { return null; }
}
