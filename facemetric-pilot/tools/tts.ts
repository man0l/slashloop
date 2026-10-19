// One MP3 per beat (ElevenLabs Flash v2.5, voice "george", via OpenRouter), cached by text hash.
// Writes assets/<reel>/timing.json, which the composition reads.
// Usage: npx tsx tools/tts.ts R01
import {execFileSync, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {abs, addSpend, args, loadScript, log, pool, speech, TTS_SPEED} from './lib';

const PRICE_PER_CHAR = 0.00002; // OpenRouter list price for elevenlabs/eleven-flash-v2.5

const duration = (file: string) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

// Leading / trailing silence in seconds, so beats cut on the last word instead of the clip end.
const silence = (file: string, total: number) => {
  const err = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-45dB:d=0.06', '-f', 'null', '-']).stderr.toString();
  const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const lead = starts[0] !== undefined && starts[0] < 0.02 && ends[0] !== undefined ? ends[0] : 0;
  const lastStart = starts[starts.length - 1];
  const trail = lastStart !== undefined && lastStart > lead && (ends.length < starts.length || ends[ends.length - 1] > total - 0.05) ? total - lastStart : 0;
  // Keep a few frames of breath on both sides.
  return {lead: +Math.max(0, lead - 0.03).toFixed(3), trail: +Math.max(0, trail - 0.05).toFixed(3)};
};

const main = async () => {
  const script = loadScript(args().pos[0] ?? 'R01');
  const dir = abs(`assets/${script.id}/vo`);
  fs.mkdirSync(dir, {recursive: true});
  let chars = 0;
  const beats = await pool(script.beats, 4, async (b) => {
    const hash = crypto.createHash('sha1').update(`eleven-flash-v2.5|george|${TTS_SPEED}|${b.vo}`).digest('hex').slice(0, 12);
    const rel = `${script.id}/vo/${hash}.mp3`;
    const file = abs(`assets/${rel}`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, await speech(b.vo));
      chars += b.vo.length;
      addSpend(script.id, 'tts', 'elevenlabs/eleven-flash-v2.5', b.vo.length * PRICE_PER_CHAR, {chars: b.vo.length});
    }
    const seconds = duration(file);
    return {file: rel, hash, vo: b.vo, seconds, ...silence(file, seconds)};
  });
  const used = new Set(beats.map((b) => `${b.hash}.mp3`));
  for (const f of fs.readdirSync(dir)) if (!used.has(f)) fs.unlinkSync(`${dir}/${f}`); // drop stale clips
  const total = beats.reduce((s, b) => s + b.seconds - b.lead - b.trail + 0.3, 0);
  fs.writeFileSync(abs(`assets/${script.id}/timing.json`), JSON.stringify({beats, voiceSeconds: total}, null, 2));
  log(`${script.id}: ${beats.length} clips, ${chars} new chars, ~${total.toFixed(1)} s with tails`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
