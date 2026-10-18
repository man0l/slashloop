// SLA-911: the composite deck as a read model, so "who is on each slide, and
// under which licence" is one get_video call instead of a database query.
import { db } from '../../db.js';
import { compositeDeckOf } from './options.js';

export interface DeckFaceRow { id: string; source: string; personName: string | null; licence: string | null; attribution: string | null }
export type DeckFaceLookup = (workspaceId: string, ids: string[]) => Promise<DeckFaceRow[]>;

export const liveDeckFaces: DeckFaceLookup = (workspaceId, ids) =>
  db.faceLibrary.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, source: true, personName: true, licence: true, attribution: true } });

export interface CompositeDeckView {
  fingerprint: string;
  feature: string | null;
  builtAt: string;
  slideCount: number;
  /** False for a deck built before per-slide detail was stamped: badge and label are then unknown. */
  detailed: boolean;
  slides: Array<{
    index: number; faceId: string; badge: 'pos' | 'neg' | null; label: string | null;
    source: string | null; personName: string | null; licence: string | null; attribution: string | null;
    /** True when the library row is gone (deleted since the build). */
    missing?: true;
  }>;
}

export async function compositeDeckView(
  workspaceId: string,
  rawJson: string | null | undefined,
  keyCount: number,
  lookup: DeckFaceLookup = liveDeckFaces,
): Promise<CompositeDeckView | null> {
  const stamp = compositeDeckOf(rawJson);
  if (!stamp) return null;
  const detail = stamp.slides ?? stamp.faceIds.map((faceId, index) => ({ index, faceId, badge: null, label: null }));
  const ids = [...new Set(detail.map(d => d.faceId))];
  const rows = ids.length ? await lookup(workspaceId, ids) : [];
  const byId = new Map(rows.map(r => [r.id, r]));
  return {
    fingerprint: stamp.fingerprint,
    feature: stamp.feature,
    builtAt: stamp.builtAt,
    slideCount: keyCount,
    detailed: !!stamp.slides,
    slides: detail.map(d => {
      const f = byId.get(d.faceId);
      return {
        index: d.index, faceId: d.faceId, badge: d.badge, label: d.label,
        source: f?.source ?? null, personName: f?.personName ?? null, licence: f?.licence ?? null, attribution: f?.attribution ?? null,
        ...(f ? {} : { missing: true as const }),
      };
    }),
  };
}
