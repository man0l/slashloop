import { randomUUID } from 'node:crypto';
import {
  assertArmsDifferOnly, buildArmB, fixText, repairSlides, slideRole, pickFramesByArc, slideWork,
  type ArmBrief, type ArmField, type ContractSlide, type ResolvedContract, type SlideWork,
} from './resolved-contract.js';
import { ExperimentError, type BriefData, type Experiment, type Proposal, type Task, type Variant } from './schema.js';

// Pure parts of the resolved-contract pipeline: the contract as the renderer and QA see it,
// the two arms, scheduling rules and how finished tasks fold into the experiment. No I/O.

export const isContractPipeline = (e: Pick<Experiment, 'pipeline'>): boolean => e.pipeline === 'contract';

const FALLBACK_HOOK = 'No caption';
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
  const base = variantOf(e, v.baselineId);
  if (!base?.frozenBrief) return 'render';
  // The baseline must be producing (or have produced) the slide this one copies.
  if (base.status !== 'generating' && !base.slides[index]?.path) return 'render';
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

/** Called by the engine for slide and qa tasks of a contract experiment, after the briefs have settled. */
export function contractEligible(e: Experiment, t: Task): boolean {
  if (t.kind === 'qa') return !e.tasks.some(s => s.kind === 'slide' && s.target === t.target && open(s));
  const v = variantOf(e, t.target);
  if (!v) return true;
  const index = t.index ?? 0;
  const base = v.baselineId ? variantOf(e, v.baselineId) : undefined;
  if (base?.frozenBrief && base.status === 'generating' && slideWorkFor(e, v, index, t.fix) !== 'render') return false;
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
    const dead = mine.find(s => s.status === 'failed' || s.status === 'unknown');
    if (!dead) continue;
    t.status = 'failed'; t.error = 'deck_incomplete'; changed = true;
  }
  return changed;
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
  if (!e.tasks.filter(x => x.kind === 'slide' || x.kind === 'qa').every(x => x.status === 'done')) return;
  e.status = e.variants.some(v => v.status === 'draft') ? 'review' : 'completed';
}

export const QA_REPAIR_ROUNDS = 1;

/** One QA verdict per arm. A pass finishes the arm; a first hard failure buys one repair round (re-render of the
 *  failing slides carrying the QA text, then one re-QA); a failure after that is final and never downgraded. */
export function settleQa(e: Experiment, t: Task, result: QaTaskResult): void {
  mergeCalls(e, result.calls);
  const v = variantOf(e, t.target)!;
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
