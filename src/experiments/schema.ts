import { z } from 'zod/v4';

export class ExperimentError extends Error {
  constructor(public statusCode: number, public code: string, message = code) { super(message); }
}
export const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const Key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const text = z.string().trim().max(2000);
export const VARIABLE_FIELDS = ['hook', 'character', 'visualStyle', 'caption', 'cta', 'concept', 'slides'] as const;
const constraints = z.union([z.array(text.min(1)).max(20), text]).transform(v => typeof v === 'string' ? (v ? [v] : []) : v);
/** Explicit per-slide copy override (SLA-430 D3, SLA-431 request carrier). Keys are
 *  0-based slide indices; property presence decides — `""` clears the overlay and
 *  an omitted index is NOT a blank, it leaves that slide's copy unresolved so the
 *  value that would otherwise apply (resolved source copy, or the brief's own
 *  copy on a hook-varying experiment) stands. Optional so instructions and
 *  briefs stored before it keep working. */
export const CopyOverrides = z.record(z.string().regex(/^\d+$/), z.string().max(2000));
export const Instructions = z.object({
  goal: text.min(1), brand: text, audience: text, language: z.string().trim().min(1).max(80),
  direction: text, lockedConstraints: constraints,
  variables: z.array(z.union([z.enum(VARIABLE_FIELDS), z.literal('angle')]).transform(v => v === 'angle' ? 'concept' as const : v)).min(1).max(7), mode: z.enum(['controlled', 'exploration']),
  // Hook-test scope: when true, hook candidates may also retell the supporting
  // overlay copy (slides 2..N) while scenes stay locked to the baseline.
  // Optional so older experiments (stored without the key) keep working —
  // absent/falsy means slide-1-hook-only, as before.
  varySupportingOverlays: z.boolean().optional(),
  // SLA-431: the exact per-slide copy the user asked for, carried as structured
  // values instead of quoted prose in `direction`. This is what survives
  // normalization into the brief and the render request; prose alone does not.
  // It pins exact values, so it cannot be combined with a mode that deliberately
  // lets the model retell that same copy (see the superRefine guard below).
  copyOverrides: CopyOverrides.optional(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.variables).size !== v.variables.length) ctx.addIssue({ code: 'custom', message: 'Duplicate variables' });
  if (v.mode === 'controlled' && v.variables.some(x => x === 'concept' || x === 'slides')) {
    ctx.addIssue({ code: 'custom', message: 'Controlled variables: hook, character, visualStyle, caption, cta. Concept/slides require exploration.' });
  }
  if (v.copyOverrides && Object.keys(v.copyOverrides).length) {
    // Exact overrides and a supporting-copy retell are contradictory contracts:
    // one says "these words are the answer", the other "the model may rewrite
    // them". Refuse instead of silently letting one defeat the other.
    if (v.varySupportingOverlays) {
      ctx.addIssue({ code: 'custom', message: 'copyOverrides pins exact per-slide copy and cannot be combined with varySupportingOverlays, which authorizes the model to retell supporting copy.' });
    }
    if (v.variables.some(x => x === 'concept' || x === 'slides')) {
      ctx.addIssue({ code: 'custom', message: 'copyOverrides pins exact per-slide copy and cannot be combined with the concept or slides variable, whose own axis is retelling that copy.' });
    }
  }
});
export const BriefSlide = z.object({ role: z.string().min(1).max(80), scene: text.min(1), overlayText: text.default('') });
export const Brief = z.object({
  concept: text.min(1), hook: text.min(1), character: text, visualStyle: text.min(1), caption: text,
  cta: text, lockedConstraints: z.array(text.min(1)).max(20),
  slides: z.array(BriefSlide).min(3).max(8),
  copyOverrides: CopyOverrides.optional(),
}).strict();
/** One storyboard grok returns at the briefs fan-out. Candidates are deltas, not full carousels. */
export const BriefStoryboard = z.object({
  title: z.string().min(1).max(160), hypothesis: text.min(1),
  concept: text.min(1), hook: text.min(1), character: text.default(''), visualStyle: text.min(1).default('photograph'), caption: text.default(''),
  slides: z.array(BriefSlide).min(3).max(8),
});
/** Parameter-only variation. Slides are optional and only required when the changed variable is `slides`.
 * Concept/angle candidates may send `overlayTexts` (one per slide, in order) instead of full slides:
 * code merges them onto the baseline scenes, so the storyline is kept verbatim. */
export const BriefDelta = z.object({
  title: z.string().min(1).max(160), hypothesis: text.min(1),
  mechanism: z.string().min(1).max(80).optional(),
  changedVariables: z.array(z.object({
    // Case-insensitive enum match: toLowerCase alone never matches the
    // camelCase 'visualStyle', silently rejecting every delta that varies it.
    name: z.string().trim().transform(v => VARIABLE_FIELDS.find(f => f.toLowerCase() === v.toLowerCase()) ?? v).pipe(z.enum(VARIABLE_FIELDS)),
    value: text.min(1),
  })).min(1).max(7),
  slides: z.array(BriefSlide).min(3).max(8).optional(),
  overlayTexts: z.array(text.default('')).min(3).max(8).optional(),
});
export const Create = z.object({ workspaceId: Id, videoIds: z.array(Id).min(1).max(20), instructions: Instructions,
  variantCount: z.number().int().min(1).max(12), slideCount: z.number().int().min(3).max(8),
  maxCredits: z.number().int().min(1).max(10000), idempotencyKey: Key,
}).strict().superRefine((v, c) => { if (new Set(v.videoIds).size !== v.videoIds.length) c.addIssue({ code: 'custom', message: 'Duplicate videoIds' }); });
export const WorkspaceBody = z.object({ workspaceId: Id }).strict();
export const Command = WorkspaceBody.extend({ idempotencyKey: Key });
export const Plan = Command.extend({ allowPartial: z.boolean().optional() });
export const Retry = Command.extend({ variantIds: z.array(Id).min(1).max(12).optional(), taskIds: z.array(z.string().min(1)).min(1).max(150).optional() });
export const Generate = Command.extend({ variants: z.array(z.object({ id: Id, revision: z.number().int().positive() }).strict()).min(1).max(12) });
export const Estimate = WorkspaceBody.extend({ stage: z.enum(['plan', 'generate']), variantIds: z.array(Id).min(1).max(12).optional(), taskIds: z.array(z.string().min(1)).min(1).max(150).optional() });
export const EditBrief = WorkspaceBody.extend({ revision: z.number().int().positive(), brief: Brief });
/** Every job self-heals through 3 automatic retries, 1 minute apart (4 attempts total). */
export const MAX_TASK_ATTEMPTS = 4;
export const MAX_MANUAL_ATTEMPTS = 6;
/** Up to this many slide renders may run concurrently within one experiment. */
export const PARALLEL_SLIDES = 48;
/** Candidates rendered per slide; Jev (TypeSafe) picks the most viral one. */
export const SLIDE_FANOUT = 3;
/** Parameter deltas generated at the briefs stage; Jev ranks them, top variantCount-1 win. */
export const BRIEF_CANDIDATES = 8;
export const RETRY_BACKOFF_MS = 60_000;
export function retryBackoffMs(_attempts = 1): number {
  return RETRY_BACKOFF_MS;
}
export const Report = z.object({ summary: text.min(1), patterns: z.array(z.object({
  id: Id, name: z.string().min(1).max(100), description: text.min(1), sourceIds: z.array(Id).min(1).max(20),
  confidence: z.number().min(0).max(1), frequency: z.number().int().min(1).max(20),
  evidence: z.array(z.object({ videoId: Id, location: z.string().min(1).max(100), observation: text.min(1) }).strict()).min(1).max(20),
}).strict()).min(1).max(12) }).strict();
export const VariantProposal = z.object({ title: z.string().min(1).max(160), hypothesis: text.min(1),
  mechanism: z.string().min(1).max(80).optional(),
  changedVariables: z.array(z.object({ name: z.enum(VARIABLE_FIELDS), value: text.min(1) }).strict()).max(7), brief: Brief }).strict();
export type InstructionsData = z.infer<typeof Instructions>;
export type BriefData = z.infer<typeof Brief>;
export type ReportData = z.infer<typeof Report>;
export type Proposal = z.infer<typeof VariantProposal>;
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'unknown';
/** Source overlay-copy state per mapped slide. `unknown` is an evidence gap and is
 *  never treated as a verified blank (SLA-430 D2/D3). */
export type CopyState = 'observed_text' | 'observed_empty' | 'unknown';
export interface ObservedCopy { state: CopyState; text: string | null }
/** Per-check QA outcome. A composite pass requires every check to pass; `unknown`
 *  is unverified, never a pass (SLA-430 D8). */
export interface QaCheck { check: string; status: 'pass' | 'fail' | 'unknown'; reason?: string }
export interface SlideVerification {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  reasons: string[];
  checks: QaCheck[];
  contractHash: string;
  corrected: boolean;
  attempts: number;
}
/** Auditable QA record persisted even when the slide does not complete. */
export interface SlideQaRecord {
  verdict: SlideVerification['verdict'];
  contractHash: string;
  corrected: boolean;
  attempts: number;
  reasons: string[];
  checks: QaCheck[];
  prompt?: string;
}
export interface Task { id: string; kind: 'analysis' | 'report' | 'briefs' | 'slide'; target?: string; index?: number;
  status: StepStatus; attempts: number; charged: number; chargeRef?: string; startedAt?: number; error?: string; path?: string; nextAttemptAt?: number; }
export interface Input { videoId: string; status: string; analysisId: string | null; jobId: string | null; error: string | null;
  coverage: { basis: string; observed: number; total: number | null; complete: boolean } | null; evidence: Array<{ location: string; observation: string }>;
  /** Recorded source copy state per slide, kept outside the truncated prose so a
   *  blank can be distinguished from a failed extraction (SLA-430 D2). */
  copy?: Array<{ slideIndex: number; state: CopyState; text: string | null }>; }
export type GenerationBasis = 'text-directed' | 'source-referenced';
export interface Variant extends Proposal { id: string; revision: number; status: string; baselineId: string | null;
  generationBasis: GenerationBasis; history: Array<{ revision: number; brief: BriefData }>;
  /** Viral-potential score Jev assigned when this variant won the briefs fan-out. */
  jev?: { score: number; confidence?: number };
  frozenBrief: BriefData | null; slides: Array<{ index: number; status: string; url: string | null; path: string | null; error: string | null; overlayText: string;
    prompt?: string; fanout?: { requested: number; rendered: number; chosen: number; judge: unknown; styleViolation?: boolean }; reference?: { kind: string; videoId: string; index?: number | null; path: string } | null;
    /** QA audit for this slide. Present on success AND on failure/unverified. */
    qa?: SlideQaRecord | null }>; error: string | null; }
export interface Experiment {
  id: string; workspaceId: string; status: string; createdAt: string; updatedAt: string; instructions: InstructionsData;
  variantCount: number; slideCount: number; maxCredits: number; creditsCharged: number;
  report: (ReportData & { coverage?: unknown }) | null; inputs: Input[]; variants: Variant[]; error: string | null;
  generationBasis: GenerationBasis; assetPolicy: string; version: number; tasks: Task[];
  commands: Record<string, string>; allowPartial: boolean; createFingerprint: string;
  /** Classified from the source analyses during planning; constrains briefs and renders. */
  styleFormula?: { medium: string; density: string } | null;
  /** Plain-language adjustments planning had to make, shown on the experiment so a
   *  caller who paid for two variants, or asked for copy on a slide that will not
   *  render, is not left guessing. Never an error: the run still completes. */
  notices?: string[] | null;
  /** Briefs-stage fan-out: every candidate with its Jev viral score, and which were picked. */
  briefJudge?: { candidates: Array<{ title: string; hook: string; score: number; confidence?: number }>; picked?: string[];
    /** Resolved explicit winner id (choice ?? value), null on missing/invalid answers. */
    winner?: string | null; fallback?: string | null; reportPresent?: boolean; state?: unknown } | null;
}
export function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function assertBrief(e: Experiment, b: BriefData) {
  if (b.slides.length !== e.slideCount || !same(b.lockedConstraints, e.instructions.lockedConstraints))
    throw new ExperimentError(422, 'locked_constraints', 'Slide count and lockedConstraints must match the experiment.');
}
export function validateVariants(e: Experiment, proposals: Proposal[]) {
  // Fewer than requested is a degraded success (the fan-out cannot always
  // produce enough distinct survivors) â€” never a reason to fail the plan.
  if (proposals.length < 1 || proposals.length > e.variantCount) throw new ExperimentError(422, 'variant_count');
  const baseline = proposals[0]!;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i]!; assertBrief(e, p.brief);
    const changed = VARIABLE_FIELDS.filter(k => !same(p.brief[k], baseline.brief[k]));
    // A concept change retells the storyboard by definition — the slides diff
    // is part of that one variable, not a second unapproved one.
    // Same for a hook test with varySupportingOverlays: overlay-only retells
    // (scenes identical) belong to the hook variable, not to `slides`.
    const scenesSame = p.brief.slides.length === baseline.brief.slides.length
      && p.brief.slides.every((s, n) => s.role === baseline.brief.slides[n]!.role && s.scene === baseline.brief.slides[n]!.scene);
    const supportRetell = !!e.instructions.varySupportingOverlays && changed.includes('hook')
      && changed.every(k => k === 'hook' || k === 'slides') && scenesSame;
    const effective = changed.includes('concept') ? changed.filter(k => k !== 'slides') : supportRetell ? changed.filter(k => k !== 'slides') : changed;
    if (i === 0 && p.changedVariables.length) throw new ExperimentError(422, 'baseline_has_changes');
    if (i === 0) continue;
    if (!effective.length || effective.some(k => !e.instructions.variables.includes(k))) throw new ExperimentError(422, 'unapproved_variable');
    if (e.instructions.mode === 'controlled' && effective.length !== 1) throw new ExperimentError(422, 'not_one_variable');
    if (!same([...effective].sort(), p.changedVariables.map(c => c.name).sort())) throw new ExperimentError(422, 'incorrect_changed_variables');
    if ((effective.includes('concept') || effective.includes('slides')) && same(p.brief.slides, baseline.brief.slides))
      throw new ExperimentError(422, 'identical_storyboard', 'Concept/slides variants must retell the storyboard â€” identical slide briefs cannot test an angle.');
    for (const c of p.changedVariables) {
      const value = p.brief[c.name];
      if (typeof value === 'string' && c.value !== value) throw new ExperimentError(422, 'incorrect_variable_value');
    }
  }
}
export function validateReport(report: ReportData, inputs: Input[]) {
  const seen = new Set<string>();
  for (const p of report.patterns) {
    if (seen.has(p.id)) throw new ExperimentError(422, 'duplicate_pattern'); seen.add(p.id);
    const sources = [...new Set(p.sourceIds)].sort();
    if (sources.length !== p.sourceIds.length || p.frequency !== sources.length || !same([...new Set(p.evidence.map(x => x.videoId))].sort(), sources))
      throw new ExperimentError(422, 'invalid_source_frequency');
    for (const ev of p.evidence) {
      const input = inputs.find(x => x.videoId === ev.videoId && x.status === 'ready');
      if (!input?.evidence.some(x => x.location === ev.location && x.observation === ev.observation))
        throw new ExperimentError(422, 'unverified_evidence', 'Evidence must quote an observed source location exactly.');
    }
  }
}

