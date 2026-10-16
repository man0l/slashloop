import { randomUUID } from 'node:crypto';
import {
  armsOf, assertArmDiffers, buildAlternate, fixText, repairSlides, slideRole, pickFramesByArc, slideWork,
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
/** SLA-867: a morph (ladder) experiment: one invented subject graded per slide, labels drawn in code. */
export const isMorphExperiment = (e: Pick<Experiment, 'instructions'>): boolean => e.instructions.variables.includes('morph');

export const FALLBACK_HOOK = 'No caption';

/** The hook a contract brief carries for a given first-slide caption: the caption itself, or the placeholder when it is blank. */
export const hookForOverlay = (overlay: string | undefined): string => overlay || FALLBACK_HOOK;
const variantOf = (e: Experiment, id?: string) => e.variants.find(v => v.id === id);
const newTask = (kind: Task['kind'], target?: string, index?: number, fix?: string): Task =>
  ({ id: randomUUID(), kind, target, index, status: 'pending', attempts: 0, charged: 0, ...(fix ? { fix } : {}) });

export function briefToArm(b: BriefData): ArmBrief {
  return {
    character: b.character, visualStyle: b.visualStyle, caption: b.caption, cta: b.cta, ...(b.morph ? { morph: b.morph } : {}),
    slides: b.slides.map(s => ({
      overlayText: s.overlayText ?? '', arcLevel: s.arcLevel ?? 'none', scene: s.scene,
      composition: s.composition ?? '', visibleChange: s.visibleChange ?? '', role: s.role, ...(s.morph?.length ? { morph: s.morph } : {}),
    })),
  };
}

/** The contract exactly as one arm renders and is judged: the experiment's contract with this arm's own slides.
 *  `arm`: the variant the view is for. SLA-881: `keepSourceImage` is arm A's; an alternate that recasts the person, re-stages
 *  the scene or restyles cannot keep the source photographs, so its own view drops them (a recast is a new consistent person). */
export function contractView(e: Pick<Experiment, 'contract'>, brief: BriefData, arm?: Pick<Variant, 'changedVariables'>): ResolvedContract {
  const c = e.contract;
  if (!c) throw new ExperimentError(409, 'missing_contract', 'This experiment has no resolved slide contract.');
  const slides: ContractSlide[] = brief.slides.map(s => ({
    overlayText: s.overlayText ?? '', arcLevel: c.arcAxis ? (s.arcLevel ?? 'none') : 'none', scene: s.scene,
    composition: s.composition ?? '', visibleChange: s.visibleChange ?? '', ...(c.morph && s.morph?.length ? { morph: s.morph } : {}),
  }));
  const changed = new Set((arm?.changedVariables ?? []).map(x => x.name));
  const recast = changed.has('character') && !!brief.character?.trim();
  const identity = recast ? 'invented-consistent' : c.identity;
  return {
    ...c, medium: brief.visualStyle || c.medium, identity,
    identitySheet: identity === 'invented-consistent' ? (brief.character || c.identitySheet) : '',
    keepSourceImage: c.keepSourceImage && !recast && !changed.has('scene') && !changed.has('visualStyle'),
    slides, hook: slides[0]?.overlayText ?? '',
  };
}

function armToBrief(arm: ArmBrief, base: BriefData, over: Partial<BriefData>): BriefData {
  return {
    ...base, character: arm.character, visualStyle: arm.visualStyle, caption: arm.caption, cta: arm.cta, ...(arm.morph ? { morph: arm.morph } : {}),
    slides: arm.slides.map((s, i) => ({
      role: s.role || (i === 0 ? 'hook' : 'beat'), scene: s.scene, overlayText: s.overlayText,
      ...(s.composition ? { composition: s.composition } : {}), ...(s.visibleChange ? { visibleChange: s.visibleChange } : {}),
      arcLevel: s.arcLevel, ...(s.morph?.length ? { morph: s.morph } : {}),
    })),
    ...over,
  };
}

const axisValue = (variable: ArmField, brief: BriefData, value: string): string =>
  variable === 'hook' ? brief.hook : variable === 'slides' ? 'Alternative storyline' : variable === 'morph' ? (brief.morph ?? value) : value || variable;

/** Arm A from the contract, then one proposal per alternate. Each alternate is A with exactly its declared variables replaced, enforced by code. */
export function proposalsFromContract(e: Pick<Experiment, 'instructions' | 'slideCount' | 'variantCount'>, c: ResolvedContract): { proposals: Proposal[]; notices: string[] } {
  const concept = (e.instructions.direction || e.instructions.goal).slice(0, 400);
  const armA: ArmBrief = {
    character: c.identitySheet, visualStyle: c.medium, caption: '', cta: '', ...(c.morph ? { morph: c.morph.axis } : {}),
    slides: c.slides.map((s, i) => ({ ...s, role: i === 0 ? 'hook' : s.arcLevel !== 'none' ? s.arcLevel : c.morph ? `step ${i + 1}` : 'beat' })),
  };
  const baseBrief: BriefData = armToBrief(armA, {
    concept, hook: c.hook || FALLBACK_HOOK, character: '', visualStyle: c.medium, caption: '', cta: '',
    lockedConstraints: e.instructions.lockedConstraints, slides: [],
  }, {});
  const alternates = armsOf(c);
  const proposals: Proposal[] = [{ title: 'Direction as written', hypothesis: 'The slides follow the user direction as written.', changedVariables: [], brief: baseBrief }];
  alternates.forEach((alt, k) => {
    const declared = alt.axes.map(a => a.variable);
    const armB = buildAlternate(armA, alt);
    assertArmDiffers(armA, armB, declared);
    const retold = alt.axes.find(a => a.variable === 'concept' || a.variable === 'slides');
    const brief = armToBrief(armB, baseBrief, {
      hook: declared.includes('hook') ? (armB.slides[0]!.overlayText || FALLBACK_HOOK) : baseBrief.hook,
      concept: declared.includes('concept') ? (retold?.value || 'Alternative storyline') : baseBrief.concept,
    });
    const names = declared.join(' + ');
    proposals.push({
      title: alternates.length === 1 ? `Alternative ${names}` : `Alternate ${k + 1}: ${names}`,
      hypothesis: `Only the ${declared.join(', ')} ${declared.length === 1 ? 'differs' : 'differ'} from the baseline.`,
      changedVariables: alt.axes.map(a => ({ name: a.variable, value: axisValue(a.variable, brief, a.variable === 'concept' ? brief.concept : a.value) })),
      brief,
    });
  });
  const notices: string[] = [];
  if (c.slides.length < e.slideCount && c.keepSourceImage) notices.push(`Your source photos are kept unchanged, so the deck has ${c.slides.length} slides instead of ${e.slideCount}: only that many source frames match the story arc.`);
  const wanted = Math.max(e.variantCount, 2);
  if (e.variantCount < 2) notices.push(`The slide contract always compares the direction against at least one alternative, so this run has 2 variants instead of ${e.variantCount}.`);
  else if (proposals.length < wanted) notices.push(`Only ${proposals.length} variants could be built instead of ${e.variantCount}: the values the planner returned ran out of distinct, usable combinations.`);
  return { proposals, notices };
}

// ---- scheduling ----------------------------------------------------------------

/** True for an alternate that changes the person or the scene while the storyline stays locked: its slides edit the baseline's
 *  picture of them instead of being rendered from scratch. A retold storyline, a restyle or a morph is a different render. */
export function isEditArm(_e: Experiment, v: Variant): boolean {
  if (!v.baselineId) return false;
  const names = (v.changedVariables ?? []).map(c => c.name);
  return names.some(n => n === 'scene' || n === 'character') && !names.some(n => n === 'slides' || n === 'visualStyle' || n === 'morph');
}

/** An edit arm that keeps the baseline's person: QA judges it against the baseline deck. A new person is judged on its own sheet. */
export function keepsBaselinePerson(e: Experiment, v: Variant): boolean {
  return isEditArm(e, v) && !(v.changedVariables ?? []).some(c => c.name === 'character');
}

/** True when the model never sees overlay words: they are drawn in code onto the picture (script mode, and every morph deck). */
export const isScriptOverlay = (e: Pick<Experiment, 'instructions'>): boolean => e.instructions.overlayMode === 'script' || isMorphExperiment(e);

/** Image-model calls one slide costs. The preparer charges this and the estimator quotes this, so an estimate cannot drift from a charge:
 *  a reused slide is a copy, and a caption edit in script mode only redraws the words on the baseline's text-free picture. */
export function slideUnits(work: SlideWork, scriptOverlay: boolean): 0 | 1 {
  return work === 'reuse' || (work === 'caption-edit' && scriptOverlay) ? 0 : 1;
}

export function slideWorkFor(e: Experiment, v: Variant, index: number, fix?: string): SlideWork {
  if (!v.baselineId || !v.frozenBrief) return 'render';
  // Human feedback asks for a different picture: never a copy or a caption-only edit of the baseline's.
  // Nor may a slide that edits this arm's own re-rendered anchor copy the baseline's face.
  // A scene arm is an edit of the baseline's picture already, so the feedback is carried into that edit instead.
  if (!isEditArm(e, v) && (slideFeedback(v, index) || (index > 0 && slideFeedback(v, 0) && isAnchorEdit(e, v, index)))) return 'render';
  const base = variantOf(e, v.baselineId);
  if (!base?.frozenBrief) return 'render';
  const planned = slideWork(briefToArm(base.frozenBrief), briefToArm(v.frozenBrief), index, isEditArm(e, v));
  // A baseline edit never falls back to a fresh render: with no picture to edit it waits, or fails closed (failDeadDependencies).
  if (planned === 'baseline-edit') return planned;
  // The baseline must be producing (or have produced) the slide this one copies. A baseline slide that died is not "never
  // produced": rendering it here would send the same request that already failed, so it stays a dependency (see baselineDependency).
  if (base.status !== 'generating' && !base.slides[index]?.path && baselineSlideState(e, base, index) !== 'dead') return 'render';
  return planned === 'reuse' && fix ? 'render' : planned;
}

/** True when the slide's role is an edit of the arm's own first slide. */
export function isAnchorEdit(e: Experiment, v: Variant, index: number): boolean {
  if (index === 0 || !v.frozenBrief || !e.contract || isEditArm(e, v)) return false;
  const view = contractView(e, v.frozenBrief, v);
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
    const work = slideWorkFor(e, v, index, t.fix);
    if (work === 'render' || baselineDependency(e, base, index) !== 'dead') continue;
    t.status = 'failed';
    t.error = work === 'baseline-edit'
      ? `baseline_slide_unavailable: this slide is an edit of baseline slide ${index + 1}, which failed and has no picture to edit. It is not rendered from scratch, because that would not be the same person and medium.`
      : `baseline_slide_unavailable: this slide is an unchanged copy of baseline slide ${index + 1}, which failed and has no picture to copy. It is not re-rendered, because that would send the failed request again.`;
    const slide = v.slides[index];
    if (slide) { slide.status = 'failed'; slide.error = t.error; }
    changed = true;
  }
  return changed;
}

/** A queued slide that edits its arm's first slide has nothing to edit once that slide died with no picture. While the run was
 *  stopped by the first failure this never came up; now the other arm keeps going (SLA-820), so it fails closed, unbilled. */
function failDeadAnchors(e: Experiment): boolean {
  let changed = false;
  for (const t of e.tasks) {
    if (t.kind !== 'slide' || t.status !== 'pending' || !t.index) continue;
    const v = variantOf(e, t.target);
    if (!v || v.slides[0]?.path || !isAnchorEdit(e, v, t.index)) continue;
    const anchor = e.tasks.filter(s => s.kind === 'slide' && s.target === v.id && s.index === 0);
    if (anchor.some(open) || !anchor.some(dead)) continue;
    t.status = 'failed';
    t.error = 'anchor_slide_unavailable: this slide edits slide 1 of its own variant, which failed and has no picture to edit. Retry slide 1 first.';
    const slide = v.slides[t.index];
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

/** Settles contract work that can never run, in the order that lets each step see the last: dead copies and anchor edits, then the QA that
 *  waited on them, then the arms. True when anything changed and must be saved. */
export function settleStrandedContract(e: Experiment): boolean {
  const copies = failDeadDependencies(e);
  const anchors = failDeadAnchors(e);
  const qa = reapContractQa(e);
  const arms = settleDeadArms(e);
  return copies || anchors || qa || arms;
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

/** Settles the experiment once every arm has: completed when all work is done, failed when an arm failed. One arm failing never
 *  stops the others (SLA-820): the run stays active until nothing is open, so every arm reaches a verdict the A/B can compare.
 *  An unknown outcome is left to the reaper, which pauses for review. */
export function settleContractCompletion(e: Experiment): void {
  if (!['planning', 'generating'].includes(e.status)) return;
  if (e.tasks.some(t => t.kind === 'revise' && open(t))) return;
  const work = e.tasks.filter(x => x.kind === 'slide' || x.kind === 'qa');
  if (work.some(open)) return;
  if (work.every(x => x.status === 'done')) { e.status = e.variants.some(v => v.status === 'draft') ? 'review' : 'completed'; return; }
  if (work.some(x => x.status === 'unknown')) return;
  e.status = 'failed';
  e.error = e.variants.find(v => v.qaDeck?.verdict === 'failed')?.error ?? work.find(x => x.status === 'failed' && x.error)?.error ?? 'deck_incomplete';
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
    const view = v.frozenBrief && e.contract ? contractView(e, v.frozenBrief, v) : null;
    const chain = !!view && view.identity === 'invented-consistent' && !view.keepSourceImage;
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
  settleContractCompletion(e);
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
  const view = v.frozenBrief && e.contract ? contractView(e, v.frozenBrief, v) : null;
  const chain = !!view && view.identity === 'invented-consistent' && !view.keepSourceImage;
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
