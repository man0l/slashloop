#!/usr/bin/env node
// Builds every asset the Lipstick composition needs. All AI calls go through
// OpenRouter (OPENROUTER_API_KEY); stock b-roll comes from Mixkit (free
// license). Idempotent: existing files in public/ are kept; pass
// --force=<step>[,<step>] (model|shades|vo|music|sfx|stock|all) to redo one.
//
//   1. model   — a fictional woman, bare lips (google/gemini-2.5-flash-image)
//   2. shades  — the same photo re-lipsticked per shade, then aligned onto
//                the base with scripts/align.py so swaps don't jump
//   3. vo      — openai/gpt-audio-mini, one clip per beat
//   4. music   — google/lyria-3-clip-preview instrumental bed
//   5. sfx     — pop / whoosh / tick synthesised with ffmpeg (no downloads)
//   6. stock   — Mixkit clips listed in content.json
//
// Writes public/manifest.json (read by the composition), including a
// per-call OpenRouter cost log.

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

const force = new Set(process.argv.filter((a) => a.startsWith('--force=')).flatMap((a) => a.slice(8).split(',')));
const MODELS = {
  image: process.env.LS_IMAGE_MODEL ?? 'google/gemini-2.5-flash-image',
  tts: process.env.LS_TTS_MODEL ?? 'openai/gpt-audio-mini',
  music: process.env.LS_MUSIC_MODEL ?? 'google/lyria-3-clip-preview',
};
const VOICE = process.env.LS_VOICE ?? 'shimmer';
const TEMPO = Number(process.env.LS_VO_TEMPO ?? 1.12);

for (const d of ['', 'shades', 'vo', 'sfx', 'stock']) mkdirSync(join(PUB, d), { recursive: true });
const manifestPath = join(PUB, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const forced = (step) => force.has(step) || force.has('all');
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const duration = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));

// --- OpenRouter ----------------------------------------------------------------

function logCost(model, cost) {
  if (typeof cost !== 'number') return;
  (manifest.costLog ??= []).push({ at: new Date().toISOString(), model, cost });
  save();
}

async function openrouter(body, { stream = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'lipstick-video' },
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

async function image(prompt, inputFile) {
  const parts = [{ type: 'text', text: prompt }];
  if (inputFile) {
    parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(inputFile).toString('base64')}` } });
  }
  const r = await openrouter({
    model: MODELS.image,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: '9:16' },
    messages: [{ role: 'user', content: parts }],
  });
  const url = r.choices[0].message.images?.[0]?.image_url?.url;
  if (!url) throw new Error('image model returned no image');
  return Buffer.from(url.split(',', 2)[1], 'base64');
}

// --- 1. model ------------------------------------------------------------------

const baseFile = join(PUB, 'shades', 'bare.png');
if (forced('model') || !existsSync(baseFile)) {
  console.log('• generating model…');
  writeFileSync(baseFile, await image(content.model.prompt));
  force.add('shades');
}
const meta = await sharp(baseFile).metadata();
manifest.base = { w: meta.width, h: meta.height };

// --- 2. shades -------------------------------------------------------------------

manifest.shades ??= { bare: 'shades/bare.png' };
const edited = [];
for (const s of [...content.shades, ...content.reds]) {
  if (!s.shade || (manifest.shades[s.id] && !forced('shades') && existsSync(join(PUB, manifest.shades[s.id])))) continue;
  console.log(`• lipstick → ${s.label}…`);
  const out = join(PUB, 'shades', `${s.id}.png`);
  const buf = await image(content.model.editPrompt.replace('{shade}', s.shade), baseFile);
  await sharp(buf).resize(meta.width, meta.height, { fit: 'fill' }).png().toFile(out);
  manifest.shades[s.id] = `shades/${s.id}.png`;
  edited.push(out);
  save();
}
if (edited.length) {
  console.log('• aligning shades…');
  execFileSync('python3', [join(ROOT, 'scripts/align.py'), baseFile, ...edited], { stdio: 'inherit' });
}

if (edited.length || !manifest.lips) {
  execFileSync('python3', [join(ROOT, 'scripts/lips.py'), manifestPath, baseFile, join(PUB, 'shades', 'red.png')], { stdio: 'inherit' });
  Object.assign(manifest, { lips: JSON.parse(readFileSync(manifestPath, 'utf8')).lips });
}

// --- 3. voiceover -----------------------------------------------------------------

function finishVo(raw, file) {
  ffmpeg(
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw,
    '-af', `silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,atempo=${TEMPO},loudnorm=I=-16:TP=-1.5`,
    '-ar', '48000', file,
  );
}

manifest.vo ??= {};
for (const [id, text] of Object.entries(content.vo)) {
  const file = join(PUB, 'vo', `${id}.wav`);
  const prev = manifest.vo[id];
  if (!forced('vo') && prev?.text === text && prev.tempo === TEMPO && existsSync(file)) continue;
  if (!forced('vo') && prev?.text === text && existsSync(`${file}.pcm`)) {
    finishVo(`${file}.pcm`, file);
  } else {
    // gpt-audio sometimes "answers" a question in the script instead of just
    // reading it. Retry when the clip is far longer than the words justify.
    const words = text.split(/\s+/).length;
    const maxSec = words / 2.2 + 1.5;
    for (let attempt = 1; ; attempt++) {
      console.log(`• voiceover: ${id}${attempt > 1 ? ` (retry ${attempt})` : ''}`);
      const res = await openrouter(
        {
          model: MODELS.tts,
          modalities: ['text', 'audio'],
          audio: { voice: VOICE, format: 'pcm16' },
          messages: [
            {
              role: 'system',
              content:
                'You are a text-to-speech engine for a short beauty-science video. Speak the text inside <script> tags aloud ' +
                'exactly as written, word for word, in a warm, confident, conversational tone at a brisk pace. It may contain ' +
                'questions: read them as questions, never answer them. Say nothing before or after the script.',
            },
            { role: 'user', content: `<script>${text}</script>` },
          ],
        },
        { stream: true },
      );
      const chunks = [];
      for await (const d of sseDeltas(res, MODELS.tts)) if (d.audio?.data) chunks.push(Buffer.from(d.audio.data, 'base64'));
      writeFileSync(`${file}.pcm`, Buffer.concat(chunks));
      finishVo(`${file}.pcm`, file);
      const got = duration(file);
      if (got <= maxSec || attempt >= 4) {
        if (got > maxSec) console.warn(`  ${id}: still ${got.toFixed(1)}s (expected ≤ ${maxSec.toFixed(1)}s) — check it`);
        break;
      }
      console.log(`  ${id}: ${got.toFixed(1)}s is too long for ${words} words`);
    }
  }
  manifest.vo[id] = { file: `vo/${id}.wav`, text, tempo: TEMPO, durationSec: duration(file) };
  save();
}

// --- 4. music ----------------------------------------------------------------------

const musicFile = join(PUB, 'music.mp3');
if ((forced('music') || !existsSync(musicFile)) && process.env.LS_SKIP_MUSIC !== '1') {
  console.log('• generating music…');
  try {
    const res = await openrouter(
      {
        model: MODELS.music,
        modalities: ['text', 'audio'],
        messages: [
          {
            role: 'user',
            content:
              'Instrumental only, no vocals. 40 seconds of playful, slightly flirty minimal electronic pop for a beauty explainer: ' +
              'finger snaps, soft muted plucks, warm bass, light shaker, 104 BPM, steady, no big drops, sits quietly under a voiceover.',
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
    writeFileSync(`${musicFile}.${fmt}`, Buffer.concat(chunks));
    ffmpeg('-i', `${musicFile}.${fmt}`, '-ar', '48000', '-b:a', '192k', musicFile);
    manifest.music = 'music.mp3';
  } catch (err) {
    console.warn(`  music skipped: ${err.message}`);
    manifest.music = null;
  }
  save();
}

// --- 5. sfx (synthesised) --------------------------------------------------------------

const SFX = {
  // short pitched "pop" for UI elements appearing
  pop: ['-f', 'lavfi', '-i', 'sine=f=880:d=0.09', '-af', 'afade=t=out:st=0:d=0.09,asetrate=48000*1.5,aresample=48000,volume=0.6'],
  // filtered noise swoosh for transitions
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=d=0.45:c=pink:a=0.5', '-af', 'highpass=f=500,lowpass=f=4000,afade=t=in:d=0.2,afade=t=out:st=0.2:d=0.25,volume=0.5'],
  // soft tick for the selector / counters
  tick: ['-f', 'lavfi', '-i', 'sine=f=2400:d=0.03', '-af', 'afade=t=out:st=0:d=0.03,volume=0.35'],
};
manifest.sfx ??= {};
for (const [id, args] of Object.entries(SFX)) {
  const file = join(PUB, 'sfx', `${id}.wav`);
  if (forced('sfx') || !existsSync(file)) ffmpeg(...args, '-ar', '48000', file);
  manifest.sfx[id] = `sfx/${id}.wav`;
}
save();

// --- 6. stock b-roll -----------------------------------------------------------------

manifest.stock ??= {};
for (const [id, url] of Object.entries(content.stock.clips)) {
  const file = join(PUB, 'stock', `${id}.mp4`);
  if (forced('stock') || !existsSync(file)) {
    console.log(`• stock: ${id}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stock ${id}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  manifest.stock[id] = { file: `stock/${id}.mp4`, durationSec: duration(file), source: url };
}
save();

const spent = (manifest.costLog ?? []).reduce((a, c) => a + c.cost, 0);
console.log(`✓ assets ready → ${manifestPath}  (logged OpenRouter spend: $${spent.toFixed(4)})`);
