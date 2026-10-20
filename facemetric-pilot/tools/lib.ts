// Shared helpers for the asset tools: env, OpenRouter calls, spend log, script loading.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {lintGeometry} from '../src/lintGeometry';
import {lintScript, parseScript, type Landmarks, type Script} from '../src/schema';

export const ROOT = path.resolve(__dirname, '..');
export const OR_BASE = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const IMAGE_MODELS = (process.env.FM_IMAGE_MODELS ?? 'meta/muse-image,openai/gpt-image-2.5-sunburst').split(',');
// ElevenLabs speed (0.7-1.2). 1.15 keeps 18-beat reels under a minute; set FM_TTS_SPEED=1 for Reel Factory pace.
export const TTS_SPEED = Number(process.env.FM_TTS_SPEED ?? 1.15);
export const VISION_MODEL = process.env.FM_VISION_MODEL ?? 'google/gemini-3.8-flash';

const key = () => {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new Error('OPENROUTER_API_KEY is not set (put it in .env)');
  return k;
};

export const loadScript = (idOrPath: string): Script => {
  const p = idOrPath.endsWith('.json') ? idOrPath : path.join(ROOT, 'scripts', `${idOrPath}.json`);
  const s = parseScript(JSON.parse(fs.readFileSync(p, 'utf8')));
  for (const w of lintScript(s)) {
    const why = Object.entries(s.lintAccept ?? {}).find(([k]) => w.startsWith(k))?.[1];
    console.warn(`[lint ${s.id}] ${w}${why ? `  (accepted: ${why})` : ''}`);
  }
  return s;
};

export const abs = (rel: string) => path.join(ROOT, rel);

// Landmark files for every still of a script that has one (the "source" tag is dropped).
export const loadLandmarks = (s: Script): Record<string, Landmarks> => {
  const out: Record<string, Landmarks> = {};
  for (const [k, rel] of Object.entries(s.faces)) {
    const f = path.join(ROOT, rel.replace(/\.(png|jpe?g)$/i, '.landmarks.json'));
    if (!fs.existsSync(f)) continue;
    const {source: _s, ...pts} = JSON.parse(fs.readFileSync(f, 'utf8'));
    void _s;
    out[k] = pts;
  }
  return out;
};
export const geometryWarnings = (s: Script) => lintGeometry(s, loadLandmarks(s));

export const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- spend ledger (assets/spend.jsonl, committed so the pilot's cost is auditable) ----
const SPEND = abs('assets/spend.jsonl');
export const addSpend = (reel: string, kind: string, model: string, cost: number, extra: Record<string, unknown> = {}) => {
  fs.appendFileSync(SPEND, JSON.stringify({ts: new Date().toISOString(), reel, kind, model, cost, ...extra}) + '\n');
};
export const spendSoFar = (reel?: string) => {
  if (!fs.existsSync(SPEND)) return 0;
  return fs
    .readFileSync(SPEND, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !reel || r.reel === reel)
    .reduce((s, r) => s + (Number(r.cost) || 0), 0);
};

export const balance = async (): Promise<number | null> => {
  try {
    const r = await fetch(`${OR_BASE}/credits`, {headers: {Authorization: `Bearer ${key()}`}});
    const d = (await r.json()) as {data: {total_credits: number; total_usage: number}};
    return d.data.total_credits - d.data.total_usage;
  } catch {
    return null;
  }
};

const post = async (p: string, body: unknown, timeoutMs = 240_000) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${OR_BASE}${p}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'X-Title': 'facemetric-pilot'},
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    return res;
  }
};

export const dataUrl = (file: string) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mt = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mt};base64,${fs.readFileSync(file).toString('base64')}`;
};

export const generateImage = async (model: string, prompt: string, ref?: string) => {
  const body: Record<string, unknown> = {
    model,
    prompt,
    // Muse takes 4:5 / png; the GPT image fallback only accepts its own ratios and jpeg (as Reel Factory's slides do).
    ...(model.includes('muse') ? {aspect_ratio: '4:5', output_format: 'png'} : {aspect_ratio: '2:3', output_format: 'jpeg', quality: 'medium'}),
  };
  if (ref) body.input_references = [{type: 'image_url', image_url: {url: dataUrl(ref)}}];
  const res = await post('/images', body);
  const text = await res.text();
  if (!res.ok) throw new Error(`image ${model} ${res.status}: ${text.slice(0, 400)}`);
  const d = JSON.parse(text) as {data?: {b64_json?: string}[]; usage?: {cost?: number}};
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error(`image ${model}: no data ${text.slice(0, 300)}`);
  return {buffer: Buffer.from(b64, 'base64'), cost: Number(d.usage?.cost ?? 0)};
};

export const vision = async (prompt: string, images: string[], json = false) => {
  const content = [{type: 'text', text: prompt}, ...images.map((i) => ({type: 'image_url', image_url: {url: dataUrl(i)}}))];
  const res = await post('/chat/completions', {
    model: VISION_MODEL,
    messages: [{role: 'user', content}],
    usage: {include: true},
    ...(json ? {response_format: {type: 'json_object'}} : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`vision ${res.status}: ${text.slice(0, 400)}`);
  const d = JSON.parse(text) as {choices: {message: {content: string}}[]; usage?: {cost?: number}};
  return {text: d.choices[0].message.content.trim(), cost: Number(d.usage?.cost ?? 0)};
};

export const speech = async (input: string) => {
  const res = await post('/audio/speech', {
    model: 'elevenlabs/eleven-flash-v2.5',
    voice: 'george',
    response_format: 'mp3',
    speed: TTS_SPEED,
    input,
  });
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
};

// Word timestamps for a voice clip (ElevenLabs Scribe v2 via OpenRouter, ~$0.0002 per clip).
export const transcribeWords = async (file: string) => {
  const fd = new FormData();
  fd.append('model', 'elevenlabs/scribe-v2');
  fd.append('file', new Blob([fs.readFileSync(file)], {type: 'audio/mpeg'}), path.basename(file));
  fd.append('timestamp_granularities[]', 'word');
  fd.append('response_format', 'verbose_json');
  const res = await fetch(`${OR_BASE}/audio/transcriptions`, {method: 'POST', headers: {Authorization: `Bearer ${key()}`}, body: fd});
  const text = await res.text();
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${text.slice(0, 300)}`);
  const d = JSON.parse(text) as {words?: {word: string; start: number; end: number}[]; usage?: {cost?: number}};
  return {words: d.words ?? [], cost: Number(d.usage?.cost ?? 0)};
};

export const pool = async <T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({length: Math.min(n, items.length)}, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j]);
      }
    }),
  );
  return out;
};

export const args = () => {
  const a = process.argv.slice(2);
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const pos = a.filter((x) => !x.startsWith('--'));
  const opt = (name: string) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {flags, pos, opt};
};
