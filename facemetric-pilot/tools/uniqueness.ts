// Uniqueness + format report for a content-matrix reel (brief section 8.3). Writes out/<id>-uniqueness.md and
// out/<id>-vs-R01.png. Run after tools/render.ts (it needs timing.json and the contact sheets).
// Usage: npx tsx tools/uniqueness.ts M01
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {lintScript, lintTiming, type Beat, type Script} from '../src/schema';
import {abs, args, geometryWarnings, loadScript, log} from './lib';

// Template ranges from the item grammar (section 8.2) and spec v2 targets for visible changes per minute.
const RANGE: Record<Script['template'], {sec: [number, number]; changes: [number, number]}> = {
  C: {sec: [45, 55], changes: [25, 30]},
  A: {sec: [35, 40], changes: [12, 15]},
  B: {sec: [80, 95], changes: [20, 25]},
  Q: {sec: [40, 50], changes: [25, 30]},
};

// Frame phrases every reel may share (section 8, rules).
const FRAME = [
  'why do some men look better with',
  'why do some women look better with',
  'here is what different levels of',
  'here is what five levels of',
  'look like',
  'same face',
  'comes down to',
];
// Spec v2 section 3.2 example captions (the reference reels' wording).
const REFERENCE_CAPTIONS = [
  'WHY DO SOME MEN LOOK BETTER WITH ONE?', 'WHILE OTHERS JUST LOOK CREEPY?', 'THE UPPER LIP', 'FROM THE SIDE', 'PICK YOUR SHAPE',
  'THICK, DARK BROWS?', 'LOOKS DELIBERATE', 'KEEP IT TIDY', 'SHORT UPPER LIP?', 'TO THE MIDDLE', 'BETTER OR CREEPY?',
  'HERE IS WHAT DIFFERENT LEVELS OF JAW PROJECTION LOOK LIKE', 'ONE STUDY ON MEN: THE PREFERRED PROFILE', 'SMOOTH CHIN', 'CLEFT CHIN',
  'DEEPER =', 'IT DEPENDS', 'SOFT CLEFT WINS', 'TWO HALVES', 'READS WIDER', 'IDEAL?', 'SOFT, DEFINED', 'SMOOTH OR CLEFT?',
  'IF YOU SAID SMOOTH CHIN YOU PROBABLY LIKE A SOFTER, CLEANER LOOK', 'LONG UPPER LIP', 'STRONG NOSE', 'STRONG CHIN', 'ROOM TO FILL',
  'NO MATCH', 'MATCH', 'WIDER', 'DEEP SPLIT', 'NOTCHED EDGE', 'THAYER AND DOBSON, 2010', 'COMMENT WHERE YOU SIT',
];

const plain = (t: string) => t.replace(/\*/g, '').toUpperCase().replace(/[^A-Z0-9#+=' -]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (t: string) => plain(t).toLowerCase().split(' ').filter(Boolean);

// a. structural fingerprint per beat
const zoomBucket = (b: Beat) => {
  const z = b.view === 'closeup' ? b.zoom ?? 2 : b.zoom ?? 1;
  return z < 1.25 ? '1' : z < 1.75 ? '1.5' : '2+';
};
const fingerprint = (b: Beat) =>
  [
    b.layout,
    b.card ? 'card' : '-',
    b.view,
    zoomBucket(b),
    [...(b.anim ?? []), ...(b.then?.anim ?? [])].map((a) => a.t).sort().join('+') || '-',
    b.tint ?? '-',
    b.then ? 'then' : '-',
  ].join('|');

const editDistance = (a: string[], b: string[]) => {
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / Math.max(a.length, b.length, 1);
};

// c. 5-word n-grams, minus those inside a frame phrase
const ngrams = (texts: string[], n = 5) => {
  const out = new Set<string>();
  for (const t of texts) {
    const w = tokens(t);
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  }
  return out;
};
// An n-gram is a frame phrase if it sits inside one, allowing a trailing article ("...look better with a").
const inFrame = (g: string) => {
  const core = g.replace(/( (a|an|the))+$/, '');
  return FRAME.some((f) => f.includes(g) || (core !== g && f.endsWith(core)));
};

const textsOf = (s: Script) => [...s.beats.map((b) => b.vo), ...s.beats.map((b) => b.caption), ...s.beats.flatMap((b) => (b.then?.caption ? [b.then.caption] : []))];
const headlinesOf = (s: Script) => [...new Set(s.beats.flatMap((b) => [b.caption, ...(b.then?.caption ? [b.then.caption] : [])]).map(plain))];
const isFrameHeadline = (h: string) => FRAME.some((f) => h.toLowerCase().startsWith(f));

const fileHash = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// e. visible changes, measured on the MP4 exactly as the reference reels were (SPEC.md section 1): frames at
// 15 fps, 72x128 grey; an event is a step where > 4% of pixels change by > 18 levels, events 0.3 s apart.
const measuredChanges = (mp4: string) => {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=15,scale=72:128,format=gray', '-f', 'rawvideo', '-'], {
    maxBuffer: 1 << 30,
  });
  const px = 72 * 128;
  const n = Math.floor(raw.length / px);
  const events: number[] = [];
  for (let i = 1; i < n; i++) {
    let changed = 0;
    for (let k = 0; k < px; k++) if (Math.abs(raw[i * px + k] - raw[(i - 1) * px + k]) > 18) changed++;
    const t = i / 15;
    if (changed / px > 0.04 && (!events.length || t - events[events.length - 1] > 0.3)) events.push(t);
  }
  return {events: events.length, seconds: n / 15};
};

// e. visible changes (script count): framing / cut per beat, every anim, a then step and its anims, an inset, a grid reveal
const changesOf = (b: Beat) => 1 + (b.anim?.length ?? 0) + (b.then ? 1 + (b.then.anim?.length ?? 0) : 0) + (b.inset ? 1 : 0) + (b.arrows ? 1 : 0);

const main = async () => {
  const id = args().pos[0] ?? 'M01';
  const s = loadScript(id);
  const others = fs
    .readdirSync(abs('scripts'))
    .filter((f) => /^[RM]\d\d\.json$/.test(f) && f !== `${id}.json`)
    .map((f) => loadScript(path.basename(f, '.json')));
  const r01 = others.find((o) => o.id === 'R01');
  const ms = others.filter((o) => o.id.startsWith('M'));
  const fp = s.beats.map(fingerprint);
  const lines: string[] = [`# ${id} uniqueness and format report`, '', `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by tools/uniqueness.ts.`, ''];

  // a
  lines.push('## a. Structural fingerprint', '', '| beat | fingerprint (layout, card, view, zoom, anims, tint, then) |', '|---|---|');
  fp.forEach((f, i) => lines.push(`| ${i + 1} | \`${f}\` |`));
  lines.push('', '| compared with | template | normalised edit distance | rule |', '|---|---|---|---|');
  for (const o of [r01, ...ms].filter(Boolean) as Script[]) {
    const d = editDistance(fp, o.beats.map(fingerprint));
    const same = o.template === s.template;
    lines.push(`| ${o.id} | ${o.template} | ${d.toFixed(2)} | ${same ? (d >= 0.5 ? 'PASS (>= 0.5)' : 'FAIL (< 0.5)') : 'n/a (other template)'} |`);
  }

  // b
  const mine = headlinesOf(s);
  const theirs = r01 ? headlinesOf(r01) : [];
  const shared = mine.filter((h) => theirs.includes(h) && !isFrameHeadline(h));
  const union = new Set([...mine.filter((h) => !isFrameHeadline(h)), ...theirs.filter((h) => !isFrameHeadline(h))]);
  lines.push('', '## b. Headline sequence', '', mine.map((h, i) => `${i + 1}. ${h}`).join('\n'), '',
    `Jaccard overlap with R01's headline set (frame phrases excluded): **${(shared.length / Math.max(union.size, 1)).toFixed(2)}**` +
      `${shared.length ? ` - shared: ${shared.join(', ')}` : ''} - ${shared.length ? 'FAIL' : 'PASS'}`);

  // c
  const myGrams = [...ngrams(textsOf(s))];
  const check = (label: string, other: Set<string>) => {
    const hit = myGrams.filter((g) => other.has(g));
    const real = hit.filter((g) => !inFrame(g));
    return `| ${label} | ${myGrams.length} | ${hit.length} | ${real.length} (${((100 * real.length) / Math.max(myGrams.length, 1)).toFixed(1)}%) | ${real.length ? 'FAIL: ' + real.join(' / ') : 'PASS'} |`;
  };
  lines.push('', '## c. Text overlap (5-word n-grams of voice + headlines)', '', '| against | my n-grams | shared | shared outside frame phrases | rule |', '|---|---|---|---|---|');
  if (r01) lines.push(check('R01', ngrams(textsOf(r01))));
  lines.push(check('reference captions (spec v2 3.2)', ngrams(REFERENCE_CAPTIONS)));
  for (const m of ms) lines.push(check(m.id, ngrams(textsOf(m))));

  // d
  const hashes = new Map<string, string[]>();
  for (const dir of fs.readdirSync(abs('assets'))) {
    if (!/^[RM]\d\d$/.test(dir)) continue;
    for (const f of fs.readdirSync(abs(`assets/${dir}`))) {
      if (!/\.jpg$/.test(f)) continue;
      const h = fileHash(abs(`assets/${dir}/${f}`));
      hashes.set(h, [...(hashes.get(h) ?? []), `${dir}/${f}`]);
    }
  }
  const sharedAssets = [...hashes.values()].filter((v) => v.length > 1 && v.some((p) => p.startsWith(`${id}/`)));
  lines.push('', '## d. Assets shared with other reels', '', sharedAssets.length ? sharedAssets.map((v) => `- ${v.join(' = ')}`).join('\n') + '\n\nFAIL' : 'None. PASS');

  // e
  const timing = JSON.parse(fs.readFileSync(abs(`assets/${id}/timing.json`), 'utf8')) as {beats: {seconds: number; lead: number; trail: number}[]};
  const beatSec = timing.beats.map((b) => b.seconds - b.lead - b.trail + 0.3);
  const pushes = s.beats.filter((b, i) => i > 0 && b.transition === 'push').length;
  const duration = beatSec.reduce((a, b) => a + b, 0) - (pushes * 6) / 30;
  const changes = s.beats.reduce((n, b) => n + changesOf(b), 0);
  const mp4 = abs(`out/${id}.mp4`);
  const measured = fs.existsSync(mp4) ? measuredChanges(mp4) : null;
  const perMin = measured ? measured.events / (measured.seconds / 60) : changes / (duration / 60);
  const range = RANGE[s.template];
  const hl = (t: string) => (t.match(/\*\*([^*]+)\*\*/)?.[1] ?? '').replace(/[?!.]/g, '').trim();
  // The hook keyword: beats 1-2's highlight, or the ladder header's when the beats carry no headline.
  const first = [...[s.beats[0], s.beats[1]].filter(Boolean).map((b) => hl(b.caption)), ...(s.header ? [hl(s.header)] : [])].filter(Boolean);
  const last = s.beats[s.beats.length - 1];
  const lastWords = plain(s.beats.slice(-3).flatMap((b) => [b.caption, b.then?.caption ?? '']).join(' ') + ' ' + (s.header ?? ''));
  const answered = first.some((w) => w && lastWords.includes(w));
  const warnings = [...lintScript(s), ...lintTiming(s, beatSec), ...geometryWarnings(s)];
  const accepted = (w: string) => Object.entries(s.lintAccept ?? {}).find(([k]) => w.startsWith(k))?.[1];
  const measureBeats = s.beats.filter((b) => [...(b.anim ?? []), ...(b.then?.anim ?? [])].some((a) => a.t === 'measure' || a.t === 'box')).length;
  const hasSplitOrStrip = s.template === 'A' ? s.beats.some((b) => b.layout === 'strip') : s.beats.some((b) => b.layout === 'split');
  const payoff = ['grid2x2', 'strip', 'split'].includes(last.layout);
  const row = (name: string, ok: boolean, detail: string) => `| ${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail} |`;
  lines.push('', '## e. Format checklist', '', '| result | check | detail |', '|---|---|---|',
    row('hook in beat 1, answered in the last beat', answered, `hook keywords ${first.join(' / ')}; last headline "${lastWords}"`),
    row('lint: zero hard errors', true, 'script parses (zod strict)'),
    row('lint warnings listed with a reason', warnings.every((w) => !!accepted(w)), warnings.length ? warnings.map((w) => `${w} -> ${accepted(w) ?? 'NO REASON'}`).join('<br>') : 'no warnings'),
    row('>= 2 measure/box beats', measureBeats >= 2, `${measureBeats} beats`),
    row(s.template === 'A' ? '>= 1 strip' : '>= 1 split', hasSplitOrStrip, ''),
    row('grid / strip payoff', payoff, `last beat layout: ${last.layout}`),
    row('footer on every frame', true, 'Footer is rendered at the composition root, outside the beat sequences (src/Reel.tsx)'),
    (() => {
      const ok = duration >= range.sec[0] && duration <= range.sec[1];
      const why = s.lintAccept?.duration;
      return `| ${ok ? 'PASS' : why ? 'ACCEPTED' : 'FAIL'} | duration ${range.sec[0]}-${range.sec[1]} s | ${duration.toFixed(1)} s${!ok && why ? ` (${why})` : ''} |`;
    })(),
    row(`visible changes ${range.changes[0]}-${range.changes[1]}/min`, perMin >= range.changes[0] && perMin <= range.changes[1], measured
      ? `measured on the MP4 like the reference reels: ${measured.events} changes / ${measured.seconds.toFixed(1)} s = ${perMin.toFixed(1)}/min (script count, every anim: ${changes} = ${(changes / (duration / 60)).toFixed(1)}/min)`
      : `${changes} changes / ${duration.toFixed(1)} s = ${perMin.toFixed(1)}/min (script count)`),
  );

  // f
  const sheet = abs(`out/${id}-sheet.png`);
  const rSheet = abs('out/R01-sheet.png');
  if (fs.existsSync(sheet) && fs.existsSync(rSheet)) {
    const w = 720;
    const [a, b] = await Promise.all([rSheet, sheet].map((f) => sharp(f).resize(w).toBuffer()));
    const h = Math.round((w * 2880) / 1080);
    const label = (t: string) => Buffer.from(`<svg width="${w}" height="56"><rect width="${w}" height="56" fill="#0B1F3A"/><text x="16" y="38" font-size="28" font-family="sans-serif" font-weight="bold" fill="#fff">${t}</text></svg>`);
    await sharp({create: {width: w, height: (h + 56) * 2, channels: 3, background: '#0B1F3A'}})
      .composite([{input: label('R01 (recreation)'), left: 0, top: 0}, {input: a, left: 0, top: 56}, {input: label(`${id} (new, from matrix row)`), left: 0, top: h + 56}, {input: b, left: 0, top: h + 112}])
      .png()
      .toFile(abs(`out/${id}-vs-R01.png`));
    lines.push('', `## f. Contact sheets`, '', `out/${id}-vs-R01.png (R01 on top, ${id} below).`);
  }

  fs.writeFileSync(abs(`out/${id}-uniqueness.md`), lines.join('\n') + '\n');
  log(`out/${id}-uniqueness.md written`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
