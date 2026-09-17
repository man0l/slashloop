import { z } from 'zod/v4';

export class ExperimentError extends Error {
  constructor(public statusCode: number, public code: string, message = code) { super(message); }
}
export const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const Key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const text = z.string().trim().max(2000);
export const VARIABLE_FIELDS = ['hook', 'character', 'visualStyle', 'caption', 'cta', 'concept', 'slides'] as const;
const constraints = z.union([z.array(text.min(1)).max(20), text]).transform(v => typeof v === 'string' ? (v ? [v] : []) : v);
export const Instructions = z.object({
  goal: text.min(1), brand: text, audience: text, language: z.string().trim().min(1).max(80),
  direction: text, lockedConstraints: constraints,
  variables: z.array(z.union([z.enum(VARIABLE_FIELDS), z.literal('angle')]).transform(v => v === 'angle' ? 'concept' as const : v)).min(1).max(7), mode: z.enum(['controlled', 'exploration']),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.variables).size !== v.variables.length) ctx.addIssue({ code: 'custom', message: 'Duplicate variables' });
  if (v.mode === 'controlled' && v.variables.some(x => x === 'concept' || x === 'slides')) {
    ctx.addIssue({ code: 'custom', message: 'Controlled variables: hook, character, visualStyle, caption, cta. Concept/slides require exploration.' });
  }
});
export const Brief = z.object({
  concept: text.min(1), hook: text.min(1), character: text, visualStyle: text.min(1), caption: text,
  cta: text, lockedConstraints: z.array(text.min(1)).max(20),
  slides: z.array(z.object({ role: z.string().min(1).max(80), scene: text.min(1), overlayText: text }).strict()).min(3).max(8),
}).strict();
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
/** Every job self-heals through 3 automatic retries with exponential backoff (4 attempts total). */
export const MAX_TASK_ATTEMPTS = 4;
export const MAX_MANUAL_ATTEMPTS = 6;
/** Up to this many slide renders may run concurrently within one experiment. */
export const PARALLEL_SLIDES = 3;
/** Candidates rendered per slide; Jev (TypeSafe) picks the most viral one. */
export const SLIDE_FANOUT = 3;
const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000];
export function retryBackoffMs(attempts: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1]!;
}
export const Report = z.object({ summary: text.min(1), patterns: z.array(z.object({
  id: Id, name: z.string().min(1).max(100), description: text.min(1), sourceIds: z.array(Id).min(1).max(20),
  confidence: z.number().min(0).max(1), frequency: z.number().int().min(1).max(20),
  evidence: z.array(z.object({ videoId: Id, location: z.string().min(1).max(100), observation: text.min(1) }).strict()).min(1).max(20),
}).strict()).min(1).max(12) }).strict();
export const VariantProposal = z.object({ title: z.string().min(1).max(160), hypothesis: text.min(1),
  changedVariables: z.array(z.object({ name: z.enum(VARIABLE_FIELDS), value: text.min(1) }).strict()).max(7), brief: Brief }).strict();
export type InstructionsData = z.infer<typeof Instructions>;
export type BriefData = z.infer<typeof Brief>;
export type ReportData = z.infer<typeof Report>;
export type Proposal = z.infer<typeof VariantProposal>;
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'unknown';
export interface Task { id: string; kind: 'analysis' | 'report' | 'briefs' | 'slide'; target?: string; index?: number;
  status: StepStatus; attempts: number; charged: number; chargeRef?: string; startedAt?: number; error?: string; path?: string; nextAttemptAt?: number; }
export interface Input { videoId: string; status: string; analysisId: string | null; jobId: string | null; error: string | null;
  coverage: { basis: string; observed: number; total: number | null; complete: boolean } | null; evidence: Array<{ location: string; observation: string }>; }
export type GenerationBasis = 'text-directed' | 'source-referenced';
export interface Variant extends Proposal { id: string; revision: number; status: string; baselineId: string | null;
  generationBasis: GenerationBasis; history: Array<{ revision: number; brief: BriefData }>;
  frozenBrief: BriefData | null; slides: Array<{ index: number; status: string; url: string | null; path: string | null; error: string | null; overlayText: string }>; error: string | null; }
export interface Experiment {
  id: string; workspaceId: string; status: string; createdAt: string; updatedAt: string; instructions: InstructionsData;
  variantCount: number; slideCount: number; maxCredits: number; creditsCharged: number;
  report: (ReportData & { coverage?: unknown }) | null; inputs: Input[]; variants: Variant[]; error: string | null;
  generationBasis: GenerationBasis; assetPolicy: string; version: number; tasks: Task[];
  commands: Record<string, string>; allowPartial: boolean; createFingerprint: string;
}
export function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export function assertBrief(e: Experiment, b: BriefData) {
  if (b.slides.length !== e.slideCount || !same(b.lockedConstraints, e.instructions.lockedConstraints))
    throw new ExperimentError(422, 'locked_constraints', 'Slide count and lockedConstraints must match the experiment.');
}
export function validateVariants(e: Experiment, proposals: Proposal[]) {
  if (proposals.length !== e.variantCount) throw new ExperimentError(422, 'variant_count');
  const baseline = proposals[0]!;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i]!; assertBrief(e, p.brief);
    const changed = VARIABLE_FIELDS.filter(k => !same(p.brief[k], baseline.brief[k]));
    if (i === 0 && p.changedVariables.length) throw new ExperimentError(422, 'baseline_has_changes');
    if (i === 0) continue;
    if (!changed.length || changed.some(k => !e.instructions.variables.includes(k))) throw new ExperimentError(422, 'unapproved_variable');
    if (e.instructions.mode === 'controlled' && changed.length !== 1) throw new ExperimentError(422, 'not_one_variable');
    if (!same([...changed].sort(), p.changedVariables.map(c => c.name).sort())) throw new ExperimentError(422, 'incorrect_changed_variables');
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
