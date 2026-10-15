// SLA-868: build and persist a composite deck for one video. VPS only: it
// rasterises with photon, which the Worker's CPU budget cannot afford.
import { db } from '../../db.js';
import { persistRecreation } from '../../lib/media.js';
import { getObject, thumbBucket } from '../../lib/storage.js';
import { buildCompositePlan, detectAnnotationPattern } from './deck.js';
import { prismaFaceStore, usableFaces, type FaceStore } from './face-store.js';
import { deckFingerprint, type DeckRequest } from './options.js';
import { CompositeError, type CompositePlanT } from './plan.js';
import { renderFaceSlide, renderScoreCard, type RenderedSlide } from './render.js';

export interface BuildDeckDeps {
  loadVideo(workspaceId: string, videoId: string): Promise<{ id: string } | null>;
  latestAnalysisJson(videoId: string): Promise<unknown | null>;
  faces: FaceStore;
  getImage(key: string): Promise<Uint8Array | null>;
  persist(workspaceId: string, videoId: string, slides: RenderedSlide[], stamp: { model: string; compositeDeck: Record<string, unknown> }): Promise<string[]>;
}

export const liveBuildDeps: BuildDeckDeps = {
  loadVideo: (workspaceId, videoId) => db.video.findFirst({ where: { id: videoId, source: { workspaceId } }, select: { id: true } }),
  async latestAnalysisJson(videoId) {
    const row = await db.analysis.findFirst({ where: { videoId }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } });
    if (!row?.analysisJson) return null;
    try { return JSON.parse(row.analysisJson); } catch { return null; }
  },
  faces: prismaFaceStore,
  getImage: key => getObject(thumbBucket(), key),
  persist: (workspaceId, videoId, slides, stamp) => persistRecreation(workspaceId, videoId, slides, stamp),
};

export interface BuiltCompositeDeck { keys: string[]; plan: CompositePlanT; fingerprint: string; imageModelCalls: 0 }

export async function buildCompositeDeckForVideo(
  workspaceId: string,
  videoId: string,
  req: DeckRequest = {},
  deps: BuildDeckDeps = liveBuildDeps,
): Promise<BuiltCompositeDeck> {
  if (!(await deps.loadVideo(workspaceId, videoId))) throw new CompositeError('video_not_found', 'Video not found.');
  const pattern = detectAnnotationPattern(await deps.latestAnalysisJson(videoId));
  if (!pattern) throw new CompositeError('not_photo_annotation', 'The latest analysis has no feature + verdict overlays to reproduce.');
  const library = usableFaces(await deps.faces.list(workspaceId));
  const fingerprint = deckFingerprint(videoId, req);
  const { plan, feature, faceIds } = buildCompositePlan(pattern, library, { ...req, seed: req.seed ?? fingerprint });
  const byId = new Map(library.map(f => [f.id, f]));

  const slides: RenderedSlide[] = [];
  for (const slide of plan.slides) {
    if (slide.type === 'score_card') { slides.push(await renderScoreCard(slide)); continue; }
    const face = byId.get(slide.faceId)!;
    const bytes = await deps.getImage(face.imageKey);
    if (!bytes) throw new CompositeError('face_image_missing', `Face ${face.id} has no stored image.`);
    slides.push(await renderFaceSlide(bytes, slide, face.landmarks));
  }
  const keys = await deps.persist(workspaceId, videoId, slides, {
    model: 'composite',
    compositeDeck: { fingerprint, feature, faceIds, builtAt: new Date().toISOString() },
  });
  return { keys, plan, fingerprint, imageModelCalls: 0 };
}
