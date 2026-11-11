#!/usr/bin/env node
// Builds every asset the FaceShapes composition needs, using OpenRouter for
// all AI calls. Idempotent: anything already in public/ is kept, so delete a
// file to regenerate it (or pass --force=<step>).
//
//   1. base face   — an AI-generated, fictional model (no real person)
//   2. landmarks   — a vision model locates the face so outlines line up
//   2b. face morphs — the same man re-shaped into each face shape
//                    (google/gemini-3-pro-image), then aligned to the base
//                    by scripts/align_faces.py (needs opencv-python-headless)
//   3. celebs      — Pinterest search per shape; a vision model picks the
//                    best frontal headshot and returns a face crop box
//   4. voiceover   — openai/gpt-audio, one clip per segment
//   5. music       — an original bed from google/lyria (optional)
//
// Writes public/manifest.json, which the Remotion composition reads; every
// call's OpenRouter cost is appended to manifest.costLog.
//
// Requires OPENROUTER_API_KEY and ffmpeg/ffprobe on PATH.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const content = JSON.parse(readFileSync(join(ROOT, 'content.json'), 'utf8'));
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error('Set OPENROUTER_API_KEY');

const force = new Set(
  process.argv.filter((a) => a.startsWith('--force=')).flatMap((a) => a.slice(8).split(',')),
);
const MODELS = {
  image: process.env.FS_IMAGE_MODEL ?? 'google/gemini-2.5-flash-image',
  vision: process.env.FS_VISION_MODEL ?? 'google/gemini-2.5-flash',
  tts: process.env.FS_TTS_MODEL ?? 'openai/gpt-audio-mini',
  music: process.env.FS_MUSIC_MODEL ?? 'google/lyria-3-clip-preview',
  // the cheaper flash image model barely changes face outlines; pro does
  morph: process.env.FS_MORPH_MODEL ?? 'google/gemini-3-pro-image',
};
const VOICE = process.env.FS_VOICE ?? 'onyx';
const TEMPO = Number(process.env.FS_VO_TEMPO ?? 1.15); // speed-up, pitch preserved

for (const d of ['', 'celebs', 'celebs/candidates', 'vo', 'faces']) mkdirSync(join(PUB, d), { recursive: true });

const manifestPath = join(PUB, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const need = (step, file) => force.has(step) || force.has('all') || !existsSync(file);

// --- OpenRouter -------------------------------------------------------------

async function openrouter(body, { stream = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'face-shapes-video' },
      body: JSON.stringify({ ...body, stream, usage: { include: true } }),
    });
    if (res.ok && stream) return res;
    if (res.ok) {
      const json = await res.json();
      logCost(body.model, json.usage?.cost);
      return json;
    }
    const text = await res.text();
    if (attempt >= 3 || res.status < 500) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// Every call's USD cost (OpenRouter `usage.cost`) is appended to manifest.costLog.
function logCost(model, cost) {
  if (typeof cost !== 'number') return;
  manifest.costLog ??= [];
  manifest.costLog.push({ at: new Date().toISOString(), model, cost });
  save();
}

/** Read an SSE completion stream: yields each choice delta, logs the final usage cost. */
async function* sseDeltas(res, model) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
      const evt = JSON.parse(line.slice(5));
      if (evt.usage) logCost(model, evt.usage.cost);
      for (const c of evt.choices ?? []) if (c.delta) yield c.delta;
    }
  }
}

const dataUrl = (file) => {
  const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
};

async function visionJson(prompt, images) {
  const content = [{ type: 'text', text: prompt }];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Image ${i}:` });
    content.push({ type: 'image_url', image_url: { url: dataUrl(img) } });
  });
  const r = await openrouter({
    model: MODELS.vision,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }],
  });
  const raw = r.choices[0].message.content.replace(/^```(json)?|```$/gm, '').trim();
  return JSON.parse(raw);
}

// --- helpers ----------------------------------------------------------------

const probe = (file, entry) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
const imageSize = (file) => {
  const [w, h] = probe(file, 'stream=width,height').split(',').map(Number);
  return { w, h };
};
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

// --- 1. base face ------------------------------------------------------------

const baseFile = join(PUB, content.baseFace.file);
if (need('base', baseFile)) {
  console.log('• generating base face…');
  const r = await openrouter({
    model: MODELS.image,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: '9:16' },
    messages: [{ role: 'user', content: content.baseFace.prompt }],
  });
  const url = r.choices[0].message.images?.[0]?.image_url?.url;
  if (!url) throw new Error('image model returned no image');
  writeFileSync(baseFile, Buffer.from(url.split(',', 2)[1], 'base64'));
  force.add('landmarks');
}

// --- 2. landmarks -------------------------------------------------------------

if (force.has('landmarks') || !manifest.detectedLandmarks) {
  console.log('• locating face landmarks…');
  const lm = await visionJson(
    `Locate facial landmarks on this frontal portrait. Return JSON with integer coordinates normalized 0-1000 ` +
      `(x from left edge, y from top edge) for these keys, each as {"x":..,"y":..}:\n` +
      `"hairline" (top-center of the forehead: the point where forehead SKIN meets the hair — NOT the top of the hair/head), "chin" (bottom-most point of the chin), ` +
      `"templeL","templeR" (outer forehead edges at eyebrow height minus a bit, viewer's left/right), ` +
      `"cheekL","cheekR" (outer edge of the face at cheekbone height, excluding ears), ` +
      `"jawL","jawR" (jaw corners / gonial angles), "eyeL","eyeR" (pupil centres). Only JSON.`,
    [baseFile],
  );
  const { w, h } = imageSize(baseFile);
  manifest.base = { file: content.baseFace.file, w, h };
  manifest.detectedLandmarks = Object.fromEntries(Object.entries(lm).map(([k, v]) => [k, { x: v.x / 1000, y: v.y / 1000 }]));
}
// content.json → baseFace.landmarkOverrides lets you nudge any point (0-1 coords)
manifest.landmarks = { ...manifest.detectedLandmarks, ...(content.baseFace.landmarkOverrides ?? {}) };
save();

// --- 2b. face morphs -----------------------------------------------------------
// The same man, re-shaped into each face shape. The composition dissolves
// between them, so the face itself turns round, long, heart-shaped… The
// `reveal` shape uses the untouched base (his real shape).

manifest.faces ??= {};
const morphed = [];
for (const shape of content.shapes) {
  if (shape.reveal || !shape.morph) continue;
  const out = join(PUB, 'faces', `${shape.id}.png`);
  if (!need('faces', out) && !force.has(`face:${shape.id}`) && manifest.faces[shape.id]?.morph === shape.morph) continue;
  console.log(`• morphing face → ${shape.name}…`);
  const r = await openrouter({
    model: MODELS.morph,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: '9:16' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: content.baseFace.morphPrompt.replace('{shape}', shape.morph + '.') },
          { type: 'image_url', image_url: { url: dataUrl(baseFile) } },
        ],
      },
    ],
  });
  const url = r.choices[0].message.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`morph model returned no image for ${shape.id}`);
  // the model returns a slightly different 9:16 size; stretch back onto the
  // base dimensions (a ~2% change) so the frames overlay 1:1
  const { w, h } = manifest.base;
  await sharp(Buffer.from(url.split(',', 2)[1], 'base64')).resize(w, h, { fit: 'fill' }).png().toFile(out);
  manifest.faces[shape.id] = { file: `faces/${shape.id}.png`, morph: shape.morph };
  morphed.push(out);
  save();
}
if (morphed.length) {
  // re-register each new face onto the base so the dissolves don't jump
  console.log('• aligning faces…');
  execFileSync('python3', [join(ROOT, 'scripts/align_faces.py'), manifestPath, baseFile, ...morphed], { stdio: 'inherit' });
}

// --- 3. celebrity reference shots (Pinterest) ---------------------------------

async function pinterestSearch(query, n = 8) {
  const data = { options: { query, scope: 'pins', page_size: 25 }, context: {} };
  const params = new URLSearchParams({ source_url: `/search/pins/?q=${encodeURIComponent(query)}`, data: JSON.stringify(data) });
  const res = await fetch(`https://www.pinterest.com/resource/BaseSearchResource/get/?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      Accept: 'application/json',
      'X-Pinterest-PWS-Handler': 'www/search/[scope].js',
    },
  });
  if (!res.ok) throw new Error(`Pinterest ${res.status}`);
  const json = await res.json();
  return (json.resource_response?.data?.results ?? [])
    .map((p) => ({ pin: p.id, img: p.images?.['736x'] ?? p.images?.orig }))
    .filter((p) => p.img?.url && p.img.width >= 400 && p.img.height >= 400 && !/\.gif$/i.test(p.img.url))
    .slice(0, n);
}

manifest.celebs ??= {};
for (const shape of content.shapes) {
  const out = join(PUB, 'celebs', `${shape.id}.jpg`);
  const prev = manifest.celebs[shape.id];
  if (!need(`celeb:${shape.id}`, out) && !force.has('celebs') && prev?.name === shape.celeb) continue;
  console.log(`• ${shape.name}: searching Pinterest for ${shape.celeb}…`);
  const results = await pinterestSearch(`${shape.celeb} face portrait headshot`);
  const files = [];
  for (const [i, r] of results.entries()) {
    const f = join(PUB, 'celebs/candidates', `${shape.id}-${i}.jpg`);
    const res = await fetch(r.img.url);
    if (!res.ok) continue;
    const tmp = `${f}.src`;
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    ffmpeg('-i', tmp, '-vf', "scale='min(900,iw)':-2", '-q:v', '3', f); // normalise to jpg
    files.push({ file: f, pin: r.pin });
  }
  if (!files.length) throw new Error(`no Pinterest images for ${shape.celeb}`);
  const pick = await visionJson(
    `These are candidate photos of ${shape.celeb}. Choose the one best suited as a small face thumbnail: ` +
      `clearly ${shape.celeb}, ONE person, face front-on (not profile), well lit, sharp, no text/watermarks/collages, no heavy filters. ` +
      `Return JSON {"index": <image number>, "box": {"x0":..,"y0":..,"x1":..,"y1":..}} where box is a SQUARE-ish crop around the ` +
      `head (top of hair to just below chin, with a little margin), normalized 0-1000 relative to that image. ` +
      `If none qualify return {"index": -1}.`,
    files.map((f) => f.file),
  );
  if (pick.index < 0 || !files[pick.index]) throw new Error(`vision model rejected all photos of ${shape.celeb}`);
  const chosen = files[pick.index];
  const { w, h } = imageSize(chosen.file);
  const b = pick.box;
  // crop square around the box centre
  const cx = ((b.x0 + b.x1) / 2000) * w;
  const cy = ((b.y0 + b.y1) / 2000) * h;
  const side = Math.min(Math.max(((b.x1 - b.x0) / 1000) * w, ((b.y1 - b.y0) / 1000) * h) * 1.1, w, h);
  const x = Math.round(Math.min(Math.max(cx - side / 2, 0), w - side));
  const y = Math.round(Math.min(Math.max(cy - side / 2, 0), h - side));
  ffmpeg('-i', chosen.file, '-vf', `crop=${Math.round(side)}:${Math.round(side)}:${x}:${y},scale=400:400`, '-q:v', '2', out);
  manifest.celebs[shape.id] = { file: `celebs/${shape.id}.jpg`, name: shape.celeb, source: `https://www.pinterest.com/pin/${chosen.pin}/` };
  save();
}

// --- 4. voiceover -------------------------------------------------------------

function finishVo(raw, file) {
  // trim leading/trailing silence, speed up, normalise loudness
  ffmpeg(
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw,
    '-af', `silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,atempo=${TEMPO},loudnorm=I=-16:TP=-1.5`,
    '-ar', '48000', file,
  );
}

async function tts(text, file) {
  const res = await openrouter(
    {
      model: MODELS.tts,
      modalities: ['text', 'audio'],
      audio: { voice: VOICE, format: 'pcm16' },
      messages: [
        {
          role: 'system',
          content:
            'You are a voiceover artist for a short-form video. Read the user text aloud exactly as written, word for word, ' +
            'in a calm, confident, slightly intriguing tone at a brisk pace. Do not add or change any words.',
        },
        { role: 'user', content: text },
      ],
    },
    { stream: true },
  );
  const chunks = [];
  for await (const d of sseDeltas(res, MODELS.tts)) {
    if (d.audio?.data) chunks.push(Buffer.from(d.audio.data, 'base64'));
  }
  const raw = `${file}.pcm`;
  writeFileSync(raw, Buffer.concat(chunks));
  finishVo(raw, file);
}

const segments = [
  { id: 'hook', text: content.hook },
  ...content.shapes.map((s) => ({ id: s.id, text: s.line })),
  { id: 'cta', text: content.cta },
];
manifest.vo ??= {};
for (const seg of segments) {
  const file = join(PUB, 'vo', `${seg.id}.wav`);
  const prev = manifest.vo[seg.id];
  const sameText = prev?.text === seg.text;
  if (!need('vo', file) && sameText && prev.tempo === TEMPO) continue;
  if (sameText && existsSync(`${file}.pcm`) && !force.has('vo')) {
    finishVo(`${file}.pcm`, file); // only the tempo changed: no new API call
  } else {
    console.log(`• voiceover: ${seg.id}`);
    await tts(seg.text, file);
  }
  manifest.vo[seg.id] = { file: `vo/${seg.id}.wav`, text: seg.text, tempo: TEMPO, durationSec: Number(probe(file, 'format=duration')) };
  save();
}

// --- 5. music (optional) ------------------------------------------------------

const musicFile = join(PUB, 'music.mp3');
if (need('music', musicFile) && process.env.FS_SKIP_MUSIC !== '1') {
  console.log('• generating music bed…');
  try {
    const res = await openrouter(
      {
        model: MODELS.music,
        modalities: ['text', 'audio'],
        messages: [
          {
            role: 'user',
            content:
              'Instrumental only, no vocals. 35 seconds of minimal, slightly mysterious lo-fi electronic pulse for a ' +
              'fashion/grooming explainer video: soft plucked synth arpeggio, light hi-hats, warm sub bass, steady 100 BPM, ' +
              'no big drops, sits quietly under a voiceover.',
          },
        ],
      },
      { stream: true },
    );
    const chunks = [];
    let fmt = 'mp3';
    for await (const d of sseDeltas(res, MODELS.music)) {
      if (d.audio?.data) chunks.push(Buffer.from(d.audio.data, 'base64'));
      if (d.audio?.format) fmt = d.audio.format;
    }
    if (!chunks.length) throw new Error('no audio returned');
    const raw = `${musicFile}.${fmt}`;
    writeFileSync(raw, Buffer.concat(chunks));
    ffmpeg('-i', raw, '-ar', '48000', '-b:a', '192k', musicFile);
    manifest.music = 'music.mp3';
  } catch (err) {
    console.warn(`  music skipped: ${err.message}`);
    manifest.music = null;
  }
  save();
}

const spent = (manifest.costLog ?? []).reduce((a, c) => a + c.cost, 0);
console.log(`✓ assets ready → ${manifestPath}  (logged OpenRouter spend: $${spent.toFixed(4)})`);
