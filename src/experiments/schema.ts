import { z } from 'zod/v4';
import { SOURCE_FORMATS } from './source-format.js';

export class ExperimentError extends Error {
  constructor(public statusCode: number, public code: string, message = code) { super(message); }
}
export const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const Key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const text = z.string().trim().max(2000);
export const VARIABLE_FIELDS = ['hook', 'character', 'visualStyle', 'caption', 'cta', 'concept', 'slides'] as const;
const constraints = z.union([z.array(text.min(1)).max(20), text]).transform(v => typeof v === 'string' ? (v ? [v] : []) : v);
/** Explicit per-slide copy override (SLA-430 D3, SLA-431 request carrier). Keys are
 *  canonical 0-based slide indices — no leading zeros, because `'00'` and `'0'`
 *  name the same slide and a lookup by string would silently drop one of them.
 *  Property presence decides: `""` clears the overlay and an omitted index is NOT
 *  a blank, it leaves that slide's copy unresolved so the value that would
 *  otherwise apply (resolved source copy, or the brief's own copy on a
 *  hook-varying experiment) stands. Optional so instructions and briefs stored
 *  before it keep working. Capped at 8 keys: more slides than the deck can hold
 *  is meaningless, and `instructions` is interpolated into the report prompt,
 *  where an oversized value would blow the prompt budget and fail a paid task. */
export const CopyOverrides = z.record(z.string().regex(/^(?:0|[1-9]\d*)$/), z.string().max(2000))
  .refine(v => Object.keys(v).length <= 8, { message: 'At most 8 per-slide copy overrides: one per slide.' });
const instructionsShape = {
  goal: text.min(1), brand: text, audience: text, language: z.string().trim().min(1).max(80),
  direction: text, lockedConstraints: constraints,
  variables: z.array(z.union([z.enum(VARIABLE_FIELDS), z.literal('angle')]).transform(v => v === 'angle' ? 'concept' as const : v)).min(1).max(7), mode: z.enum(['controlled', 'exploration']),
  // SLA-555: which kind of source this is. Expands to default variables, mode,
  // direction and locks (source-format.ts); stored resolved so a later reader
  // sees which preset shaped the locks. Optional: older experiments have none.
  sourceFormat: z.enum(SOURCE_FORMATS).optional(),
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
  // SLA-476: explicit opt-in to keeping the source deck's own trailing CTA
  // slide. Absent/false is the historical contract — a detected closing
  // call-to-action slide is subtracted from the slide count at both the creation
  // and the planning boundary. True keeps every source slide (still clamped to
  // 3-8). Optional so experiments stored before it resolve exactly as before.
  preserveSourceCtaSlide: z.boolean().optional(),
};
export const Instructions = z.object(instructionsShape).strict().superRefine((v, ctx) => {
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
/** Create-time shape: with a source format, variables/mode/direction/lockedConstraints may be omitted
 *  and are filled from the preset before the strict `Instructions` parse. */
export const InstructionsInput = z.object({
  ...instructionsShape,
  direction: instructionsShape.direction.optional(),
  lockedConstraints: instructionsShape.lockedConstraints.optional(),
  variables: instructionsShape.variables.optional(),
  mode: instructionsShape.mode.optional(),
}).strict();
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
const createShape = <I extends z.ZodType>(instructions: I) => ({ workspaceId: Id, videoIds: z.array(Id).min(1).max(20), instructions,
  variantCount: z.number().int().min(1).max(12), slideCount: z.number().int().min(3).max(8),
  maxCredits: z.number().int().min(1).max(10000), idempotencyKey: Key,
});
const noDuplicateVideoIds = (v: { videoIds: string[] }, c: z.RefinementCtx) => { if (new Set(v.videoIds).size !== v.videoIds.length) c.addIssue({ code: 'custom', message: 'Duplicate videoIds' }); };
export const Create = z.object(createShape(Instructions)).strict().superRefine(noDuplicateVideoIds);
/** Same request with preset-fillable instructions; `Create` re-validates after expansion. */
export const CreateRequest = z.object(createShape(InstructionsInput)).strict().superRefine(noDuplicateVideoIds);
export const WorkspaceBody = z.object({ workspaceId: Id }).strict();
export const Command = WorkspaceBody.extend({ idempotencyKey: Key });
export const Plan = Command.extend({ allowPartial: z.boolean().optional() });
export const Retry = Command.extend({ variantIds: z.array(Id).min(1).max(12).optional(), taskIds: z.array(z.string().min(1)).min(1).max(150).optional() });
export const Generate = Command.extend({ variants: z.array(z.object({ id: Id, revision: z.number().int().positive() }).strict()).min(1).max(12) });
export const Estimate = WorkspaceBody.extend({ stage: z.enum(['plan', 'generate']), variantIds: z.array(Id).min(1).max(12).optional(), taskIds: z.array(z.string().min(1)).min(1).max(150).optional() });
export const EditBrief = WorkspaceBody.extend({ revision: z.number().int().positive(), brief: Brief });

/* ------------------------------------------------------------------------- *
 * SLA-451: `exact_edit` — an explicitly selected, versioned, one-deck edit.
 *
 * This is a SEPARATE operation, not a flag on the legacy `edit` mode: a legacy
 * body carries no `operation` field, so it can never opt in implicitly, and the
 * legacy two-variant contract above is untouched. Nothing here is reachable from
 * a legacy create/edit request.
 *
 * Every field is explicit. Absence is never read as a default: there is no
 * omitted ending choice, no implied unlock, and no implied source revision.
 * ---------------------------------------------------------------------- */
export const EXACT_EDIT_OPERATION = 'exact_edit';
export const EXACT_EDIT_VERSION = 1;
/** One requested deck, one variant, one brief. Legacy edit keeps its two. */
export const EXACT_EDIT_VARIANT_COUNT = 1;

/** Exact strings: never trimmed, never defaulted to empty. An intentional blank
 *  is a value and an omission is not — the two must stay distinguishable all the
 *  way to the renderer, so these deliberately bypass the legacy `text` helpers. */
const exactText = z.string().max(2000);
const slideKey = z.string().regex(/^(?:0|[1-9]\d*)$/);

/** Discriminated source copy for one mapped slide. `unresolved` is an evidence
 *  gap and NOT a verified blank: it fails preparation rather than resolving to
 *  empty, a caption, a default payoff or another experiment's text. */
export const ExactEditSourceCopy = z.discriminatedUnion('state', [
  z.object({ state: z.literal('resolved'), text: exactText }).strict(),
  z.object({ state: z.literal('unresolved'), reason: z.string().min(1).max(200).optional() }).strict(),
]);

/** Ordered output -> source map. Order and exclusions are explicit: no rotation,
 *  no clamping, no inferred dropped slide and no deck padding. */
export const ExactEditInclusion = z.object({
  outputIndex: z.number().int().min(0).max(63),
  sourceIndex: z.number().int().min(0).max(63),
  included: z.boolean(),
  reason: z.string().min(1).max(200),
}).strict();

/** Original asset evidence for one source slide. `original: false` (a generated
 *  baseline or a recreated frame) can never satisfy preservation. */
export const ExactEditOriginal = z.object({
  sourceIndex: z.number().int().min(0).max(63),
  assetRef: z.string().min(1).max(400),
  original: z.boolean(),
  /** Null when the true encoded hash is unknown; a hash is never invented. */
  encodedSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  dimensions: z.object({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) }).strict().nullable().default(null),
}).strict();

/** Composition/subject locks. `unlocked` names ONLY properties the request
 *  explicitly released; everything else stays locked. */
export const EXACT_EDIT_LOCKS = [
  'order', 'roles', 'subjects', 'narrativeBeats', 'narrativeContrasts',
  'aspectRatio', 'crop', 'panels', 'camera', 'medium', 'background',
  'wardrobe', 'jewelry', 'expression', 'gaze',
] as const;
export const ExactEditLocks = z.object({
  locked: z.array(z.enum(EXACT_EDIT_LOCKS)).min(1).max(EXACT_EDIT_LOCKS.length),
  unlocked: z.array(z.enum(EXACT_EDIT_LOCKS)).max(EXACT_EDIT_LOCKS.length).default([]),
}).strict();

/** Source prop/product labels kept as-is, and explicit removal marks. A label in
 *  both lists contradicts itself and stops preparation. */
export const ExactEditLabels = z.object({
  allowed: z.array(z.string().min(1).max(80)).max(20).default([]),
  removals: z.array(z.string().min(1).max(80)).max(20).default([]),
}).strict();

/** One subject's explicit visible change or approved reference. An undefined
 *  attractiveness score, or a national/ethnic label with no visible target, is
 *  unresolved casting — never an inferred appearance. */
export const ExactEditCharacter = z.object({
  outputIndex: z.number().int().min(0).max(63),
  subjectId: z.string().min(1).max(80),
  visibleTarget: z.string().min(1).max(200).nullable().default(null),
  approvedReferenceRef: z.string().min(1).max(400).nullable().default(null),
  /** Non-negotiable per-slide properties that must survive the change. */
  retained: z.array(z.enum(['role', 'layout', 'gaze', 'wardrobe', 'jewelry', 'expression', 'medium'])).min(1).max(7),
  /** The source contrast this slide carries, e.g. a skin-quality step. A change
   *  must not homogenize the sequence. */
  narrativeContrast: z.string().min(1).max(200).nullable().default(null),
}).strict();

/** The mandatory ending choice, recorded before a deck is prepared. There is no
 *  automatic CTA inclusion/removal default for this operation. */
export const ExactEditEnding = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('retain'), sourceIndices: z.array(z.number().int().min(0).max(63)).min(1).max(8),
    /** Preserving supplied source app-card content verbatim, not inventing UI. */
    appCardException: z.boolean().default(false) }).strict(),
  z.object({ choice: z.literal('replace'), sourceIndices: z.array(z.number().int().min(0).max(63)).min(1).max(8),
    replacement: z.object({ outputIndex: z.number().int().min(0).max(63), text: exactText }).strict() }).strict(),
  z.object({ choice: z.literal('exclude'), sourceIndices: z.array(z.number().int().min(0).max(63)).min(1).max(8),
    instruction: z.string().min(1).max(200) }).strict(),
]);

/** Approved bounded overlay mask for the changed opener. Deterministic
 *  compositing only: no inpainting, no regeneration, no full-frame fallback. */
export const ExactEditOpenerEdit = z.object({
  outputIndex: z.literal(0),
  geometry: z.object({
    x: z.number().int().min(0).max(16384), y: z.number().int().min(0).max(16384),
    width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  }).strict(),
  mask: z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
    /** Clean source base/layer the overlay composites onto. Without a genuinely
     *  clean one, bounded compositing is not attempted. */
    cleanBaseRef: z.string().min(1).max(400),
    clean: z.boolean(),
  }).strict(),
}).strict();

/** The immutable exact_edit request. Every field is explicit; absence is never
 *  read as a default (no omitted ending, no implied unlock, no implied source). */
export const ExactEditRequestShape = z.object({
  operation: z.literal(EXACT_EDIT_OPERATION),
  contractVersion: z.literal(EXACT_EDIT_VERSION),
  workspaceId: Id,
  /** One deck: exactly one source, and it must be the declared source video. */
  videoIds: z.array(Id).min(1).max(1),
  source: z.object({
    videoId: Id,
    /** A truthful unknown is allowed (null); inventing a revision is not. */
    revision: z.string().min(1).max(128).nullable().default(null),
    revisionState: z.enum(['known', 'unknown']).default('unknown'),
    provenance: z.string().min(1).max(200),
  }).strict(),
  inclusions: z.array(ExactEditInclusion).min(1).max(64),
  originals: z.array(ExactEditOriginal).min(1).max(64),
  /** Discriminated source copy, keyed by OUTPUT slide index. */
  sourceCopy: z.record(slideKey, ExactEditSourceCopy),
  /** Exact per-slide overrides: an explicit value wins including `""` to clear;
   *  an omitted key retains the resolved source copy. Never trimmed. */
  overlayOverrides: z.record(slideKey, exactText).optional(),
  /** Slide-zero `brief.hook` mirror. It must agree with the resolved slide-zero
   *  overlay, blank included, or the request contradicts itself. */
  hookMirror: exactText.optional(),
  locks: ExactEditLocks,
  labels: ExactEditLabels.optional(),
  characters: z.array(ExactEditCharacter).max(16).default([]),
  ending: ExactEditEnding.optional(),
  openerEdit: ExactEditOpenerEdit.optional(),
  /** Offline preparation only: this operation authorizes no spend. */
  maxCredits: z.number().int().min(0).max(0).default(0),
  idempotencyKey: Key,
}).strict();

export const ExactEditRequest = ExactEditRequestShape.superRefine((v, c) => {
  if (v.videoIds.length !== 1 || v.videoIds[0] !== v.source.videoId)
    c.addIssue({ code: 'custom', message: 'exact_edit is one deck: videoIds must be the single declared source videoId.' });
  if (new Set(v.inclusions.map(i => i.outputIndex)).size !== v.inclusions.length)
    c.addIssue({ code: 'custom', message: 'Duplicate outputIndex in inclusions.' });
  const included = v.inclusions.filter(i => i.included).map(i => i.outputIndex);
  if (new Set(included).size !== included.length)
    c.addIssue({ code: 'custom', message: 'Duplicate included outputIndex in inclusions.' });
  // One source slide may not feed two output slides: that is reference rotation.
  const src = v.inclusions.filter(i => i.included).map(i => i.sourceIndex);
  if (new Set(src).size !== src.length)
    c.addIssue({ code: 'custom', message: 'One source slide cannot feed two output slides.' });
  // A gap is a dropped slide nobody chose; refuse rather than pad the deck.
  const ordered = [...included].sort((a, b) => a - b);
  if (ordered.some((o, i) => o !== i))
    c.addIssue({ code: 'custom', message: 'Included output indices must be contiguous from 0; a gap is a dropped slide, not padding.' });
  const both = v.locks.locked.filter(l => (v.locks.unlocked as readonly string[]).includes(l));
  if (both.length)
    c.addIssue({ code: 'custom', message: `A property cannot be locked and unlocked at once: ${both.join(', ')}.` });
  if (v.source.revisionState === 'unknown' && v.source.revision !== null)
    c.addIssue({ code: 'custom', message: 'Source revision marked unknown must be null; a revision value would be invented.' });
  if (v.source.revisionState === 'known' && v.source.revision === null)
    c.addIssue({ code: 'custom', message: 'Source revision marked known requires the revision value.' });
  if (v.labels) {
    const clash = v.labels.allowed.filter(l => v.labels!.removals.includes(l));
    if (clash.length) c.addIssue({ code: 'custom', message: `Label rules conflict for: ${clash.join(', ')}.` });
  }
  // "Original frames must be available for every included slide": fail closed.
  for (const inc of v.inclusions.filter(i => i.included)) {
    const frames = v.originals.filter(o => o.sourceIndex === inc.sourceIndex);
    if (!frames.length) c.addIssue({ code: 'custom', message: `No original asset for included source slide ${inc.sourceIndex}.` });
    else if (!frames.some(o => o.original)) c.addIssue({ code: 'custom', message: `Source slide ${inc.sourceIndex} has no ORIGINAL frame; a generated or recreated frame cannot stand in.` });
  }
  const seen = new Set<number>();
  for (const ch of v.characters) {
    if (seen.has(ch.outputIndex)) c.addIssue({ code: 'custom', message: `Two character targets name output slide ${ch.outputIndex}.` });
    seen.add(ch.outputIndex);
    if (!v.inclusions.some(i => i.outputIndex === ch.outputIndex && i.included))
      c.addIssue({ code: 'custom', message: `Character target names an excluded or unmapped output slide ${ch.outputIndex}.` });
  }
});

export type ExactEditRequestData = z.infer<typeof ExactEditRequest>;

/** One authoritative composite check for one output slide. Only `pass` may
 *  complete: `fail`, `error` and `unavailable` are all terminal negatives. */
export const ExactEditCheck = z.object({
  outputIndex: z.number().int().min(0).max(63),
  check: z.string().min(1).max(300),
  status: z.enum(['pass', 'fail', 'error', 'unavailable']),
  detail: z.string().max(400).optional(),
}).strict();
export const ExactEditChecks = z.array(ExactEditCheck).min(1).max(512);

/** One compiled output slide: its authoritative overlay, provenance and locks. */
export interface ExactEditSlideContract {
  outputIndex: number;
  sourceIndex: number;
  included: boolean;
  reason: string;
  effectiveOverlayText: string;
  /** `source` when the resolved source copy stands, `override` when an exact-edit
   *  override won it (including an explicit blank). `brief` never: this operation
   *  has no planner-authored fallback copy. */
  overlayOrigin: 'source' | 'override';
  /** `clear` for an explicit blank, otherwise preserve/replace by origin. */
  overlayMode: 'preserve' | 'replace' | 'clear';
  original: { assetRef: string; encodedSha256: string | null; dimensions: { width: number; height: number } | null; original: true } | null;
  /** True when the frame must be reused directly, with no image generation. */
  reuseOriginal: boolean;
  character: { subjectId: string; visibleTarget: string | null; approvedReferenceRef: string | null; retained: string[]; narrativeContrast: string | null } | null;
}

/** The immutable, deterministically hashed deck contract. One `contractHash` is
 *  shared by the effective brief, the compositor and QA. */
export interface ExactEditContract {
  operation: typeof EXACT_EDIT_OPERATION;
  contractVersion: typeof EXACT_EDIT_VERSION;
  contractId: string;
  contractHash: string;
  /** sha256 of the canonical serialization; recomputed on every use. */
  canonicalSha256: string;
  variantCount: 1;
  source: { videoId: string; revision: string | null; revisionState: 'known' | 'unknown'; provenance: string };
  slides: ExactEditSlideContract[];
  /** Slide-zero mirror of `slides[0].effectiveOverlayText`, blank included. */
  briefHook: string;
  locks: { locked: string[]; unlocked: string[] };
  labels: { allowed: string[]; removals: string[] };
  ending: z.infer<typeof ExactEditEnding>;
  /** Present only when the request approved a bounded opener edit. */
  openerEdit: z.infer<typeof ExactEditOpenerEdit> | null;
  /** Exact strings this operation consumed, never trimmed, never defaulted. */
  overlayOverrides: Record<string, string>;
}

/** Every job self-heals through 3 automatic retries, 1 minute apart (4 attempts total). */
export const MAX_TASK_ATTEMPTS = 4;
export const MAX_MANUAL_ATTEMPTS = 6;
/** Prior-attempt QA records kept per slide when a retry requeues it (SLA-511).
 *  Enough to diagnose a slide that keeps failing; bounded so a repeatedly
 *  retried slide cannot grow the stored experiment without limit. */
export const QA_HISTORY_LIMIT = 3;
/** Up to this many slide renders may run concurrently within one experiment. */
export const PARALLEL_SLIDES = 48;
/** Default candidates rendered per slide (SLA-546: 3 → 2). Tune with EXPERIMENT_SLIDE_FANOUT. */
export const SLIDE_FANOUT = 2;
const MAX_SLIDE_FANOUT = 4;
/** Candidates rendered per slide; Jev (TypeSafe) picks the most viral one.
 *  Read lazily so a Worker env change takes effect without a module reload. */
export function slideFanout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EXPERIMENT_SLIDE_FANOUT?.trim());
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_SLIDE_FANOUT) : SLIDE_FANOUT;
}
/** Floor for the briefs-stage candidate pool (SLA-546: was a flat 8). */
export const BRIEF_CANDIDATES = 3;
const MAX_BRIEF_CANDIDATES = 12;
/** Parameter deltas generated at the briefs stage; Jev ranks them, top variantCount-1 win.
 *  Never fewer than variantCount-1, or variant_count validation could not be met. */
export function briefCandidateCount(variantCount: number, env: NodeJS.ProcessEnv = process.env): number {
  const needed = Math.max(variantCount - 1, 1);
  const raw = Number(env.EXPERIMENT_BRIEF_CANDIDATES?.trim());
  const pool = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_BRIEF_CANDIDATES) : BRIEF_CANDIDATES;
  return Math.max(needed, pool);
}
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
/** Sanitized record of HOW the checker was called and how it ended (SLA-511).
 *  Model, deadline, elapsed time, bounded output budget, an error category and
 *  the upstream request id. Never the image, the prompt, the payload or a key:
 *  a timeout has to be distinguishable from a rejection or a throttle, and
 *  that must not require logging what was sent. Optional, so records written
 *  before this field keep validating. */
export interface QaDiagnostics {
  model: string;
  timeoutMs: number;
  reasoningEffort: 'low';
  maxTokens: number;
  checksRequested: number;
  elapsedMs: number;
  outcome: 'ok' | 'error';
  errorCategory?: 'timeout' | 'rate_limit' | 'quota' | 'auth' | 'invalid_request' | 'server' | 'invalid_response' | 'baseline_missing' | 'unknown';
  requestId?: string;
}
export interface SlideVerification {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  reasons: string[];
  checks: QaCheck[];
  contractHash: string;
  corrected: boolean;
  attempts: number;
  /** Request-level diagnostics for the checker's last call (SLA-511). */
  diagnostics?: QaDiagnostics;
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
  diagnostics?: QaDiagnostics;
  /** SLA-522: the mapped source frame this slide's comparison was made against.
   *  `attached:false` means the frame could not be read and the slide stayed
   *  unverified — the record says so instead of passing an unmade comparison. */
  qaBaseline?: { referenceKind: string; path: string | null; attached: boolean };
  /** The contract's own source mapping, kept beside the hash so a failed slide
   *  says which frame it claims to preserve. */
  sourceMap?: { videoId: string | null; analysisId: string | null; sourceIndex: number | null; referenceKind: string; path: string | null };
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
    /** QA audit for THIS attempt. Present on success AND on failure/unverified,
     *  cleared when a retry requeues the slide (see qaHistory). */
    qa?: SlideQaRecord | null;
    /** QA audits of earlier attempts, oldest first (SLA-511). Explicit history,
     *  so requeuing a slide keeps its prior evidence without leaving the live
     *  fields carrying a stale failure for work that has not run yet. */
    qaHistory?: SlideQaRecord[] | null }>; error: string | null; }
export interface Experiment {
  id: string; workspaceId: string; status: string; createdAt: string; updatedAt: string; instructions: InstructionsData;
  /** Absent on every legacy row. Set only when the caller explicitly selected the
   *  versioned exact_edit operation; this is what separates the two contracts at
   *  dispatch and keeps a legacy request off that path. */
  operation?: { kind: typeof EXACT_EDIT_OPERATION; contractVersion: typeof EXACT_EDIT_VERSION } | null;
  /** The single immutable exact_edit deck contract. Absent on legacy rows. */
  exactEdit?: ExactEditContract | null;
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
    winner?: string | null; fallback?: string | null; reportPresent?: boolean; state?: unknown;
    /** SLA-510: false when the judge's evidence block had a gap or a budget cut,
     *  so a reader never treats the recorded scores as a complete comparison. */
    evidenceComplete?: boolean
    /** SLA-510: the block was incomplete because a candidate scene or overlay
     *  was cut, not because of a source gap. Named so the cause is inspectable. */
    candidateTruncated?: boolean } | null;
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

