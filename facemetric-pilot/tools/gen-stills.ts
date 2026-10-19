// Generate the stills a script lists under `stills`, then QA each with a vision model.
// Usage: npx tsx tools/gen-stills.ts R01 [--only A_base,B_thin] [--force]
//   Base faces:  {"base": "man, age 38, <face description>"}   (text-to-image)
//   Edits:       {"from": "A_base", "edit": "<change>"}          (image-to-image on that still)
// If a still already exists on disk (e.g. you dropped in your own base photos) it is kept unless --force.
import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import {abs, addSpend, args, generateImage, IMAGE_MODELS, loadScript, log, vision} from './lib';

const BASE_PROMPT = (desc: string, profile: boolean) => {
  const [gender, ...rest] = desc.split(',');
  return (
    `Photorealistic studio portrait of one ${gender.trim()},${rest.join(',')}, ` +
    `${profile ? 'in exact side profile facing left' : 'front-facing, centred'}, head and shoulders, black turtleneck, ` +
    'flat dusty blue-grey seamless background, soft even front light, 85mm, neutral expression, no text.'
  );
};
const EDIT_PROMPT = (edit: string, retry: boolean) =>
  `Edit this photo of the same person. Change ONLY this: ${edit}. Keep identity, hair, expression, pose, lighting, ` +
  `framing, black turtleneck and blue-grey background exactly the same. Photorealistic.` +
  (retry ? ' Make the change clearly visible at a glance while staying realistic.' : '');

const QA_EDIT = (edit: string) =>
  `Image 1 is the original, image 2 is the edit. Is image 2 the same person as image 1, same pose and background, ` +
  `with only this changed: "${edit}"? Answer PASS or FAIL with one reason, on one line, e.g. "PASS - ..." or "FAIL - ...".`;
const QA_BASE = (desc: string) =>
  `Is this a single photorealistic studio portrait (head and shoulders, black turtleneck, flat blue-grey background, ` +
  `no text, no visible defects) of: ${desc}? Answer PASS or FAIL with one reason, on one line.`;

// Raw generations are kept at 2:3 (what the models return) as the reference for later edits;
// the still the reel shows is a fixed 4:5 window of it so every still of a face shares the framing.
const rawPath = (reel: string, k: string) => abs(`assets/${reel}/_raw/${k}.jpg`);
const saveStill = async (src: string, raw: string, display: string) => {
  fs.mkdirSync(path.dirname(raw), {recursive: true});
  const two3 = await sharp(src).resize(1080, 1620, {fit: 'cover', position: 'top'}).toBuffer();
  await sharp(two3).jpeg({quality: 92}).toFile(raw);
  await sharp(two3).extract({left: 0, top: 45, width: 1080, height: 1350}).jpeg({quality: 90}).toFile(display);
};

type QaRecord = {key: string; model: string; verdict: 'PASS' | 'FAIL'; reason: string; tries: number; cost: number};

const main = async () => {
  const {pos, flags, opt} = args();
  const script = loadScript(pos[0] ?? 'R01');
  const specs = script.stills ?? {};
  const only = opt('only')?.split(',');
  const qaPath = abs(`assets/${script.id}/qa.json`);
  const qa: Record<string, QaRecord> = fs.existsSync(qaPath) ? JSON.parse(fs.readFileSync(qaPath, 'utf8')) : {};
  fs.mkdirSync(abs(`assets/${script.id}/_tries`), {recursive: true});

  const done = new Set<string>();
  const pending = Object.keys(specs).filter((k) => !only || only.includes(k));
  for (const k of Object.keys(specs)) {
    if (fs.existsSync(rawPath(script.id, k)) && (!pending.includes(k) || !flags.has('--force'))) done.add(k);
  }

  const makeOne = async (k: string) => {
    const spec = specs[k];
    const dest = abs(script.faces[k]);
    let cost = 0;
    let last: QaRecord | null = null;
    let wrote = false;
    // Up to 2 tries on the preferred model, then 1 on the fallback model.
    const plan = [IMAGE_MODELS[0], IMAGE_MODELS[0], ...(IMAGE_MODELS[1] ? [IMAGE_MODELS[1]] : [])];
    for (let t = 0; t < plan.length; t++) {
      const model = plan[t];
      const tryFile = abs(`assets/${script.id}/_tries/${k}__${model.split('/')[1]}_${t}.png`);
      try {
        const ref = 'from' in spec ? rawPath(script.id, spec.from) : undefined;
        const prompt = 'from' in spec ? EDIT_PROMPT(spec.edit, t > 0) : BASE_PROMPT(spec.base, !!spec.profile);
        const img = await generateImage(model, prompt, ref);
        cost += img.cost;
        addSpend(script.id, 'image', model, img.cost, {still: k});
        fs.writeFileSync(tryFile, img.buffer);
        const q = await vision('from' in spec ? QA_EDIT(spec.edit) : QA_BASE(spec.base), ref ? [ref, tryFile] : [tryFile]);
        cost += q.cost;
        addSpend(script.id, 'qa', 'vision', q.cost, {still: k});
        const verdict = /^\W*PASS/i.test(q.text) ? 'PASS' : 'FAIL';
        last = {key: k, model, verdict, reason: q.text.replace(/\s+/g, ' ').slice(0, 200), tries: t + 1, cost};
        log(`${k} try ${t + 1} ${model}: ${q.text.slice(0, 120)}`);
        // Keep the first image as the fallback result; replace it only with a PASS.
        if (verdict === 'PASS' || !wrote) {
          await saveStill(tryFile, rawPath(script.id, k), dest);
          wrote = true;
        }
        if (verdict === 'PASS') break;
        if (t >= 1) break; // regenerate once on FAIL, then continue and flag it
      } catch (e) {
        log(`${k} try ${t + 1} ${model} error: ${(e as Error).message.slice(0, 200)}`);
        last = {key: k, model, verdict: 'FAIL', reason: (e as Error).message.slice(0, 200), tries: t + 1, cost};
      }
    }
    if (last) qa[k] = last;
    fs.writeFileSync(qaPath, JSON.stringify(qa, null, 2));
    done.add(k);
  };

  // Run in dependency waves: a still is ready to make once its `from` exists.
  let todo = pending.filter((k) => !done.has(k));
  while (todo.length) {
    const wave = todo.filter((k) => {
      const s = specs[k];
      return !('from' in s) || done.has(s.from);
    });
    if (!wave.length) throw new Error(`unresolvable stills: ${todo.join(', ')}`);
    log(`wave: ${wave.join(', ')}`);
    await Promise.all(wave.map(makeOne));
    todo = todo.filter((k) => !wave.includes(k));
  }
  const fails = Object.values(qa).filter((r) => r.verdict === 'FAIL');
  log(`done. QA FAILs: ${fails.map((f) => `${f.key} (${f.reason})`).join('; ') || 'none'}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
