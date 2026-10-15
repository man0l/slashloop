// SLA-868: face_library persistence. The planner works over one workspace's
// rows (tens to low hundreds), so reads are a single indexed workspace query and
// every filter runs in code. A `FaceStore` seam keeps the rules testable without a database.
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import { LandmarksSchema, FEATURES, VERDICTS, verdictsFor, computeMeasures, type Landmarks, type Measures, type Verdicts } from './landmarks.js';
import { CompositeError, FACE_SOURCES, FACE_VIEWS, mayBeNegative, type FaceRecord } from './plan.js';

export interface FaceInsert {
  workspaceId: string;
  imageKey: string;
  source: FaceRecord['source'];
  sourceRef: string;
  personName?: string | null;
  sex?: FaceRecord['sex'];
  view: FaceRecord['view'];
  landmarks?: Landmarks;
  licence?: string | null;
  attribution?: string | null;
  /** Verdicts the source's own overlay gave this frame (gallery_frame rows): the calibration set. */
  sourceVerdict?: Partial<Record<(typeof FEATURES)[number], 'pos' | 'neg'>> | null;
}

export interface FaceStore {
  list(workspaceId: string): Promise<FaceRecord[]>;
  /** Insert, or return the existing row for (workspace, source, sourceRef). */
  upsert(row: FaceInsert): Promise<FaceRecord>;
  /** Replace landmarks/measures/verdicts after a (re)tag. */
  saveTags(id: string, tags: { landmarks: Landmarks; measures: Measures; verdicts: Verdicts }): Promise<void>;
  /** Calibration set: gallery rows that arrived pre-labelled and tagged. */
  listCalibration(workspaceId: string): Promise<Array<FaceRecord & { sourceVerdict: Record<string, 'pos' | 'neg'> }>>;
}

const json = <T>(schema: z.ZodType<T>, text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : fallback;
  } catch { return fallback; }
};
const MeasuresSchema = z.object({
  ramusLengthRatio: z.number().optional(), gonialAngleDeg: z.number().optional(),
  canthalTiltDeg: z.number().optional(), chinProjectionRatio: z.number().optional(),
});
const VerdictsSchema = z.record(z.enum(FEATURES), z.enum(VERDICTS));
const SourceVerdictSchema = z.record(z.string(), z.enum(['pos', 'neg']));

type Row = {
  id: string; workspaceId: string; imageKey: string; source: string; sourceRef: string; personName: string | null; sex: string; view: string;
  landmarksJson: string; measuresJson: string; verdictsJson: string; licence: string | null; attribution: string | null;
  sourceVerdictJson: string | null; createdAt: Date;
};

export function decodeFace(row: Row): FaceRecord & { sourceVerdict: Record<string, 'pos' | 'neg'> } {
  if (!(FACE_SOURCES as readonly string[]).includes(row.source) || !(FACE_VIEWS as readonly string[]).includes(row.view)) {
    throw new CompositeError('bad_face_row', `face ${row.id} has an unknown source or view`);
  }
  return {
    id: row.id, workspaceId: row.workspaceId, imageKey: row.imageKey,
    source: row.source as FaceRecord['source'], sourceRef: row.sourceRef, personName: row.personName,
    sex: (['male', 'female'] as string[]).includes(row.sex) ? row.sex as 'male' | 'female' : 'unknown',
    view: row.view as FaceRecord['view'],
    landmarks: json(LandmarksSchema as z.ZodType<Landmarks>, row.landmarksJson, {}),
    measures: json(MeasuresSchema, row.measuresJson, {}),
    verdicts: json(VerdictsSchema as z.ZodType<Verdicts>, row.verdictsJson, {}),
    licence: row.licence, attribution: row.attribution, createdAt: row.createdAt,
    sourceVerdict: json(SourceVerdictSchema, row.sourceVerdictJson, {}),
  };
}

/**
 * Library invariants checked before any write: a commons row is the only kind
 * that may carry a person's name, and it must say which licence lets us use the
 * photo. Synthetic and gallery rows never carry a name.
 */
export function assertInsertable(row: FaceInsert): void {
  if (row.source === 'commons') {
    if (!row.personName?.trim()) throw new CompositeError('commons_requires_person_name');
    if (!row.licence?.trim()) throw new CompositeError('commons_requires_licence');
  } else if (row.personName) {
    throw new CompositeError('only_commons_may_name_a_person', `${row.source} rows are unnamed by construction.`);
  }
  if (!row.sourceRef.trim() || !row.imageKey.trim()) throw new CompositeError('bad_face_row', 'imageKey and sourceRef are required.');
}

export const prismaFaceStore: FaceStore = {
  async list(workspaceId) {
    const rows = await db.faceLibrary.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(decodeFace);
  },
  async upsert(row) {
    assertInsertable(row);
    const existing = await db.faceLibrary.findFirst({ where: { workspaceId: row.workspaceId, source: row.source, sourceRef: row.sourceRef } });
    if (existing) return decodeFace(existing);
    const landmarks = row.landmarks ?? {};
    const measures = computeMeasures(landmarks);
    const created = await db.faceLibrary.create({
      data: {
        id: randomUUID(), workspaceId: row.workspaceId, imageKey: row.imageKey, source: row.source, sourceRef: row.sourceRef,
        personName: row.personName ?? null, sex: row.sex ?? 'unknown', view: row.view,
        landmarksJson: JSON.stringify(landmarks), measuresJson: JSON.stringify(measures), verdictsJson: JSON.stringify(verdictsFor(measures)),
        licence: row.licence ?? null, attribution: row.attribution ?? null,
        sourceVerdictJson: row.sourceVerdict ? JSON.stringify(row.sourceVerdict) : null,
        taggedAt: Object.keys(landmarks).length ? new Date() : null,
      },
    });
    return decodeFace(created);
  },
  async saveTags(id, tags) {
    await db.faceLibrary.update({
      where: { id },
      data: { landmarksJson: JSON.stringify(tags.landmarks), measuresJson: JSON.stringify(tags.measures), verdictsJson: JSON.stringify(tags.verdicts), taggedAt: new Date() },
    });
  },
  async listCalibration(workspaceId) {
    const rows = await db.faceLibrary.findMany({ where: { workspaceId, source: 'gallery_frame', sourceVerdictJson: { not: null }, taggedAt: { not: null } } });
    return rows.map(decodeFace).filter(r => Object.keys(r.sourceVerdict).length > 0);
  },
};

/** Faces the planner may draw from: tagged (at least one verdict) rows only. */
export const usableFaces = (faces: readonly FaceRecord[]): FaceRecord[] =>
  faces.filter(f => Object.values(f.verdicts).some(v => v === 'pos' || v === 'neg'));

export { mayBeNegative };
