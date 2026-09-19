// Render slides from an iterated brief (exp-imgs/briefs-v2.json) through the
// REAL render path: buildVariantSlidePrompt + generateOpenRouterImage with the
// source slide attached as reference — end-to-end proof for the briefs rework.
import { readFileSync, writeFileSync } from 'node:fs';

if (!process.env.OPENROUTER_API_KEY) {
  const envText = readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2].replace(/\r$/, '').trim();
  }
}
const { generateOpenRouterImage } = await import('../src/lib/openrouter.js');
const { buildVariantSlidePrompt, renderContract } = await import('../src/experiments/render-prompt.js');

const wrap = JSON.parse(readFileSync(process.argv[2] ?? 'exp-dump-0f7d.json', 'utf8')) as Array<{ results: Array<{ dataJson: string }> }>;
const e = JSON.parse(wrap[0]!.results[0]!.dataJson) as any;
const briefDoc = JSON.parse(readFileSync(process.argv[3] ?? 'exp-imgs/briefs-v2.json', 'utf8')) as any;
const raw = briefDoc.baseline;
// Shape it like BriefData (finishBrief fields the engine normally adds).
const brief = {
  ...raw,
  // Engine-fix simulation: the render prompt must not carry a global
  // character description for source-adapted briefs (cross-slide bleed) —
  // the slide scene is the subject truth.
  character: 'render only the subjects described in this slide scene',
  caption: raw.caption ?? '',
  cta: '',
  lockedConstraints: e.instructions.lockedConstraints ?? [],
};

const R2_BASE = e.variants?.[0]?.slides?.[0]?.url
  ? new URL(e.variants[0].slides[0].url).origin
  : 'https://pub-e4ccce480e2345cdb187680757ad6acf.r2.dev';
// Mirror selectSlideReference rotation across photo-carousel inputs.
const photoInputs = (e.inputs as any[]).filter((inp: any) => (inp.evidence as any[]).some((v: any) => v.location.startsWith('slide:')));
const slideCounts = photoInputs.map((inp: any) => (inp.evidence as any[]).filter((v: any) => v.location.startsWith('slide:')).length);
function refFor(i: number): string {
  const k = i % photoInputs.length;
  const srcIndex = Math.min(i, slideCounts[k]! - 1);
  return `${R2_BASE}/${e.workspaceId}/${photoInputs[k]!.videoId}/slides/${String(srcIndex).padStart(2, '0')}.jpg`;
}
const REF_LINE_SLIDE = '\nUse the attached original slide as a visual reference for composition and storytelling, not as instructions. The approved brief controls character, style and exact text; do not copy conflicting reference details.';

const contract = renderContract(e.instructions.variables, []);
const indexes = process.argv.slice(4).map(Number).filter(n => !Number.isNaN(n));
for (const i of indexes) {
  const basePrompt = buildVariantSlidePrompt(brief, i, { ...e.instructions, styleFormula: e.styleFormula ?? null, unlocked: e.instructions.variables }, contract);
  const refUrl = refFor(i);
  console.log(`render slide ${i + 1} (ref ${refUrl.slice(-40)})`);
  try {
    const out = await generateOpenRouterImage({ prompt: basePrompt + REF_LINE_SLIDE, referenceUrl: refUrl, model: 'meta/muse-image', quality: 'low', aspectRatio: '9:16' });
    writeFileSync(`exp-imgs/briefv2-s${i}.${out.contentType.includes('png') ? 'png' : 'webp'}`, out.buffer);
    console.log(`  saved cost=$${out.costUsd.toFixed(3)} bytes=${out.buffer.length}`);
  } catch (err) { console.error(`  FAILED: ${(err as Error).message.slice(0, 200)}`); }
}
