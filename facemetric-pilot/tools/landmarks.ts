// Ask the vision model for named facial landmarks on every still of a reel.
// Writes assets/<reel>/<still>.landmarks.json as {name: [x, y]} normalized to the still.
// Usage: npx tsx tools/landmarks.ts R01 [--only A_base] [--force]
import fs from 'node:fs';
import {abs, addSpend, args, loadScript, log, pool, vision} from './lib';

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
    const names = profileKeys.has(k) || /profile/i.test(k) ? PROFILE : FRONT;
    let raw: Record<string, [number, number]> | null = null;
    for (let t = 0; t < 3 && !raw; t++) {
      const r = await vision(prompt(names), [img], true);
      addSpend(script.id, 'landmarks', 'vision', r.cost, {still: k});
      try {
        raw = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
      } catch {
        log(`${k}: unparseable landmark reply, retrying`);
      }
    }
    if (!raw) throw new Error(`${k}: no landmarks after 3 tries`);
    const lm: Record<string, [number, number]> = {};
    for (const n of Object.keys(names)) {
      const v = raw[n];
      if (Array.isArray(v) && v.length === 2) lm[n] = [+(v[1] / 1000).toFixed(4), +(v[0] / 1000).toFixed(4)];
    }
    fs.writeFileSync(out, JSON.stringify(lm, null, 2));
    log(`${k}: ${Object.keys(lm).length}/${Object.keys(names).length} landmarks`);
  });
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
