// SLA-868: put photos into the face library: tag, gate, store. Every outside
// effect (vision, image bytes, storage, frame capture) is injected, so the rules
// run in tests and the operator CLI supplies the live versions.
import { randomUUID } from 'node:crypto';
import { detectAnnotationPattern, frameSecFor } from './deck.js';
import { fetchCommonsFile, type FetchLike } from './commons.js';
import { assertInsertable, type FaceInsert, type FaceStore } from './face-store.js';
import { CompositeError, type FaceRecord } from './plan.js';
import { tagFace, type VisionLandmarks } from './tagging.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './landmarks.js';
import { facePath } from '../../lib/storage.js';

export interface IngestDeps {
  store: FaceStore;
  vision: VisionLandmarks;
  putImage(key: string, bytes: Uint8Array): Promise<void>;
  imageSize(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  thresholds?: Thresholds;
  newId?: () => string;
}

export type IngestItem = Omit<FaceInsert, 'workspaceId' | 'imageKey' | 'view' | 'landmarks'> & { bytes: Uint8Array };
export type IngestResult =
  | { status: 'added'; face: FaceRecord }
  | { status: 'exists'; face: FaceRecord }
  | { status: 'skipped'; reason: string };

/** A photo is worth keeping only if code can measure something from its landmarks. */
const hasAnyMeasure = (m: object) => Object.values(m).some(v => typeof v === 'number');

export async function ingestImage(deps: IngestDeps, workspaceId: string, item: IngestItem): Promise<IngestResult> {
  const { bytes, ...meta } = item;
  const probe: FaceInsert = { ...meta, workspaceId, imageKey: 'pending', view: 'profile' };
  assertInsertable(probe);
  const existing = (await deps.store.list(workspaceId)).find(f => f.source === item.source && f.sourceRef === item.sourceRef);
  if (existing) return { status: 'exists', face: existing };

  const tags = await tagFace(deps.vision, bytes, await deps.imageSize(bytes), deps.thresholds ?? DEFAULT_THRESHOLDS);
  if (!hasAnyMeasure(tags.measures)) return { status: 'skipped', reason: 'no_usable_landmarks' };

  const imageKey = facePath(workspaceId, (deps.newId ?? randomUUID)());
  await deps.putImage(imageKey, bytes);
  const face = await deps.store.upsert({ ...probe, imageKey, view: tags.view, landmarks: tags.landmarks });
  return { status: 'added', face };
}

export type FrameExtractor = (videoId: string, timestampSec: number) => Promise<Uint8Array>;

/**
 * Gallery frames: cut a frame at each timestamp where the analysis shows a
 * feature + verdict overlay, labelled with that verdict. The label is the
 * calibration truth; the frame itself carries the source's burned-in graphics,
 * so these rows never feed a deck (see usableFaces).
 */
export async function ingestGalleryFrames(
  deps: IngestDeps, workspaceId: string, videoId: string, analysisJson: unknown, extract: FrameExtractor,
): Promise<IngestResult[]> {
  const pattern = detectAnnotationPattern(analysisJson);
  if (!pattern) throw new CompositeError('not_photo_annotation', 'The analysis has no feature + verdict overlays.');
  const out: IngestResult[] = [];
  for (const slot of pattern.slots) {
    out.push(await ingestImage(deps, workspaceId, {
      bytes: await extract(videoId, frameSecFor(slot)), source: 'gallery_frame', sourceRef: `${videoId}@${slot.timestampSec}`,
      sourceVerdict: { [slot.feature]: slot.badge },
    }));
  }
  return out;
}

/** One Commons photo of a named person. The name comes from the operator (the analysis names the people), never from guessing the file. */
export async function ingestCommonsFile(
  deps: IngestDeps, workspaceId: string, fetchFn: FetchLike, args: { title: string; personName: string; sex?: FaceRecord['sex'] },
): Promise<IngestResult> {
  const file = await fetchCommonsFile(fetchFn, args.title);
  const res = await fetchFn(file.imageUrl);
  if (!res.ok) throw new CompositeError('commons_unavailable', `Image download answered ${res.status}.`);
  return ingestImage(deps, workspaceId, {
    bytes: new Uint8Array(await res.arrayBuffer()), source: 'commons', sourceRef: file.title,
    personName: args.personName, sex: args.sex ?? 'unknown', licence: file.licence, attribution: file.attribution,
  });
}

/** Synthetic faces: unnamed, from the injected generator (a normal, credit-metered render). */
export async function ingestSyntheticFaces(
  deps: IngestDeps, workspaceId: string, batch: string, count: number, generate: (index: number) => Promise<Uint8Array>,
): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await ingestImage(deps, workspaceId, { bytes: await generate(i), source: 'synthetic', sourceRef: `${batch}#${i}` }));
  }
  return out;
}
