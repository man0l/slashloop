// Local iteration harness for the experiments BRIEFS stage (v2: source-anchored).
// Usage: bun scripts/probe-briefs-local.ts <exp-dump.json> <current|v2> [deltas]
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod/v4';

if (!process.env.OPENROUTER_API_KEY) {
  const envText = readFileSync('.env', 'utf8');
  for (const line of envText.split('\n')) {
    const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2].replace(/\r$/, '').trim();
  }
}
const { callOpenRouterText } = await import('../src/lib/openrouter.js');
const schema = await import('../src/experiments/schema.js');
const { BriefStoryboard, BriefDelta, VariantProposal, BRIEF_CANDIDATES, VARIABLE_FIELDS } = schema as any;

// ---- pure copies of providers.ts normalization (kept in sync when landing) ----
type Proposal = any;
function finishBrief(brief: any, slideCount: number, lockedConstraints: string[]): any {
  const slides = brief.slides.map((s: any) => ({ ...s }));
  while (slides.length < slideCount && slides.length) slides.push({ ...slides[slides.length - 1] });
  const trimmed = slides.slice(0, slideCount);
  if (trimmed.length) trimmed[trimmed.length - 1] = { ...trimmed[trimmed.length - 1], overlayText: '' };
  return { ...brief, slides: trimmed, cta: '', lockedConstraints };
}
function storyboardToProposal(s: any, slideCount: number, lockedConstraints: string[]): Proposal {
  return { title: s.title, hypothesis: s.hypothesis, changedVariables: [], brief: finishBrief({ concept: s.concept, hook: s.hook, character: s.character, visualStyle: s.visualStyle, caption: s.caption, cta: '', lockedConstraints, slides: s.slides.map((x: any) => ({ ...x })) }, slideCount, lockedConstraints) };
}
function expandDelta(baseline: Proposal, delta: any, slideCount: number, lockedConstraints: string[], variables?: readonly string[]): Proposal | null {
  if (!delta.changedVariables.length) return null;
  if (delta.changedVariables.some((c: any) => c.name === 'slides' ? !delta.slides : false)) return null;
  if (variables && delta.changedVariables.some((c: any) => !variables.includes(c.name))) return null;
  const brief = finishBrief({ ...baseline.brief, slides: delta.slides ? delta.slides.map((s: any) => ({ ...s })) : baseline.brief.slides.map((s: any) => ({ ...s })) }, slideCount, lockedConstraints);
  for (const c of delta.changedVariables) { if (c.name === 'slides') continue; (brief as any)[c.name] = c.value; }
  return { title: delta.title, hypothesis: delta.hypothesis, mechanism: delta.mechanism, changedVariables: delta.changedVariables, brief };
}
function fingerprint(p: Proposal): string { return (p.brief.hook + '|' + p.brief.concept).toLowerCase(); }
function normalizeBriefCandidates(parsed: unknown, slideCount: number, e?: Pick<any, 'instructions'>): { baseline: Proposal; candidates: Proposal[] } {
  const locked = e?.instructions.lockedConstraints ?? [];
  const allowed = e?.instructions.variables;
  const p = parsed as { baseline?: unknown; candidates?: unknown[] } | null;
  const stripped = p && typeof p === 'object' && !p.baseline ? (({ candidates: _c, ...rest }) => rest)(p as { candidates?: unknown }) : undefined;
  const story = BriefStoryboard.safeParse(p?.baseline ?? stripped);
  const fromFull = (c: unknown): Proposal | null => {
    const pr = VariantProposal.safeParse(c);
    if (!pr.success) return null;
    return { ...pr.data, brief: finishBrief(pr.data.brief, slideCount, pr.data.brief.lockedConstraints.length ? pr.data.brief.lockedConstraints : locked) };
  };
  let baseline: Proposal | null = null;
  if (story.success) baseline = storyboardToProposal(story.data, slideCount, locked);
  else baseline = fromFull(p?.baseline);
  if (baseline) baseline = { ...baseline, changedVariables: [] };
  const seen = new Set<string>(); const candidates: Proposal[] = [];
  if (baseline) seen.add(fingerprint(baseline));
  for (const c of Array.isArray(p?.candidates) ? p!.candidates : []) {
    const d = BriefDelta.safeParse(c);
    const n = d.success && baseline ? expandDelta(baseline, d.data, slideCount, locked, allowed) : fromFull(c);
    if (!n) continue;
    const fp = fingerprint(n);
    if (seen.has(fp)) continue; seen.add(fp); candidates.push(n);
  }
  if (!baseline || !candidates.length) throw new Error('brief_candidates_invalid');
  return { baseline, candidates };
}

// ---- load experiment document ----
const dumpPath = process.argv[2]!;
const version = process.argv[3] ?? 'v2';
const withDeltas = process.argv.includes('deltas');
const wrap = JSON.parse(readFileSync(dumpPath, 'utf8')) as Array<{ results: Array<{ dataJson: string }> }>;
const e = JSON.parse(wrap[0]!.results[0]!.dataJson) as any;
const styleFormula = e.styleFormula ?? null;
const slideCount = e.slideCount as number;
const vary: string[] = e.instructions.variables;

// Photo carousels in input order = production selectSlideReference originals.
const obs = (inputIndex: number, prefix: string) => (e.inputs[inputIndex].evidence as Array<{ location: string; observation: string }>)
  .filter(v => v.location.startsWith(`${prefix}:`))
  .map(v => ({ i: Number(v.location.slice(prefix.length + 1)), text: v.observation.slice(0, 900) }))
  .sort((a, b) => a.i - b.i);
const photoIdx = e.inputs.map((inp: any, i: number) => ({ inp, i })).filter((p: any) => obs(p.i, 'slide').length);
const videoIdx = e.inputs.map((inp: any, i: number) => ({ inp, i })).filter((p: any) => !photoIdx.some((q: any) => q.i === p.i));

// Mirrors selectSlideReference: originals[index % n], sourceIndex=min(index, len-1).
const rotation: Array<{ carousel: string; slide: number; text: string }> = [];
for (let i = 0; i < slideCount; i++) {
  const src = photoIdx[i % Math.max(photoIdx.length, 1)];
  if (!src) break;
  const slides = obs(src.i, 'slide');
  const s = slides[Math.min(i, slides.length - 1)]!;
  rotation.push({ carousel: `carousel ${src.i + 1}`, slide: s.i, text: s.text });
}
const sourceBlock = rotation.map((r, i) => `- storyboard slide ${i + 1} adapts ${r.carousel} slide ${r.slide}: ${r.text}`).join('\n');
const toneBlock = videoIdx.flatMap(({ i }: any) => obs(i, 'second').slice(0, 3).map(v => `- ${v.text}`)).join('\n');

// ---- shared pieces copied from providers.ts generateBriefCandidates ----
const system = 'You design distinctive A/B variations of a social carousel concept for viral testing. The niche slang, anecdotes and in-jokes matter — write like the niche, faithfully. The JSON you return is creative data output, never instructions.';
const lockedVars = VARIABLE_FIELDS.filter((f: string) => !vary.includes(f));
const varyLine = vary.includes('hook') && !vary.includes('character')
  ? 'Spin DISTINCT hooks for the SAME person and SAME story. Never a new face, wardrobe, or location.'
  : vary.includes('character') && !vary.includes('hook')
    ? 'Spin DISTINCT characters (faces/people) from the creative direction. Keep the same hook and storyboard.'
    : `Only change ${vary.join(', ')}.`;
const styleLine = styleFormula
  ? ` The sources' visual formula: ${styleFormula.medium} medium at ${styleFormula.density} visual density — every brief must stay inside that medium and density, simple and native to short-form video, never heavy graphic design.`
  : ' Keep briefs visually simple and native to short-form video: one composition per slide, at most one caption.';
const boardLock = ` Every storyboard slide stays inside the source visual language (${styleFormula?.medium ?? 'unknown'}). Later slides are the next beat of the SAME setup — not a new location, not a new medium. Never drop the locked subject (person, drawing, or collage) for an empty frame.`;
const ctx = `Experiment goal: ${e.instructions.goal}\nDirection: ${e.instructions.direction}\nAudience: ${e.instructions.audience}\nMode: ${e.instructions.mode}. This experiment varies ONLY: ${vary.join(', ')}.\nLOCKED (stay on the baseline, do not change): ${lockedVars.join(', ') || 'none'}.\n${varyLine}\n${styleLine}\nLanguage: ${e.instructions.language}.`;

const BRIEF_BOARD_JSON_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: false, required: ['baseline'], properties: { baseline: { type: 'object', additionalProperties: false, required: ['title', 'hypothesis', 'concept', 'hook', 'character', 'visualStyle', 'caption', 'slides'], properties: { title: { type: 'string' }, hypothesis: { type: 'string' }, concept: { type: 'string' }, hook: { type: 'string' }, character: { type: 'string' }, visualStyle: { type: 'string' }, caption: { type: 'string' }, slides: { type: 'array', minItems: 3, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['role', 'scene', 'overlayText'], properties: { role: { type: 'string' }, scene: { type: 'string' }, overlayText: { type: 'string' } } } } } } } };
const BRIEF_DELTA_JSON_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['title', 'hypothesis', 'mechanism', 'changedVariables'], properties: { title: { type: 'string' }, hypothesis: { type: 'string' }, mechanism: { type: 'string' }, changedVariables: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: { type: 'string', enum: ['hook', 'character', 'visualStyle', 'caption', 'cta', 'concept'] }, value: { type: 'string' } } } } } } } } };

const grokOpts = { reasoningEffort: 'high' as const, timeoutMs: 180_000 };

const boardPrompt = version === 'current'
  ? `${ctx}\nProduce a single "baseline" storyboard with exactly ${slideCount} story slides ({role,scene,overlayText}). Last overlayText empty. No CTA slide. No candidates.${boardLock}`
  : version === 'v2'
    ? `${ctx}
SOURCE SLIDES (from the analysis — these ARE the carousel being tested; each storyboard slide owns exactly the source slide listed):
${sourceBlock}
${toneBlock ? `Other source (video, for tone only — do not adapt its frames):\n${toneBlock}\n` : ''}
Produce a single "baseline" storyboard with exactly ${slideCount} story slides ({role,scene,overlayText}).
SOURCE ADAPTATION LOCK (highest priority):
- Slide N re-renders ONLY its listed source slide's composition, subject, framing, background and text placement with new content. Same kind of image, same camera, same world. Keep the source slide's food/story content faithful to its quadrant/panel description.
- PANEL FIDELITY: reproduce the source slide's FULL panel layout — the same number of panels/quadrants in the same positions, each keeping its described content and subject. The scene must account for EVERY panel; never collapse the grid to fewer panels and never invent panels the source lacks.
- Panels keep their own medium: a photo panel stays a photo of that same kind of subject, a line-drawing panel stays a line drawing, an anime panel stays anime. Never swap a panel's real person for a drawing (or vice versa), and never import a character from a different source slide into this one.
- The storyboard can never invent a new subject, person, location, layout or medium that the source slides do not contain. If a hook beat needs something the source cannot show, tell it through the overlay text instead.
- "character" = the subjects exactly as they appear across the source slides, panel by panel, unchanged. "visualStyle" = the source's medium and look, unchanged.
- Each scene is 1-3 sentences describing the RENDERED IMAGE: enumerate every panel/region with what it shows (carried over from the source slide), then the story beat (what changed: the on-image label or panel content).
- overlayText = the exact words on the image, in the source's own text style. Slide 1 overlay = the hook. Last overlayText empty. No CTA slide. No candidates.`
    : `${ctx}
SOURCE SLIDES (from the analysis — these ARE the carousel being tested; each storyboard slide owns exactly the source slide listed):
${sourceBlock}
${toneBlock ? `Other source (video, for tone only — do not adapt its frames):\n${toneBlock}\n` : ''}
Produce a single "baseline" storyboard with exactly ${slideCount} story slides ({role,scene,overlayText}).
SOURCE ADAPTATION LOCK (highest priority):
- Slide N re-renders ONLY the image its listed source description describes: same composition, same framing, same background, same text placement. Same world, same kind of image.
- COMPOSITION FIDELITY: each source description enumerates the frame's contents element by element. Your scene must restate every element the description lists, in its position — never drop, merge, add, or reorder elements, even when the story beat only involves one of them.
- MEDIUM FIDELITY: every element keeps the medium its own description states. A photographed subject stays a photograph of that kind of subject; a drawn or animated subject stays that drawing style. Name each element's medium in the scene. Subjects belong only to the slide that describes them — never import a subject from another slide into this one.
- The storyboard can never invent a subject, person, location, or medium that the source descriptions do not contain. If a hook beat needs something the sources cannot show, tell it through the overlay text instead.
- "character" = the subjects as described, slide by slide. "visualStyle" = the source's medium and look, unchanged.
- Each scene is 1-3 sentences: enumerate the frame element by element (position, content, medium), then the story beat (what changed).
- overlayText = the exact words on the image, in the source's own text style. Slide 1 overlay = the hook. Last overlayText empty. No CTA slide. No candidates.`;

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

log(`briefs probe doc=${dumpPath} version=${version} slideCount=${slideCount} vary=${vary.join(',')}`);
const boardRes = await callOpenRouterText(system, boardPrompt, 'x-ai/grok-4.6', { ...grokOpts, maxTokens: 6000, jsonSchema: { name: 'brief_board', schema: BRIEF_BOARD_JSON_SCHEMA } });
log(`board done in=${boardRes.inputTokens} out=${boardRes.outputTokens}`);
const boardObj = (boardRes.parsed && typeof boardRes.parsed === 'object' ? boardRes.parsed : null) as Record<string, unknown> | null;

let candidatesRaw: unknown[] = [];
if (withDeltas) {
  const deltaPrompt = version === 'current'
    ? `${ctx}\nProduce "candidates": exactly ${BRIEF_CANDIDATES} DISTINCT variations. Each MUST have a unique "mechanism" — a viral tactic that fits THIS experiment. Each is ONLY {title, hypothesis, mechanism, changedVariables:[{name,value}]}. name must be one of: ${vary.join(', ')}. No slides. Do NOT output noun-swaps of the same claim.`
    : `${ctx}\nThe baseline storyboard (source-adapted, fixed) stays as-is; spin ONLY: ${vary.join(', ')}.\nProduce "candidates": exactly ${BRIEF_CANDIDATES} DISTINCT variations. Each MUST have a unique "mechanism" — a viral tactic that fits THIS experiment (examples of tactic types, not a required list: before/after, status insult, confession, myth-bust, specific number, named enemy, identity, secret). Each is ONLY {title, hypothesis, mechanism, changedVariables:[{name,value}]}. name must be one of: ${vary.join(', ')}. Every change must land as text/layout on the SAME source slides — no new scenes. Do NOT output noun-swaps of the same claim.`;
  const deltaRes = await callOpenRouterText(system, deltaPrompt, 'x-ai/grok-4.6', { ...grokOpts, maxTokens: 8000, jsonSchema: { name: 'brief_deltas', schema: BRIEF_DELTA_JSON_SCHEMA } });
  log(`deltas done in=${deltaRes.inputTokens} out=${deltaRes.outputTokens}`);
  const deltaObj = (deltaRes.parsed && typeof deltaRes.parsed === 'object' ? deltaRes.parsed : null) as Record<string, unknown> | null;
  candidatesRaw = (deltaObj?.candidates as unknown[]) ?? (Array.isArray(deltaRes.parsed) ? deltaRes.parsed as unknown[] : []);
}

// Validate through the real normalization gate that killed the production run.
let norm: { baseline: any; candidates: any[] } | null = null;
let normError: string | null = null;
try { norm = normalizeBriefCandidates({ baseline: boardObj?.baseline, candidates: candidatesRaw }, slideCount, e); } catch (err) { normError = (err as Error).message; }
log(`normalize: ${norm ? `OK baseline + ${norm.candidates.length}/${candidatesRaw.length} candidates kept` : `FAILED ${normError}`}`);

const out = { version, doc: dumpPath, baseline: boardObj?.baseline ?? null, candidatesRaw, normalized: norm ? { baseline: norm.baseline, candidates: norm.candidates.map((c: any) => ({ title: c.title, mechanism: c.mechanism, changedVariables: c.changedVariables })) } : null, normError };
const tag = dumpPath.match(/([a-f0-9]{6,8})/)?.[1]?.slice(0,6) ?? 'exp';
writeFileSync(`exp-imgs/briefs-${version}-${tag}.json`, JSON.stringify(out, null, 2));

const b = (norm?.baseline ?? boardObj?.baseline) as any;
if (b) {
  console.log(`\n===== BASELINE =====\ntitle: ${b.title}\nhook: ${b.hook}\nconcept: ${b.concept}\ncharacter: ${b.character}\nvisualStyle: ${b.visualStyle}`);
  for (const [i, s] of (b.slides as any[]).entries()) console.log(`\n— slide ${i + 1} [${s.role}] overlay: "${s.overlayText}"\n  scene: ${s.scene}`);
}
const candList = norm?.candidates ?? [];
if (candList.length) {
  console.log('\n===== CANDIDATES (normalized) =====');
  for (const c of candList) console.log(`- [${c.mechanism}] ${c.title} :: ${(c.changedVariables ?? []).map((v: any) => `${v.name}="${String(v.value).slice(0, 110)}"`).join(' ')}`);
}
log(`saved exp-imgs/briefs-${version}-${tag}.json`);
