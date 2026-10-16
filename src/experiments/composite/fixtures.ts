// Test fixtures for the composite modules: faces built from geometry, so a verdict
// in a test is always the one the production code computes from landmarks.
import { computeMeasures, verdictsFor, type Landmarks } from './landmarks.js';
import type { FaceRecord } from './plan.js';

const FACE_HEIGHT = 400;

/** A right-facing profile whose measures hit the requested values (face height 400). */
export function profileLandmarks(o: { ramus: number; tiltDeg?: number; projection?: number }): Landmarks {
  const ear = { x: 300, y: 300 };
  const tilt = ((o.tiltDeg ?? 0) * Math.PI) / 180;
  return {
    nasion: { x: 520, y: 200 },
    chin: { x: 520, y: 200 + FACE_HEIGHT },
    earTragus: ear,
    condyle: ear,
    gonion: { x: ear.x, y: ear.y + o.ramus * FACE_HEIGHT },
    subnasale: { x: 540, y: 400 },
    pogonion: { x: 540 + (o.projection ?? 0) * FACE_HEIGHT, y: 590 },
    canthusInner: { x: 480, y: 250 },
    canthusOuter: { x: 480 + 40 * Math.cos(tilt), y: 250 - 40 * Math.sin(tilt) },
  };
}

let n = 0;
export function face(over: Partial<FaceRecord> & { ramus?: number } = {}): FaceRecord {
  const { ramus = 0.45, ...rest } = over;
  const landmarks = rest.landmarks ?? profileLandmarks({ ramus, tiltDeg: 6, projection: 0.06 });
  const measures = computeMeasures(landmarks);
  const id = rest.id ?? `face-${++n}`;
  return {
    id, workspaceId: 'ws', imageKey: `ws/faces/${id}.jpg`, source: 'synthetic', sourceRef: id,
    personName: null, sex: 'male', view: 'profile', landmarks, measures, verdicts: verdictsFor(measures),
    licence: null, attribution: null, createdAt: new Date(0),
    ...rest,
  };
}
