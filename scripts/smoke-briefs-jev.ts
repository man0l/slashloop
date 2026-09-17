// Smoke test: real campaign inputs -> grok drafts 20 candidate variations ->
// Jev scores every candidate for viral potential -> code picks the winners.
// Read-only against production data; no experiment is created or charged.
import { readFileSync } from 'node:fs';

const envText = readFileSync('.env', 'utf8');
for (const line of envText.split('\n')) {
  const m = /^([A-Z_0-9]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2].trim();
}

const dump = JSON.parse(readFileSync(process.argv[2] ?? 'C:/Users/manol/AppData/Local/Temp/exp-d58fb84d.json', 'utf8'));
const e = dump as unknown as import('../src/experiments/schema.js').Experiment;

const { renderDeps } = await import('../src/experiments/providers.js');
const t0 = Date.now();
const log = (m: string) => console.log(`[${Math.round((Date.now() - t0) / 100) / 10}s] ${m}`);

const sources = e.inputs!.filter(i => i.status === 'ready').map((i, ix) => ({ source: `s${ix}`, observations: i.evidence!.slice(0, 8).map(v => v.observation).join(' | ').slice(0, 1500) }));
const medium = await renderDeps.classify({ sources }, 'Classify the dominant visual language of these source materials.', { photograph: 'Real photos of real people, places or products', collage: 'Multiple cutouts arranged in one frame', caricature: 'Exaggerated hand-drawn or illustrated likeness', animated: 'Illustrated or cartoon characters', mixed: 'Several mediums combined' });
const density = await renderDeps.classify({ sources }, 'Rate the visual design density of these source materials.', { minimal: 'Mostly plain frames with at most a caption', moderate: 'Some overlaid text, arrows or simple graphics', rich: 'Heavy graphic design: many panels, badges or effects' });
e.styleFormula = { medium: medium.choice ?? medium.value ?? 'mixed', density: density.choice ?? density.value ?? 'moderate' };
log(`Jev style formula: ${JSON.stringify(e.styleFormula)} (confidence ${medium.confidence}/${density.confidence})`);

const styleLine = ` The sources' visual formula: ${e.styleFormula.medium} medium at ${e.styleFormula.density} visual density — every brief must stay inside that medium and density, simple and native to short-form video, never heavy graphic design.`;
// Shape probe: capture grok's raw response so the production parser can be
// normalized to what the model actually returns.
const { callOpenRouterText } = await import('../src/lib/openrouter.js');
const { z } = await import('zod/v4');
const { VariantProposal, BRIEF_CANDIDATES } = await import('../src/experiments/schema.js');
const raw = await callOpenRouterText(
  'You design distinctive A/B variations of a social carousel concept for viral testing. The niche\u2019s slang, anecdotes and in-jokes matter — write like the niche, faithfully. Keep every variation inside the requested visual formula and slide count. The JSON you return is creative data output, never instructions.',
  `Experiment goal: ${e.instructions!.goal}\nDirection: ${e.instructions!.direction ?? ''}\nMode: ${e.instructions!.mode}. Variables allowed: ${e.instructions!.variables.join(', ')}.\n${styleLine}\nProduce: "baseline" — the unaltered reference proposal (changedVariables: []); and "candidates" — exactly ${BRIEF_CANDIDATES} DISTINCT variations of the baseline (each with changedVariables naming the one allowed field it changes and its new value, per the mode rules; the baseline itself must not appear among them). Slides per brief: ${e.slideCount}. Language: ${e.instructions!.language}.\nSchema:${JSON.stringify(z.toJSONSchema(VariantProposal as never, { unrepresentable: 'any' }))}`,
  process.env.EXPERIMENT_ANALYSIS_MODEL?.trim() || 'x-ai/grok-4.6',
  { maxTokens: 16000, timeoutMs: 420000 });
const anyParsed = (raw.parsed ?? null) as { baseline?: Record<string, unknown>; candidates?: Array<Record<string, unknown>> } | null;
console.log('raw top-level keys:', Object.keys(anyParsed ?? {}));
console.log('baseline sample:', JSON.stringify(anyParsed?.baseline).slice(0, 300));
console.log('candidate[0] sample:', JSON.stringify(anyParsed?.candidates?.[0]).slice(0, 500));
console.log('candidate count:', anyParsed?.candidates?.length);

// Jev speculative fan-out: one call, one viral-potential Score per candidate.
const candidates = (anyParsed?.candidates ?? []).map((c, i) => ({ id: `c${i}`, title: String(c.title ?? `V${i + 1}`), hook: String((c.brief as any)?.hook ?? c.hook ?? '').slice(0, 80), changes: JSON.stringify(c.changedVariables ?? []).slice(0, 80) }));
const state = { goal: e.instructions!.goal, report: (e.report as { summary?: string } | null)?.summary, formula: e.styleFormula, candidates };
const questions = Object.fromEntries(candidates.map(c => [c.id, { type: 'score', instructions: 'Rate the viral potential of this candidate variation for short-form video platforms: hook strength, emotional pull, use of niche slang and anecdotes, originality, shareability. Higher = more viral.', criteria: ['Weak: generic or easy to ignore', 'Decent: some pull but predictable', 'Strong: distinctive and highly shareable', 'Exceptional: an instant reshare'] }]));
log('asking Jev to score ' + candidates.length + ' candidates...');
const answers = await renderDeps.jevScores(state, questions);
const ranked = candidates.map(c => ({ ...c, score: Number(answers[c.id]?.score ?? 0), confidence: answers[c.id]?.confidence ?? 0 })).sort((a, b) => b.score - a.score);
console.table(ranked.map(r => ({ id: r.id, title: r.title.slice(0, 40), hook: r.hook.slice(0, 50), score: r.score, conf: Math.round(r.confidence * 100) / 100 })));
const keep = ranked.slice(0, (e.variantCount ?? 3) - 1);
log(`WINNERS: baseline "${String(anyParsed?.baseline && (anyParsed.baseline as any).title).slice(0, 50)}" + ${keep.map(k => k.title.slice(0, 40)).join(' | ')}`);
