// Named facial landmarks for every still of a reel: the vision model first, checked against anatomy rules (brief 9.1);
// on a violation it is re-asked naming the rule, and on a second violation MediaPipe Face Landmarker takes over
// (front stills). Writes assets/<reel>/<still>.landmarks.json as {source, name: [x, y]} normalized to the still.
// Usage: npx tsx tools/landmarks.ts R01 [--only A_base] [--force]
import fs from 'node:fs';
import {abs, addSpend, args, loadScript, log, pool, vision} from './lib';
import {mediapipeLandmarks} from './mediapipe';

// _L / _R = left / right side of the IMAGE (not the person's left).
export const FRONT = {
  hairline: 'top of the forehead where the hair starts, centre',
  glabella: 'point between the eyebrows',
  brow_inner_L: 'inner end of the eyebrow on the image-left side',
  brow_inner_R: 'inner end of the eyebrow on the image-right side',
  brow_outer_L: 'outer end of the eyebrow on the image-left side',
  brow_outer_R: 'outer end of the eyebrow on the image-right side',
  pupil_L: 'pupil of the image-left eye',
  pupil_R: 'pupil of the image-right eye',
  nose_tip: 'tip of the nose',
  subnasale: 'point where the base of the nose meets the upper lip',
  upper_lip_top: 'top edge (vermilion border) of the upper lip, centre',
  stomion: 'centre of the line where the lips meet',
  cheilion_L: 'mouth corner on the image-left side',
  cheilion_R: 'mouth corner on the image-right side',
  pogonion: 'most forward point of the chin',
  chin_bottom: 'lowest point of the chin (menton)',
  jaw_angle_L: 'angle of the jaw (gonion) on the image-left side',
  jaw_angle_R: 'angle of the jaw (gonion) on the image-right side',
  cheek_L: 'cheekbone high point on the image-left side',
  cheek_R: 'cheekbone high point on the image-right side',
  canthus_inner_L: 'inner corner of the image-left eye',
  canthus_outer_L: 'outer corner of the image-left eye',
  canthus_inner_R: 'inner corner of the image-right eye',
  canthus_outer_R: 'outer corner of the image-right eye',
  upper_lid_L: 'upper eyelid margin above the pupil, image-left eye',
  upper_lid_R: 'upper eyelid margin above the pupil, image-right eye',
  lower_lid_L: 'lower eyelid margin below the pupil, image-left eye',
  lower_lid_R: 'lower eyelid margin below the pupil, image-right eye',
  iris_centre_L: 'centre of the iris, image-left eye',
  iris_centre_R: 'centre of the iris, image-right eye',
  iris_edge_L: 'outer edge of the iris (towards the ear), image-left eye',
  iris_edge_R: 'outer edge of the iris (towards the ear), image-right eye',
  sclera_L: 'white of the eye between the iris and the outer corner, image-left eye',
  sclera_R: 'white of the eye between the iris and the outer corner, image-right eye',
  cheek_top_L: 'top of the cheek just below the lower eyelid, image-left side',
  cheek_top_R: 'top of the cheek just below the lower eyelid, image-right side',
};

type LM = Record<string, [number, number]>;
const y = (lm: LM, n: string) => lm[n]?.[1];

// Anatomy rules for a front still (brief 9.1). Returns the first rule broken, or null.
export const frontViolation = (lm: LM): string | null => {
  const chain: (string | string[])[] = [
    'hairline', ['brow_inner_L', 'brow_inner_R'], ['canthus_inner_L', 'canthus_inner_R', 'canthus_outer_L', 'canthus_outer_R'],
    'nose_tip', 'subnasale', 'upper_lip_top', 'stomion', 'chin_bottom',
  ];
  const ys = chain.map((g) => (Array.isArray(g) ? g : [g]).map((n) => ({n, v: y(lm, n)})).filter((p) => p.v !== undefined) as {n: string; v: number}[]);
  for (let i = 0; i < ys.length - 1; i++)
    for (const a of ys[i]) for (const b of ys[i + 1]) if (!(a.v < b.v)) return `${a.n} must be above ${b.n} (y ${a.v} vs ${b.v})`;
  for (const j of ['jaw_angle_L', 'jaw_angle_R']) {
    const v = y(lm, j);
    const lo = y(lm, 'stomion');
    const hi = y(lm, 'chin_bottom');
    if (v !== undefined && lo !== undefined && hi !== undefined && !(v > lo && v < hi)) return `${j} must lie between stomion and chin_bottom vertically (y ${v}, stomion ${lo}, chin_bottom ${hi})`;
  }
  const midX = lm.nose_tip?.[0] ?? lm.glabella?.[0];
  if (midX !== undefined)
    for (const s of ['L', 'R']) {
      const i = lm[`canthus_inner_${s}`];
      const o = lm[`canthus_outer_${s}`];
      if (i && o && !(Math.abs(o[0] - midX) > Math.abs(i[0] - midX))) return `canthus_outer_${s} must be further from the face midline than canthus_inner_${s}`;
    }
  return null;
};
export const PROFILE = {
  hairline: 'front hairline',
  glabella: 'most forward point between brow and nose root',
  brow_outer_L: 'eyebrow, outer end',
  brow_outer_R: 'eyebrow, inner end',
  nose_tip: 'tip of the nose (most forward point)',
  subnasale: 'point where the base of the nose meets the upper lip',
  upper_lip_top: 'most forward point of the upper lip',
  stomion: 'point where the lips meet',
  pogonion: 'most forward point of the chin',
  chin_bottom: 'lowest point of the chin',
  jaw_angle_L: 'angle of the jaw (gonion)',
  neck_point: 'deepest point where the under-chin meets the neck (cervical point)',
  forehead_top: 'top of the forehead at the front hairline, on the skull outline',
  vertex: 'highest point of the top of the head (skull outline, through short hair)',
  occiput: 'back-most point of the back of the head (skull outline, through short hair)',
};

const prompt = (names: Record<string, string>) =>
  `Locate these facial landmarks on the photo. Return JSON only, mapping each name to [y, x] in 0-1000 coordinates ` +
  `(0,0 = top-left of the image, 1000,1000 = bottom-right). Be precise to the pixel.\n` +
  Object.entries(names)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

const main = async () => {
  const {pos, flags, opt} = args();
  const script = loadScript(pos[0] ?? 'R01');
  const only = opt('only')?.split(',');
  const profileKeys = new Set(script.beats.filter((b) => b.view === 'profile').flatMap((b) => (b.img ? [b.img] : b.imgs ?? [])));
  const keys = Object.keys(script.faces).filter((k) => !only || only.includes(k));
  await pool(keys, 4, async (k) => {
    const img = abs(script.faces[k]);
    const out = img.replace(/\.(png|jpe?g)$/i, '.landmarks.json');
    if (!fs.existsSync(img)) return log(`${k}: no still yet, skipped`);
    if (fs.existsSync(out) && !flags.has('--force')) return;
    // A still is a profile if a beat shows it as one, its key says so, or its description (or an ancestor's) does.
    const describesProfile = (key: string, depth = 0): boolean => {
      const sp = script.stills?.[key];
      if (!sp || depth > 6) return false;
      if ('base' in sp) return /side profile/i.test(sp.base);
      return /side profile/i.test(sp.edit) || describesProfile(sp.from, depth + 1);
    };
    const names = profileKeys.has(k) || /profile/i.test(k) || describesProfile(k) ? PROFILE : FRONT;
    const ask = async (extra = ''): Promise<LM> => {
      let raw: Record<string, [number, number]> | null = null;
      for (let t = 0; t < 3 && !raw; t++) {
        const r = await vision(prompt(names) + extra, [img], true);
        addSpend(script.id, 'landmarks', 'vision', r.cost, {still: k});
        try {
          raw = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
        } catch {
          log(`${k}: unparseable landmark reply, retrying`);
        }
      }
      if (!raw) throw new Error(`${k}: no landmarks after 3 tries`);
      const lm: LM = {};
      for (const n of Object.keys(names)) {
        const v = raw[n];
        if (Array.isArray(v) && v.length === 2) lm[n] = [+(v[1] / 1000).toFixed(4), +(v[0] / 1000).toFixed(4)];
      }
      return lm;
    };
    const front = names === FRONT;
    let lm = await ask();
    let source: 'llm' | 'llm-retry' | 'mediapipe' = 'llm';
    let broken = front ? frontViolation(lm) : null;
    if (broken) {
      log(`${k}: ${broken}; re-asking`);
      lm = await ask(`\nA previous answer broke this anatomy rule: ${broken}. Re-check every point against the photo and fix it.`);
      source = 'llm-retry';
      broken = frontViolation(lm);
      if (broken) {
        log(`${k}: still broken (${broken}); using MediaPipe Face Landmarker`);
        const [mp] = await mediapipeLandmarks([img]);
        if (mp) {
          lm = mp;
          source = 'mediapipe';
        } else log(`${k}: MediaPipe found no face; keeping the re-asked answer (${broken})`);
      }
    }
    fs.writeFileSync(out, JSON.stringify({source, ...lm}, null, 2));
    log(`${k}: ${Object.keys(lm).length}/${Object.keys(names).length} landmarks (${source})`);
  });
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
