import { randomUUID } from 'node:crypto';
import {
  assertArmsDifferOnly, buildArmB, fixText, repairSlides, slideRole, pickFramesByArc, slideWork,
  type ArmBrief, type ArmField, type ContractSlide, type ResolvedContract, type SlideWork,
} from './resolved-contract.js';
import { persistedOverlayText } from './render-prompt.js';
import {
  ExperimentError, FEEDBACK_HISTORY_LIMIT, MAX_BRIEF_REVISIONS, SLIDE_FEEDBACK_LIMIT,
  type BriefData, type Experiment, type FeedbackRequestData, type Proposal, type Task, type Variant,
} from './schema.js';

// Pure parts of the resolved-contract pipeline: the contract as the renderer and QA see it,
// the two arms, scheduling rules and how finished tasks fold into the experiment. No I/O.

export const isContractPipeline = (e: Pick<Experiment, 'pipeline'>): boolean => e.pipeline === 'contract';

export const FALLBACK_HOOK = 'No caption';

/** The hook a contract brief carries for a given first-slide caption: the caption itself, or the placeholder when it is blank. */
export const hookForOverlay = (overlay: string | undefined): string => overlay || FALLBACK_HOOK;
const variantOf = (e: Experiment, id?: string) => e.variants.find(v => v.id === id);
const newTask = (kind: Task['kind'], target?: string, index?: number, fix?: string): Task =>
  ({ id: randomUUID(), kind, target, index, status: 'pending', attempts: 0, charged: 0, ...(fix ? { fix } : {}) });

export function briefToArm(b: BriefData): ArmBrief {
  return {
    character: b.character, visualStyle: b.visualStyle, caption: b.caption, cta: b.cta,
    slides: b.slides.map(s => ({
      overlayText: s.overlayText ?? '', arcLevel: s.arcLevel ?? 'none', scene: s.scene,
      composition: s.composition ?? '', visibleChange: s.visibleChange ?? '', role: s.role,
    })),
  };
}

/** The contract exactly as one arm renders and is judged: the experiment's contract with this arm's own slides. */
export function contractView(e: Pick<Experiment, 'contract'>, brief: BriefData): ResolvedContract {
  const c = e.contract;
  if (!c) throw new ExperimentError(409, 'missing_contract', 'This experiment has no resolved slide contract.');
  const slides: ContractSlide[] = brief.slides.map(s => ({
    overlayText: s.overlayText ?? '', arcLevel: c.arcAxis ? (s.arcLevel ?? 'none') : 'none', scene: s.scene,
    composition: s.composition ?? '', visibleChange: s.visibleChange ?? '',
  }));
  return {
    ...c, medium: brief.visualStyle || c.medium,
    identitySheet: c.identity === 'invented-consistent' ? (brief.character || c.identitySheet) : '',
    slides, hook: slides[0]?.overlayText ?? '',
  };
}

function armToBrief(arm: ArmBrief, base: BriefData, over: Partial<BriefData>): BriefData {
  return {
    ...base, character: arm.character, visualStyle: arm.visualStyle, caption: arm.caption, cta: arm.cta,
    slides: arm.slides.map((s, i) => ({
      role: s.role || (i === 0 ? 'hook' : 'beat'), scene: s.scene, overlayText: s.overlayText,
      ...(s.composition ? { composition: s.composition } : {}), ...(s.visibleChange ? { visibleChange: s.visibleChange } : {}),
      arcLevel: s.arcLevel,
    })),
    ...over,
  };
}

/** Arm A from the contract; arm B is A with exactly the declared variable replaced, enforced by code. */
export function proposalsFromContract(e: Pick<Experiment, 'instructions' | 'slideCount' | 'variantCount'>, c: ResolvedContract): { proposals: Proposal[]; notices: string[] } {
  const variable = c.variantB.variable as ArmField;
  const concept = (e.instructions.direction || e.instructions.goal).slice(0, 400);
  const armA: ArmBrief = {
    character: c.identitySheet, visualStyle: c.medium, caption: '', cta: '',
    slides: c.slides.map((s, i) => ({ ...s, role: i === 0 ? 'hook' : s.arcLevel !== 'none' ? s.arcLevel : 'beat' })),
  };
  const baseBrief: BriefData = armToBrief(armA, {
    concept, hook: c.hook || FALLBACK_HOOK, character: '', visualStyle: c.medium, caption: '', cta: '',
    lockedConstraints: e.instructions.lockedConstraints, slides: [],
  }, {});
  const armB = buildArmB(armA, c.variantB);
  assertArmsDifferOnly(armA, armB, variable);
  const briefB = armToBrief(armB, baseBrief, {
    hook: variable === 'hook' ? (armB.slides[0]!.overlayText || FALLBACK_HOOK) : baseBrief.hook,
    concept: variable === 'concept' ? c.variantB.value : baseBrief.concept,
  });
  const value = variable === 'slides' ? 'Alternative storyline' : variable === 'hook' ? briefB.hook : c.variantB.value;
  const notices: string[] = [];
  if (c.slides.length < e.slideCount && c.keepSourceImage) notices.push(`Your source photos are kept unchanged, so the deck has ${c.slides.length} slides instead of ${e.slideCount}: only that many source frames match the story arc.`);
  if (e.variantCount > 2) notices.push(`The slide contract compares the direction against one alternative, so this run has 2 variants instead of ${e.variantCount}.`);
  return {
    proposals: [
      { title: 'Direction as written', hypothesis: 'The slides follow the user direction as written.', changedVariables: [], brief: baseBrief },
      { title: `Alternative ${variable}`, hypothesis: `Only the ${variable} differs from the baseline.`, changedVariables: [{ name: variable, value: value || variable }], brief: briefB },
    ],
    notices,
  };
}

// ---- scheduling ----------------------------------------------------------------

export function slideWorkFor(e: Experiment, v: Variant, index: number, fix?: string): SlideWork {
  if (!v.baselineId || !v.frozenBrief) return 'render';
  // Human feedback asks for a different picture: never a copy or a caption-only edit of the baseline's.
  // Nor may a slide that edits this arm's own re-rendered anchor copy the baseline's face.
  if (slideFeedback(v, index) || (index > 0 && slideFeedback(v, 0) && isAnchorEdit(e, v, index))) return 'render';
  const base = variantOf(e, v.baselineId);
  if (!base?.frozenBrief) return 'render';
  // The baseline must be producing (or have produced) the slide this one copies. A baseline slide that died is not "never
  // produced": rendering it here would send the same request that already failed, so it stays a dependency (see baselineDependency).
  if (base.status !== 'generating' && !base.slides[index]?.path && baselineSlideState(e, base, index) !== 'dead') return 'render';
  const work = slideWork(briefToArm(base.frozenBrief), briefToArm(v.frozenBrief), index);
  return work === 'reuse' && fix ? 'render' : work;
}

/** True when the slide's role is an edit of the arm's own first slide. */
export function isAnchorEdit(e: Experiment, v: Variant, index: number): boolean {
  if (index === 0 || !v.frozenBrief || !e.contract) return false;
  const view = contractView(e, v.frozenBrief);
  return slideRole(view, index, pickFramesByArc(view)[index]!) === 'anchor-edit';
}

const open = (t: Task) => t.status === 'pending' || t.status === 'running';
const dead = (t: Task) => t.status === 'failed' || t.status === 'unknown';

type BaselineSlide = 'done' | 'open' | 'dead' | 'absent';

/** Where one baseline slide stands: a picture to copy, still being produced, or lost with no picture to fall back on. */
function baselineSlideState(e: Experiment, base: Variant, index: number): BaselineSlide {
  const mine = e.tasks.filter(t => t.kind === 'slide' && t.target === base.id && t.index === index);
  if (mine.some(open)) return 'open';
  const slide = base.slides[index];
  if (slide?.path) return 'done';
  return slide?.status === 'failed' || slide?.status === 'unknown' || mine.some(dead) ? 'dead' : 'absent';
}

/** Whether a slide that copies the baseline's can be made now. `waiting` while the baseline may still change that picture;
 *  `dead` when the baseline slide has no picture and none is coming. */
export function baselineDependency(e: Experiment, base: Variant, index: number): 'ready' | 'waiting' | 'dead' {
  const state = baselineSlideState(e, base, index);
  if (state === 'dead') return 'dead';
  if (base.status !== 'generating') return 'ready';
  if (state !== 'done') return 'waiting';
  // A QA verdict can re-render any baseline slide, so a copy waits for it - unless a dead slide means the verdict can never be asked for.
  const verdictPending = e.tasks.some(t => t.kind === 'qa' && t.target === base.id && open(t));
  const deckDoomed = base.slides.some((_, i) => baselineSlideState(e, base, i) === 'dead');
  return verdictPending && !deckDoomed ? 'waiting' : 'ready';
}

/** Called by the engine for slide and qa tasks of a contract experiment, after the briefs have settled. */
export function contractEligible(e: Experiment, t: Task): boolean {
  if (t.kind === 'qa') return !e.tasks.some(s => s.kind === 'slide' && s.target === t.target && open(s));
  const v = variantOf(e, t.target);
  if (!v) return true;
  const index = t.index ?? 0;
  const base = v.baselineId ? variantOf(e, v.baselineId) : undefined;
  if (base?.frozenBrief && slideWorkFor(e, v, index, t.fix) !== 'render' && baselineDependency(e, base, index) !== 'ready') return false;
  if (isAnchorEdit(e, v, index) && e.tasks.some(s => s.kind === 'slide' && s.target === v.id && s.index === 0 && s !== t && open(s))) return false;
  return true;
}

/** A qa task waits for its arm's slides; when one of them has died there is nothing left to judge. */
export function reapContractQa(e: Experiment): boolean {
  let changed = false;
  for (const t of e.tasks) {
    if (t.kind !== 'qa' || t.status !== 'pending') continue;
    const mine = e.tasks.filter(s => s.kind === 'slide' && s.target === t.target);
    if (mine.some(open)) continue;
    const gone = mine.find(dead);
    if (!gone) continue;
    t.status = 'failed'; t.error = 'deck_incomplete'; changed = true;
  }
  return changed;
}

/** A queued slide that only copies a baseline slide which failed has nothing to copy and must not be rendered instead:
 *  that would send the failed request again. It fails closed, unbilled, with the reason on the job and the slide. */
function failDeadDependencies(e: Experiment): boolean {
  let changed = false;
  for (const t of e.tasks) {
    if (t.kind !== 'slide' || t.status !== 'pending') continue;
    const v = variantOf(e, t.target);
    const base = v?.baselineId ? variantOf(e, v.baselineId) : undefined;
    if (!v || !base?.frozenBrief) continue;
    const index = t.index ?? 0;
    if (slideWorkFor(e, v, index, t.fix) === 'render' || baselineDependency(e, base, index) !== 'dead') continue;
    t.status = 'failed';
    t.error = `baseline_slide_unavailable: this slide is an unchanged copy of baseline slide ${index + 1}, which failed and has no picture to copy. It is not re-rendered, because that would send the failed request again.`;
    const slide = v.slides[index];
    if (slide) { slide.status = 'failed'; slide.error = t.error; }
    changed = true;
  }
  return changed;
}

/** An arm with nothing left to run and a dead job will never finish: it settles as failed (or paused for an unknown outcome),
 *  while the other arm keeps going. */
function settleDeadArms(e: Experiment): boolean {
  let changed = false;
  for (const v of e.variants) {
    if (v.status !== 'generating' || !v.frozenBrief) continue;
    const mine = e.tasks.filter(t => (t.kind === 'slide' || t.kind === 'qa') && t.target === v.id);
    if (mine.some(open)) continue;
    const gone = mine.filter(dead);
    if (!gone.length) continue;
    v.status = gone.some(t => t.status === 'unknown') ? 'paused' : 'failed';
    v.error = (gone.find(t => t.kind === 'slide' && t.error) ?? gone.find(t => t.error))?.error ?? 'deck_incomplete';
    changed = true;
  }
  return changed;
}

/** Settles contract work that can never run, in the order that lets each step see the last: dead copies, then the QA that
 *  waited on them, then the arms. True when anything changed and must be saved. */
export function settleStrandedContract(e: Experiment): boolean {
  const copies = failDeadDependencies(e);
  const qa = reapContractQa(e);
  const arms = settleDeadArms(e);
  return copies || qa || arms;
}

// ---- settlement ----------------------------------------------------------------

export function mergeCalls(e: Experiment, calls?: Record<string, number>): void {
  if (!calls) return;
  const into = (e.providerCalls ??= {});
  for (const [k, n] of Object.entries(calls)) if (n > 0) into[k] = (into[k] ?? 0) + n;
}

export interface QaTaskResult { passed: boolean; failures: Record<string, string[]>; warnings: string[]; calls?: Record<string, number> }

/** The slide task's output: the stored image plus the provider calls it made. */
export function settleContractSlide(e: Experiment, t: Task, result: unknown): void {
  const { calls, ...rest } = result as { calls?: Record<string, number>; path: string };
  mergeCalls(e, calls);
  const v = variantOf(e, t.target)!;
  Object.assign(v.slides[t.index!]!, rest, { status: 'done', error: null });
  t.path = rest.path;
  settleContractCompletion(e);
}

export function settleContractCompletion(e: Experiment): void {
  if (!['planning', 'generating'].includes(e.status)) return;
  if (e.tasks.some(t => t.kind === 'revise' && open(t))) return;
  if (!e.tasks.filter(x => x.kind === 'slide' || x.kind === 'qa').every(x => x.status === 'done')) return;
  e.status = e.variants.some(v => v.status === 'draft') ? 'review' : 'completed';
}

export const QA_REPAIR_ROUNDS = 1;

/** A slide copied from the baseline arm was already judged there; re-judging it here could only re-render it and break the A/B isolation.
 *  The same holds for the deck verdict when every picture is the baseline's (reused, or a caption-only edit of it). */
function ignoreReusedSlides(e: Experiment, v: Variant, result: QaTaskResult): QaTaskResult {
  const reused = new Set(v.slides.filter(s => s.provider === 'reuse').map(s => String(s.index)));
  const baselinePictures = !!v.baselineId && v.slides.every(s => s.provider === 'reuse' || slideWorkFor(e, v, s.index) === 'caption-edit');
  if (baselinePictures) reused.add('deck');
  const failures = Object.fromEntries(Object.entries(result.failures).filter(([k]) => !reused.has(k)));
  if (Object.keys(failures).length === Object.keys(result.failures).length) return result;
  return { ...result, failures, passed: Object.keys(failures).length === 0 };
}

/** One QA verdict per arm. A pass finishes the arm; a first hard failure buys one repair round (re-render of the
 *  failing slides carrying the QA text, then one re-QA); a failure after that is final and never downgraded. */
export function settleQa(e: Experiment, t: Task, rawResult: QaTaskResult): void {
  mergeCalls(e, rawResult.calls);
  const v = variantOf(e, t.target)!;
  const result = ignoreReusedSlides(e, v, rawResult);
  const attempts = (v.qaDeck?.attempts ?? 0) + 1;
  const n = v.slides.length;
  const judgedSlides = v.slides.map((_, i) => i);
  const record = { attempts, failures: result.failures, warnings: result.warnings, judgedSlides };
  if (result.passed) {
    v.qaDeck = { ...record, verdict: 'passed', repaired: v.qaDeck?.repaired ?? [] };
    v.status = 'done'; v.error = null;
    settleContractCompletion(e);
    return;
  }
  if (attempts <= QA_REPAIR_ROUNDS) {
    const chain = !!v.frozenBrief && !!e.contract && contractView(e, v.frozenBrief).identity === 'invented-consistent' && !e.contract.keepSourceImage;
    const redo = repairSlides(result.failures, n, { chainFromAnchor: chain });
    for (const i of redo) {
      const slide = v.slides[i]!;
      slide.status = 'pending'; slide.error = null;
      e.tasks.push(newTask('slide', v.id, i, fixText(result.failures, i)));
    }
    e.tasks.push(newTask('qa', v.id));
    v.qaDeck = { ...record, verdict: 'repairing', repaired: redo };
    v.status = 'generating';
    return;
  }
  const reasons = Object.entries(result.failures).flatMap(([k, ms]) => ms.map(m => `${k === 'deck' ? 'deck' : `slide ${Number(k) + 1}`}: ${m}`));
  const message = `qa_failed: ${reasons.join(' | ')}`.slice(0, 400);
  v.qaDeck = { ...record, verdict: 'failed', repaired: v.qaDeck?.repaired ?? [] };
  v.status = 'failed'; v.error = message;
  t.status = 'failed'; t.error = message;
  if (['planning', 'generating'].includes(e.status)) { e.status = 'failed'; e.error = message; }
}

/** Tasks one arm needs when it is sent to rendering: its slides, then one QA over the whole arm. */
export function generationTasks(v: Variant): Task[] {
  return [...v.slides.map(s => newTask('slide', v.id, s.index)), newTask('qa', v.id)];
}

// ---- human feedback (SLA-797) ----------------------------------------------------

/** The human notes in force for one slide, oldest first, as one prompt line. Empty when there are none. */
export function slideFeedback(v: Pick<Variant, 'slides'>, index: number): string {
  const notes = v.slides[index]?.feedback ?? [];
  if (!notes.length) return '';
  return notes.length === 1 ? notes[0]! : notes.map((n, i) => `(${i + 1}) ${n}`).join(' ') + ' — where these conflict, the last one wins.';
}

/** Which slides one feedback round re-renders. Deck feedback redoes the whole slideshow; slide feedback redoes those
 *  slides, and an anchor slide of an invented identity chain takes every later slide with it, as a QA repair does. */
export function feedbackRedo(e: Experiment, v: Variant, req: Pick<FeedbackRequestData, 'feedback' | 'slides'>): number[] {
  const n = v.slides.length;
  if (req.feedback) return v.slides.map((_, i) => i);
  const failures: Record<string, string[]> = Object.fromEntries((req.slides ?? []).map(s => [String(s.index), [s.feedback]]));
  const chain = !!v.frozenBrief && !!e.contract && contractView(e, v.frozenBrief).identity === 'invented-consistent' && !e.contract.keepSourceImage;
  return repairSlides(failures, n, { chainFromAnchor: chain });
}

/**
 * Apply one human feedback round to a rendered arm. Pure with respect to `e`, like `settleQa`.
 *
 * The notes are stored on the slides, not on the tasks, so a QA repair of the same slide re-renders
 * against them too. The arm then gets a fresh QA round (a new repair allowance): the verdict it had is
 * kept in the round's record. Failed jobs of this arm are dropped — they are settled and refunded, and
 * left in place they would fail the new QA (`deck_incomplete`) or keep the experiment from completing.
 */
export function applyFeedback(e: Experiment, req: FeedbackRequestData, now = new Date()): { variant: Variant; redo: number[] } {
  if (!isContractPipeline(e)) throw new ExperimentError(409, 'feedback_unsupported', 'Feedback regeneration needs an experiment on the slide-contract pipeline. Re-run the slideshow as a new experiment.');
  switch (e.status) {
    case 'planning': case 'generating': throw new ExperimentError(409, 'experiment_active');
    case 'cancelled': throw new ExperimentError(409, 'experiment_cancelled');
    case 'draft': throw new ExperimentError(409, 'variant_not_generated');
  }
  const v = variantOf(e, req.variantId);
  if (!v) throw new ExperimentError(404, 'variant_not_found');
  if (!v.frozenBrief || !v.slides.length) throw new ExperimentError(409, 'variant_not_generated', 'Generate this variant before giving feedback on its slides.');
  if (e.tasks.some(t => t.target === v.id && (t.status === 'running' || t.status === 'unknown' || t.status === 'pending')))
    throw new ExperimentError(409, 'variant_in_flight');
  for (const s of req.slides ?? []) {
    if (!v.slides[s.index]) throw new ExperimentError(400, 'invalid_slide', `Slide index ${s.index} is outside this ${v.slides.length}-slide variant (indexes are 0-based).`);
  }
  const redo = feedbackRedo(e, v, req);
  const perSlide = new Map((req.slides ?? []).map(s => [s.index, s.feedback]));
  e.tasks = e.tasks.filter(t => !(t.target === v.id && (t.kind === 'slide' || t.kind === 'qa') && t.status === 'failed'));
  for (const i of redo) {
    const slide = v.slides[i]!;
    const note = [req.feedback ? `Whole slideshow: ${req.feedback}` : '', perSlide.get(i) ? `This slide: ${perSlide.get(i)}` : ''].filter(Boolean).join(' ');
    if (note) slide.feedback = [...(slide.feedback ?? []), note].slice(-SLIDE_FEEDBACK_LIMIT);
    slide.status = 'pending'; slide.error = null;
    e.tasks.push(newTask('slide', v.id, i));
  }
  e.tasks.push(newTask('qa', v.id));
  v.feedback = [...(v.feedback ?? []), {
    at: now.toISOString(), feedback: req.feedback ?? null,
    slides: (req.slides ?? []).map(s => ({ index: s.index, feedback: s.feedback })),
    redo, previousQa: v.qaDeck?.verdict ?? null,
  }].slice(-FEEDBACK_HISTORY_LIMIT);
  v.qaDeck = null;
  v.status = 'generating'; v.error = null;
  e.status = 'generating'; e.error = null;
  return { variant: v, redo };
}

// ---- QA-driven brief revision --------------------------------------------------

const reviseAsk = (code: string, message: string) => new ExperimentError(409, code, message);

/** The arms whose final QA verdict was a hard failure, or an ExperimentError naming why a revision cannot start. */
export function reviseTargets(e: Experiment): Variant[] {
  if (!isContractPipeline(e)) throw reviseAsk('revise_unsupported', 'Brief revision needs an experiment on the slide-contract pipeline. Re-create the slideshow as a new experiment.');
  if (e.status === 'planning' || e.status === 'generating') throw new ExperimentError(409, 'experiment_active');
  if (e.status !== 'failed') throw reviseAsk('not_revisable', 'Only a failed experiment can have its brief revised.');
  // A failed experiment is never stepped, so the other arm's untouched pending tasks are stale; only a call in flight blocks.
  if (e.tasks.some(t => t.status === 'running' || t.status === 'unknown')) throw new ExperimentError(409, 'provider_outcome_unknown', 'A job is still in flight. Refresh and retry in a moment.');
  const failed = e.variants.filter(v => v.qaDeck?.verdict === 'failed');
  if (!failed.length) throw reviseAsk('no_qa_failure', 'No variant failed QA, so there is no QA feedback to revise the brief with. Retry the failed jobs instead.');
  if ((e.revisions?.length ?? 0) >= MAX_BRIEF_REVISIONS) throw reviseAsk('revise_limit', `The brief was already revised ${MAX_BRIEF_REVISIONS} times and still failed QA. Re-create the experiment with a changed direction.`);
  return failed;
}

/** Queue one brief rewrite for the whole experiment. The previous briefs and the QA text that rejected them are kept in `revisions`
 *  and sent to the model; the arms are rebuilt together so they still differ only in the declared variable. */
export function applyRevise(e: Experiment, now = new Date()): Variant[] {
  const failed = reviseTargets(e);
  e.revisions = [...(e.revisions ?? []), {
    at: now.toISOString(), error: e.error,
    arms: failed.map(v => ({ title: v.title, failures: v.qaDeck?.failures ?? {} })),
  }];
  e.tasks = e.tasks.filter(t => !(t.status !== 'done' && (t.kind === 'slide' || t.kind === 'qa')));
  e.tasks.push(newTask('revise'));
  e.status = 'generating'; e.error = null;
  return failed;
}

/** The revision's contract and arms replace the rejected ones and go straight to rendering: the approved estimate already priced it. */
export function settleRevise(e: Experiment, _t: Task, result: unknown): void {
  const { proposals, contract, notices, calls } = result as { proposals: Proposal[]; contract: Experiment['contract']; notices?: string[]; calls?: Record<string, number> };
  mergeCalls(e, calls);
  if (contract) e.contract = contract;
  if (notices?.length) e.notices = notices; else delete e.notices;
  const retired = new Set(e.variants.map(v => v.id));
  e.tasks = e.tasks.filter(t => !((t.kind === 'slide' || t.kind === 'qa') && retired.has(t.target ?? '')));
  const baselineId = randomUUID();
  e.variants = proposals.map((p, i) => {
    const v: Variant = {
      ...p, id: i === 0 ? baselineId : randomUUID(), baselineId: i === 0 ? null : baselineId, revision: 1, status: 'generating',
      generationBasis: e.generationBasis, history: [], frozenBrief: structuredClone(p.brief), error: null,
      slides: p.brief.slides.map((_s, index) => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: persistedOverlayText(p.brief, index) })),
    };
    return v;
  });
  for (const v of e.variants) e.tasks.push(...generationTasks(v));
  e.status = 'generating'; e.error = null;
}
