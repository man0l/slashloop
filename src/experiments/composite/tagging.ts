// SLA-868: automatic tagging of a library photo. One vision call returns
// landmark positions and the view, nothing else; code computes the measures and
// verdicts, so a threshold change re-labels the whole library with no model call.
import { z } from 'zod/v4';
import {
  DEFAULT_THRESHOLDS, FEATURES, FEATURE_MEASURE, LANDMARK_NAMES, calibrateMonotone, computeMeasures, verdictsFor,
  type Feature, type Landmarks, type Measures, type Thresholds, type Verdicts,
} from './landmarks.js';
import { CompositeError, FACE_VIEWS, type FaceRecord, type FaceView } from './plan.js';
import type { FaceStore } from './face-store.js';

export const LANDMARK_SYSTEM_PROMPT = [
  'You locate anatomical landmarks on a photograph of a head. You return geometry only.',
  'Never describe attractiveness, age, ethnicity, identity, or quality. Never say whether a feature is good or bad.',
  `Landmarks: ${LANDMARK_NAMES.join(', ')}.`,
  'nasion = bridge of the nose between the eyes; gonion = the outer corner of the jaw angle; chin = lowest point of the chin;',
  'earTragus = the small cartilage flap in front of the ear canal; condyle = the jaw joint just in front of the ear;',
  'canthusInner / canthusOuter = inner and outer corners of the same eye; subnasale = base of the nose; pogonion = most forward point of the chin.',
  'Give each as {"x","y"} in fractions of the image width and height (0 to 1, origin top-left). Omit a landmark you cannot see; never guess one.',
  'Also give "view": "profile" (side), "three_quarter", or "frontal".',
  'Reply with JSON only: {"view":"profile","landmarks":{"nasion":{"x":0.5,"y":0.3}}}',
].join('\n');

const Frac = z.number().finite().min(0).max(1);
const VisionReply = z.object({
  view: z.enum(FACE_VIEWS).catch('profile'),
  landmarks: z.record(z.string(), z.object({ x: Frac, y: Frac })).catch({}),
});

/** Vision seam: the live one is a model call, tests pass a stub. */
export type VisionLandmarks = (photo: Uint8Array) => Promise<unknown>;

export interface FaceTags { view: FaceView; landmarks: Landmarks; measures: Measures; verdicts: Verdicts }

/** Fractions to photo pixels (the renderer draws in photo pixels); unknown names are dropped. */
export function parseLandmarkReply(reply: unknown, width: number, height: number): { view: FaceView; landmarks: Landmarks } {
  if (!(width > 0) || !(height > 0)) throw new CompositeError('bad_image_size', 'Photo dimensions are required to place landmarks.');
  const parsed = VisionReply.safeParse(reply);
  if (!parsed.success) throw new CompositeError('bad_landmark_reply', 'The landmark reply was not the expected JSON.');
  const landmarks: Landmarks = {};
  for (const name of LANDMARK_NAMES) {
    const p = parsed.data.landmarks[name];
    if (p) landmarks[name] = { x: Math.round(p.x * width * 10) / 10, y: Math.round(p.y * height * 10) / 10 };
  }
  return { view: parsed.data.view, landmarks };
}

export async function tagFace(
  vision: VisionLandmarks, photo: Uint8Array, size: { width: number; height: number }, thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<FaceTags> {
  const { view, landmarks } = parseLandmarkReply(await vision(photo), size.width, size.height);
  const measures = computeMeasures(landmarks);
  return { view, landmarks, measures, verdicts: verdictsFor(measures, thresholds) };
}

// ramus, canthal tilt and forward growth get monotone cut-offs; the gonial
// angle is a band (too sharp and too obtuse are both negative), so it keeps its defaults.
const MONOTONE: Partial<Record<Feature, 'higher_better'>> = { ramus: 'higher_better', canthal_tilt: 'higher_better', forward_growth: 'higher_better' };
export const MIN_CALIBRATION_PER_CLASS = 3;

export interface CalibrationReport { feature: Feature; status: 'fitted' | 'kept_default'; reason?: string; pos: number; neg: number }

/**
 * Fit thresholds so the stored measures of the pre-labelled gallery frames
 * reproduce the source's own ✅/❌. A feature with too few samples, or whose
 * classes overlap, keeps its default and says so in the report.
 */
export function calibrateThresholds(
  rows: ReadonlyArray<{ measures: Measures; sourceVerdict: Record<string, 'pos' | 'neg'> }>,
): { thresholds: Thresholds; report: CalibrationReport[] } {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  const report: CalibrationReport[] = [];
  for (const feature of FEATURES) {
    const samples = rows.flatMap(r => {
      const value = r.measures[FEATURE_MEASURE[feature]];
      const verdict = r.sourceVerdict[feature];
      return value !== undefined && verdict ? [{ value, verdict }] : [];
    });
    const pos = samples.filter(s => s.verdict === 'pos').length;
    const neg = samples.length - pos;
    const direction = MONOTONE[feature];
    if (!direction) { report.push({ feature, status: 'kept_default', reason: 'band feature', pos, neg }); continue; }
    if (pos < MIN_CALIBRATION_PER_CLASS || neg < MIN_CALIBRATION_PER_CLASS) { report.push({ feature, status: 'kept_default', reason: 'too few labelled frames', pos, neg }); continue; }
    const fitted = calibrateMonotone(samples, direction);
    if (!fitted) { report.push({ feature, status: 'kept_default', reason: 'labelled classes overlap', pos, neg }); continue; }
    thresholds[feature] = fitted;
    report.push({ feature, status: 'fitted', pos, neg });
  }
  return { thresholds, report };
}

/** Re-derive every row's verdicts from its stored measures. No model call. */
export async function relabelLibrary(store: FaceStore, workspaceId: string, thresholds: Thresholds): Promise<number> {
  let changed = 0;
  for (const f of await store.list(workspaceId)) {
    const verdicts = verdictsFor(f.measures, thresholds);
    if (JSON.stringify(verdicts) === JSON.stringify(f.verdicts)) continue;
    await store.saveTags(f.id, { landmarks: f.landmarks, measures: f.measures, verdicts });
    changed++;
  }
  return changed;
}

export type { FaceRecord };
