// SLA-700: the resolved slide contract. One format-agnostic document that follows
// the user's direction: user direction > workspace locks > source defaults.
// The renderer and QA both read it; nothing here knows which source format it is.
// Pure module: no I/O, no provider calls, so every rule below is unit-testable.
import { z } from 'zod/v4';
import { MORPH_ATTRIBUTES, MORPH_GRADES, MorphError, assertNoValuationWords, redactValuation, morphAnchorText, morphAttribute, morphBlock, morphChangeText, morphChecks, normalizeMorphSlides, valuationWords, type MorphAttribute, type MorphSpec, type MorphStep } from './morph.js';

export const ARC_LEVELS = ['low', 'mid', 'high', 'none'] as const;
export type ArcLevel = (typeof ARC_LEVELS)[number];
export const IDENTITIES = ['none', 'source', 'invented-consistent', 'invented-per-slide'] as const;
export type Identity = (typeof IDENTITIES)[number];
export const SUBJECTS = ['none', 'objects', 'person', 'character', 'product-ui', 'mixed'] as const;
export type Subject = (typeof SUBJECTS)[number];
export type ReferenceUse = 'edit' | 'style-only' | 'none';
export type LockOrigin = 'user' | 'workspace';

export interface TaggedLock { text: string; origin: LockOrigin }
export interface ContractSlide { overlayText: string; arcLevel: ArcLevel; scene: string; composition: string; visibleChange: string;
  /** SLA-867: morph decks only. This slide's grade for every morph attribute; visibleChange is derived from it. */
  morph?: MorphStep[] }
export interface SourceFrameInfo { index: number; level: ArcLevel; showsPerson: boolean }
export const ARC_MAGNITUDES = ['none', 'subtle', 'clear', 'strong'] as const;
export type ArcMagnitude = (typeof ARC_MAGNITUDES)[number];
/** SLA-809: what the source frames themselves show changing, read from the pixels. The direction says
 *  where the story goes; this says how far the source moves the subject, so a brief cannot shrink it. */
export interface SourceArc { axis: string; levers: string[]; magnitude: ArcMagnitude; lowVsHigh: string }
export const NO_SOURCE_ARC: SourceArc = { axis: '', levers: [], magnitude: 'none', lowVsHigh: '' };
/** A pre-SLA-866 contract's single alternate. Read-only: nothing writes it any more. */
export interface VariantB { variable: string; value: string; slides: ContractSlide[] }
export type ArmField = 'hook' | 'character' | 'visualStyle' | 'caption' | 'cta' | 'concept' | 'slides' | 'scene' | 'morph';
/** One variable an alternate changes, with the value it takes. `slides` carries the whole alternate deck for concept/slides and the per-slide scenes for scene; [] otherwise. */
export interface ArmAxis { variable: ArmField; value: string; slides: ContractSlide[] }
export interface ContractAlternate { axes: ArmAxis[] }
export interface ResolvedContract {
  version: 1;
  subject: Subject;
  identity: Identity;
  identitySheet: string;
  medium: string;
  keepSourceImage: boolean;
  borrowSourceLook: boolean;
  arcAxis: string;
  sourceFrames: SourceFrameInfo[];
  /** SLA-809. Absent on contracts resolved before it. */
  sourceArc?: SourceArc;
  /** SLA-867: set on a morph deck: one invented subject, graded per slide along these attributes. */
  morph?: MorphSpec;
  hardLocks: TaggedLock[];
  keptSourceDefaults: string[];
  droppedSourceDefaults: Array<{ default: string; reason: string }>;
  droppedLocks: Array<{ lock: string; origin: LockOrigin; reason: string }>;
  slides: ContractSlide[];
  /** Derived from slides[0].overlayText; never an independent field. */
  hook: string;
  /** SLA-866: the alternates, composed by code from the model's value pools. Absent on contracts resolved before it. */
  alternates?: ContractAlternate[];
  /** Contracts resolved before SLA-866 carry their one alternate here. */
  variantB?: VariantB;
  /** Plain-language corrections code made to the model's answer. */
  issues: string[];
}

export interface ContractInput {
  direction: string;
  locks: TaggedLock[];
  sourceDefaults: string[];
  slideCount: number;
  frameCount: number;
  /** The variables the alternates change, in the caller's order. */
  variables: ArmField[];
  mode: 'controlled' | 'exploration';
  /** How many alternates to build (the baseline is not one of them). */
  alternates: number;
  /** Variable "scene": the user's own setting for arm B, one for every slide or exactly one per slide. Wins over the model's. */
  sceneOverrides?: string[];
  /** SLA-867: the deck is a morph ladder (the experiment approved the morph variable). */
  morph?: boolean;
}

export class ContractError extends Error {
  constructor(public code: string, message = code) { super(message); }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const uniq = <T>(xs: T[], key: (x: T) => string) => { const seen = new Set<string>(); return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Caller locks are the user's; the always-on locks are the workspace's. */
export function tagLocks(lockedConstraints: readonly string[], workspaceLocks: readonly string[]): TaggedLock[] {
  const ws = new Set(workspaceLocks.map(norm));
  return uniq(lockedConstraints.map(t => t.trim()).filter(Boolean).map(text => ({ text, origin: (ws.has(norm(text)) ? 'workspace' : 'user') as LockOrigin })), l => norm(l.text));
}

// ---- the model's answer -------------------------------------------------------

const Level = z.enum(ARC_LEVELS);
const RawSourceArc = z.object({ axis: z.string(), levers: z.array(z.string()), magnitude: z.enum(ARC_MAGNITUDES), lowVsHigh: z.string() });
const RawMorphStep = z.object({ attribute: z.string(), grade: z.number() });
const RawSlide = z.object({ overlayText: z.string(), arcLevel: Level, scene: z.string(), composition: z.string(), visibleChange: z.string(), morph: z.array(RawMorphStep).optional() });
export const RawContract = z.object({
  droppedSourceDefaults: z.array(z.object({ default: z.string(), reason: z.string() })),
  droppedLocks: z.array(z.object({ lock: z.string(), origin: z.string(), reason: z.string() })),
  subject: z.enum(SUBJECTS),
  identity: z.enum(IDENTITIES),
  identitySheet: z.string(),
  medium: z.string(),
  keepSourceImage: z.boolean(),
  borrowSourceLook: z.boolean(),
  arcAxis: z.string(),
  sourceFrameLevels: z.array(z.object({ index: z.number().int(), level: Level, showsPerson: z.boolean() })),
  // Optional for older callers and fixtures; the JSON schema still requires it from the model.
  sourceArc: RawSourceArc.optional(),
  morph: z.object({ axis: z.string(), attributes: z.array(z.string()) }).optional(),
  slides: z.array(RawSlide),
  pools: z.array(z.object({ variable: z.string(), values: z.array(z.object({ value: z.string(), slides: z.array(RawSlide) })) })),
});
export type RawContractT = z.infer<typeof RawContract>;

const S = { type: 'string' } as const;
const B = { type: 'boolean' } as const;
const obj = (p: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties: p, required: Object.keys(p) });
const arr = (items: unknown) => ({ type: 'array', items });
const LEVEL = { type: 'string', enum: [...ARC_LEVELS] };
const SLIDE_JSON = obj({ overlayText: S, arcLevel: LEVEL, scene: S, composition: S, visibleChange: S });
export const CONTRACT_JSON_SCHEMA = obj({
  droppedSourceDefaults: arr(obj({ default: S, reason: S })),
  droppedLocks: arr(obj({ lock: S, origin: S, reason: S })),
  subject: { type: 'string', enum: [...SUBJECTS] },
  identity: { type: 'string', enum: [...IDENTITIES] },
  identitySheet: S, medium: S, keepSourceImage: B, borrowSourceLook: B, arcAxis: S,
  sourceFrameLevels: arr(obj({ index: { type: 'integer' }, level: LEVEL, showsPerson: B })),
  sourceArc: obj({ axis: S, levers: arr(S), magnitude: { type: 'string', enum: [...ARC_MAGNITUDES] }, lowVsHigh: S }),
  slides: arr(SLIDE_JSON),
  pools: arr(obj({ variable: S, values: arr(obj({ value: S, slides: arr(SLIDE_JSON) })) })),
});
const MORPH_SLIDE_JSON = obj({ overlayText: S, arcLevel: LEVEL, scene: S, composition: S, visibleChange: S,
  morph: arr(obj({ attribute: { type: 'string', enum: [...MORPH_ATTRIBUTES] }, grade: { type: 'integer' } })) });
/** SLA-867: the morph deck's answer: the same contract plus the morph axis and every slide's grades, arm A's and
 *  every pool value's (an alternate's slides without grades would all repeat slide 1 and fail as morph_flat). */
export const MORPH_CONTRACT_JSON_SCHEMA = {
  ...CONTRACT_JSON_SCHEMA,
  properties: { ...CONTRACT_JSON_SCHEMA.properties, morph: obj({ axis: S, attributes: arr({ type: 'string', enum: [...MORPH_ATTRIBUTES] }) }),
    slides: arr(MORPH_SLIDE_JSON), pools: arr(obj({ variable: S, values: arr(obj({ value: S, slides: arr(MORPH_SLIDE_JSON) })) })) },
  required: [...CONTRACT_JSON_SCHEMA.required, 'morph'],
};
export const contractJsonSchema = (input: Pick<ContractInput, 'morph'>) => input.morph ? MORPH_CONTRACT_JSON_SCHEMA : CONTRACT_JSON_SCHEMA;

export const CONTRACT_SYSTEM = 'You turn a user\'s creative direction into a format-agnostic slide contract for a 9:16 social carousel. '
  + 'Precedence: user direction and origin=user locks > origin=workspace locks > source defaults. '
  + 'A source default that conflicts with the direction or with any lock is DROPPED: list it in droppedSourceDefaults with the reason, copying its text exactly. '
  + 'A workspace lock is dropped ONLY if the user\'s direction explicitly contradicts it (for example the user keeps a real source person against a "no real people" lock); otherwise it stays. Never drop an origin=user lock. '
  + 'Never copy the source\'s overlay text unless the direction asks for it; the direction\'s exact wording for on-image text wins. Return JSON only.';

// SLA-809: image providers refuse an edit that judges a body ("fat", "ugly"); the same change in neutral words renders.
const NEUTRAL_WORDS = 'Describe bodies and faces in neutral photographic words (fuller, rounder, softer, less defined, paler, thinner), never judging or shaming ones (fat, obese, ugly, puffy, bloated, flabby, disgusting).';

export function contractFieldGuide(input: ContractInput): Record<string, string> {
  return {
    subject: 'what the slides show',
    identity: 'none | source (the source subject is kept) | invented-consistent (one invented person or character on every slide) | invented-per-slide',
    identitySheet: 'if invented-consistent: a precise visual description reused verbatim on every slide (face, body, hair, outfit, art style). Otherwise "".',
    medium: 'the resolved medium plus style words for every slide',
    keepSourceImage: 'true ONLY if the direction says to keep the source images and change only the text',
    borrowSourceLook: 'true if the direction keeps the source medium or drawing style while changing the content',
    sourceArc: `read from the attached source frames in order, by looking at the pixels (not the captions): does the SAME subject (a person's face or body, a character, an object, a room, a product...) visibly change from frame to frame? axis: that change in a few words; levers: every concrete visible attribute that changes (for example "cheek and jaw fullness", "hair volume", "skin texture", "clutter on the desk"); magnitude: subtle | clear | strong = how different the two extreme frames look at phone size; lowVsHigh: the concrete visible difference between the frame furthest down the axis and the frame furthest up, written as landmarks and proportions. ${NEUTRAL_WORDS} If nothing changes or there are no source frames: axis "", levers [], magnitude "none", lowVsHigh "". ${retellsStory(input)
      // A tested variable IS the storyline: an alternate may retell it without the source's change (SLA-809).
      ? `This change is part of arm A's story. Some alternates test a different storyline, so their slides show this change only if their own story keeps that progression; when they do, at the same scale.`
      : `This change is part of the story, not a tested variable: arm A and every alternate show it, and only ${variableList(input.variables)} ${input.variables.length === 1 ? 'differs' : 'differ'} between them.`}`,
    arcAxis: 'the story axis in a few words if the direction states a progression (before/after, low to high, week 1 to week 4), or if sourceArc shows one and the direction keeps the source format without asking to drop it; otherwise ""',
    'slides[].arcLevel': 'position on the arc axis (low, mid or high); none for every slide when arcAxis is ""',
    'slides[].overlayText': 'the exact on-image text for that slide ("" for none). The first slide\'s text is the hook.',
    'slides[].scene': 'what is in the image, concrete, from the direction. On an arc the LOW slide must show the low state unmistakably, described with the same landmarks as the HIGH slide.',
    'slides[].composition': 'layout and framing',
    'slides[].visibleChange': 'for slides after the first: the concrete physical difference from the FIRST slide (the image model only sees the first image), written as visible landmarks and proportions, not percentages (for example "X now as wide as Y", "Z clearly visible"), big enough to read at phone size. On an arc that sourceArc also shows, use sourceArc.levers and match the source\'s magnitude: the slide furthest from the first on the axis differs from it at least as much as sourceArc.lowVsHigh, a slide halfway differs about half as much. Drop a lever only when the direction or a lock keeps that property fixed or forbids it (for example the same hair, expression, head angle, framing, outfit or background); every lever they do not name follows the source. A variable that is not being tested (character, style, hook...) stays the same between arm A and arm B; that never stops the subject changing along the arc inside one deck. Identity wording ("the same man", "same bone structure", "recognisably the same", "an edit of the same base face") keeps WHO the subject is, not how much they change: the source keeps one subject while changing these levers, so the deck does too. Wording asking for small, subtle, ordinary or non-extreme changes never makes the change smaller than the source shows. Do not write "unchanged" or "same as the first slide" for a lever sourceArc lists. ' + NEUTRAL_WORDS + ' The composition of every slide must keep the feature that changes fully visible, nothing covering it. "" for the first slide or when nothing changes.',
    sourceFrameLevels: 'rank EVERY attached source frame (index from 0) on YOUR arcAxis (low/mid/high, none if it does not show the axis) by looking at the images, and set showsPerson=true if a person or character is visible in it',
    pools: poolsGuide(input),
    ...(input.morph ? morphFieldGuide(input) : {}),
  };
}

// SLA-867: a morph deck reproduces a "ladder" carousel: one invented subject in one studio set-up, graded slide by slide.
const VALUATION_RULE = 'Never write a valuation word in scene, composition, identitySheet or medium: no tier or rank names (chad, htn, mtn, ltn, sub 5...), no psl, score, rating, percentage, testosterone, attractive, ugly or handsome. Those words belong only in overlayText, which code draws onto the finished picture.';

function morphFieldGuide(input: ContractInput): Record<string, string> {
  const grades = MORPH_ATTRIBUTES.map(a => `${a}: ${MORPH_GRADES[a].map((w, g) => `${g}=${w}`).join(', ')}`).join(' | ');
  return {
    identity: 'invented-consistent: a morph deck shows ONE invented adult on every slide, never the source person.',
    identitySheet: `the invented subject exactly as slide 1 shows them, in neutral visible words: apparent age, skin tone, hair colour and style, eye colour, wardrobe. Reused verbatim on every slide. ${VALUATION_RULE}`,
    arcAxis: '"" on a morph deck: the morph grades carry the progression, so every slides[].arcLevel is none.',
    sourceFrameLevels: 'every attached source frame with level none, showsPerson as seen',
    morph: `axis: the progression in a few neutral words (for the user only; the image model never sees it). attributes: the 2 to 5 attributes from this list that the source frames visibly change, most visible first: ${MORPH_ATTRIBUTES.join(', ')}.`,
    'slides[].morph': `one {attribute, grade} for EVERY morph attribute on EVERY slide, grade 0..4 meaning: ${grades}. Read the grades off the source frames in order, by looking at the pixels. Each attribute moves one way only across the deck (equal steps allowed, never back), and the last slide differs from the first by at least 2 grades on most attributes.`,
    'slides[].scene': `the same studio set-up on every slide: the subject, backdrop, framing and lighting copied from the source frames, in visible words only. ${VALUATION_RULE}`,
    'slides[].visibleChange': '"" (code writes it from the grades).',
    'slides[].overlayText': 'the exact label for that slide. When the direction keeps the source format, copy the source slide\'s own label (for example a rank name and a percentage line). Put a line break between a title and its subtitle ("TITLE\\nsubtitle"). Code draws it onto the finished picture; the image model never sees it.',
  };
}

export function contractPromptPayload(input: ContractInput, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra, ...(input.frameCount === 0 ? { sourceNote: 'There is no source video and no source frames. The direction is the complete brief: build every slide, its scene and its exact overlay text from it. keepSourceImage and borrowSourceLook must be false and sourceFrameLevels must be [].' } : {}),
    direction: input.direction, locks: input.locks.map(l => ({ lock: l.text, origin: l.origin })),
    sourceDefaults: input.sourceDefaults, slideCount: input.slideCount, sourceFrameCount: input.frameCount,
    fieldGuide: contractFieldGuide(input),
  });
}

// ---- planning the alternates: which variables each one changes, and which value of each ----

/** Most values the model is asked for per variable: short strings can be many, per-slide or whole-deck answers are kept small. */
export const POOL_CAP: Record<ArmField, number> = { hook: 12, caption: 12, cta: 12, character: 6, visualStyle: 6, concept: 5, scene: 5, slides: 3, morph: 3 };

/** The variables as axes: a whole-storyline `slides` test is folded into `concept`, which then carries the storyline itself. */
export function armVariables(variables: readonly ArmField[]): ArmField[] {
  const unique = [...new Set(variables)];
  return unique.includes('concept') ? unique.filter(v => v !== 'slides') : unique;
}
const retellsStory = (input: Pick<ContractInput, 'variables'>) => input.variables.includes('concept') || input.variables.includes('slides');
const variableList = (vs: readonly ArmField[]) => vs.map(v => `"${v}"`).join(', ');

export interface AlternatePlan { axes: Array<{ variable: ArmField; pick: number }> }

/**
 * Which variables each of up to `n` alternates changes and which pool value each takes. Deterministic.
 * `controlled`: one variable per alternate, round-robin. `exploration`: one clean single-variable control per
 * variable first (so each effect can be attributed), then combinations of 2..V variables rotating evenly.
 * `sizes` is how many distinct values each pool really holds; fewer than `n` plans come back when they run out.
 */
export function planAlternates(variables: readonly ArmField[], mode: 'controlled' | 'exploration', n: number, sizes: Partial<Record<ArmField, number>> = {}): AlternatePlan[] {
  const size = (v: ArmField) => Math.min(sizes[v] ?? POOL_CAP[v], POOL_CAP[v]);
  const vars = armVariables(variables).filter(v => size(v) > 0);
  const out: AlternatePlan[] = [];
  const used = new Map<ArmField, number>();
  const seen = new Set<string>();
  const take = (subset: ArmField[]): boolean => {
    const axes = subset.map(variable => ({ variable, pick: (used.get(variable) ?? 0) % size(variable) }));
    const key = axes.map(a => `${a.variable}:${a.pick}`).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    for (const a of axes) used.set(a.variable, (used.get(a.variable) ?? 0) + 1);
    out.push({ axes });
    return true;
  };
  const roundRobin = (pool: ArmField[]) => {
    const live = [...pool];
    for (let k = 0; out.length < n && live.length; k++) {
      const v = live[k % live.length]!;
      if (!take([v])) { live.splice(k % live.length, 1); k--; }
    }
  };
  if (n <= 0 || !vars.length) return out;
  if (mode === 'controlled' || vars.length === 1) { roundRobin(vars); return out; }
  for (const v of vars.slice(0, n)) take([v]);
  const subsetsOf = (k: number): ArmField[][] => {
    const acc: ArmField[][] = [];
    const go = (start: number, cur: ArmField[]) => {
      if (cur.length === k) { acc.push([...cur]); return; }
      for (let i = start; i < vars.length; i++) { cur.push(vars[i]!); go(i + 1, cur); cur.pop(); }
    };
    go(0, []);
    return acc;
  };
  const bySize = new Map<number, ArmField[][]>();
  for (let k = 2; k <= vars.length; k++) bySize.set(k, subsetsOf(k));
  const cursor = new Map<number, number>();
  const sizesCycle = [...bySize.keys()];
  for (let tries = 0, left = Math.max(0, n - out.length); out.length < n && tries < left * 8 + 32; tries++) {
    const k = sizesCycle[tries % sizesCycle.length]!;
    const list = bySize.get(k)!;
    const at = cursor.get(k) ?? 0;
    cursor.set(k, at + 1);
    take(list[at % list.length]!);
  }
  if (out.length < n) roundRobin(vars);
  return out;
}

const poolCaps = (input: Pick<ContractInput, 'sceneOverrides'>): Partial<Record<ArmField, number>> => (input.sceneOverrides?.length ? { scene: 1 } : {});

/** How many distinct values the model must supply per variable for the plan to fill every alternate. */
export function poolNeeds(input: Pick<ContractInput, 'variables' | 'mode' | 'alternates' | 'sceneOverrides'>): Partial<Record<ArmField, number>> {
  const needs: Partial<Record<ArmField, number>> = {};
  for (const plan of planAlternates(input.variables, input.mode, input.alternates, poolCaps(input)))
    for (const a of plan.axes) needs[a.variable] = Math.max(needs[a.variable] ?? 0, a.pick + 1);
  return needs;
}

/** Every alternate of a contract, whichever way it was stored. */
export function armsOf(c: Pick<ResolvedContract, 'alternates' | 'variantB'>): ContractAlternate[] {
  if (c.alternates) return c.alternates;
  return c.variantB ? [{ axes: [{ variable: c.variantB.variable as ArmField, value: c.variantB.value, slides: c.variantB.slides }] }] : [];
}

function poolsGuide(input: ContractInput): string {
  const needs = poolNeeds(input);
  const n = input.slideCount;
  const help: Record<ArmField, string> = {
    hook: 'value = a different first-slide overlay text that tests a different hook while keeping the same story; slides [].',
    caption: 'value = the alternative caption text; slides [].',
    cta: 'value = the alternative call-to-action text; slides [].',
    character: 'value = an alternative identitySheet (a precise visual description of a different person or character); slides [].',
    visualStyle: 'value = an alternative medium plus style words; slides [].',
    concept: input.variables.includes('slides')
      ? `value = a short name for the angle; slides = that angle's whole storyline (${n} slides).`
      : `value = a short name for a new angle (a different way to tell the same story); slides = the same ${n} slides as arm A with ONLY overlayText rewritten for that angle (set scene, composition and visibleChange to "" and arcLevel to "none": they are ignored).`,
    slides: `value = ""; slides = the alternative storyline (${n} slides).`,
    morph: `value = the alternative progression in a few neutral words; slides = ${n} slides with the same overlayText, scene and composition as arm A's slides; slide 1 has the same grades as arm A's slide 1, the later slides follow a different curve or end point on the same attributes, still one way only.`,
    scene: input.sceneOverrides?.length
      ? `the user fixed the setting: return one value, value = that setting; slides = ${n} slides where ONLY scene is filled: arm A's slide re-staged in that setting, with that slide's same person, outfit and pose, so only the setting and props change (overlayText, composition and visibleChange "", arcLevel "none").`
      : `value = an alternative setting, props and action in one sentence; slides = ${n} slides where ONLY scene is filled (that setting for that slide's beat; overlayText, composition and visibleChange "", arcLevel "none"). The person, medium, lighting, camera and overlay text stay as in arm A.`,
  };
  const entries = armVariables(input.variables).filter(v => needs[v]).map(v => `${v}: exactly ${needs[v]} distinct value(s). ${help[v]}`);
  return `One entry per variable below, as { variable, values: [{ value, slides }] }, each with exactly that many DISTINCT values that all differ from arm A. Code combines the values into the alternates: never combine them yourself, never repeat arm A. ${entries.join(' ')}${input.variables.includes('scene') ? ' keepSourceImage must be false: a scene alternate re-stages every slide, so the source photos cannot stay as they are.' : ''}`;
}

// ---- normalization: precedence and invariants live in code ---------------------

const cleanSlide = (s: Omit<ContractSlide, 'morph'>, arcOn: boolean): ContractSlide => ({
  overlayText: s.overlayText.trim(), arcLevel: arcOn ? s.arcLevel : 'none',
  scene: s.scene.trim(), composition: s.composition.trim(), visibleChange: s.visibleChange.trim(),
});

export function normalizeContract(rawIn: unknown, input: ContractInput): ResolvedContract {
  const parsed = RawContract.safeParse(rawIn);
  if (!parsed.success) throw new ContractError('contract_invalid', 'The slide contract did not match its schema.');
  const raw = parsed.data;
  const issues: string[] = [];
  if (raw.slides.length < input.slideCount) throw new ContractError('contract_slide_count', `The contract has ${raw.slides.length} slides; ${input.slideCount} were requested.`);
  const morphOn = !!input.morph;
  // A morph deck's progression is its grades, not an arc axis.
  const arcAxis = morphOn ? '' : raw.arcAxis.trim();
  const arcOn = arcAxis !== '';
  let slides = raw.slides.slice(0, input.slideCount).map(s => cleanSlide(s, arcOn));
  if (slides.some(s => !s.scene) ) throw new ContractError('contract_empty_scene', 'Every slide needs a scene.');

  // Locks: user locks can never be dropped; a workspace lock only with a stated reason.
  const droppedLocks: ResolvedContract['droppedLocks'] = [];
  for (const d of raw.droppedLocks) {
    const lock = input.locks.find(l => norm(l.text) === norm(d.lock));
    if (!lock) continue;
    if (lock.origin === 'user') { issues.push(`Kept the user lock "${lock.text}": a user lock is never dropped.`); continue; }
    if (!d.reason.trim()) { issues.push(`Kept the workspace lock "${lock.text}": a drop needs a reason.`); continue; }
    if (!droppedLocks.some(x => norm(x.lock) === norm(lock.text))) droppedLocks.push({ lock: lock.text, origin: lock.origin, reason: d.reason.trim() });
  }
  const hardLocks = input.locks.filter(l => !droppedLocks.some(d => norm(d.lock) === norm(l.text)));

  const droppedSourceDefaults: ResolvedContract['droppedSourceDefaults'] = [];
  for (const d of raw.droppedSourceDefaults) {
    const def = input.sourceDefaults.find(s => norm(s) === norm(d.default));
    if (!def || !d.reason.trim() || droppedSourceDefaults.some(x => norm(x.default) === norm(def))) continue;
    droppedSourceDefaults.push({ default: def, reason: d.reason.trim() });
  }
  const keptSourceDefaults = input.sourceDefaults.filter(s => !droppedSourceDefaults.some(d => norm(d.default) === norm(s)));

  // A brief-only experiment has no source frames: nothing can be kept or borrowed, so those flags and the "source" identity are void whatever the model says.
  const sourceless = input.frameCount === 0;
  // A scene arm re-stages every slide, so the source photos cannot stay as they are.
  const sceneArm = input.variables.includes('scene');
  // A morph deck invents its subject and edits slide 1 of its own, never a source photo.
  const keepSourceImage = raw.keepSourceImage && !sourceless && !sceneArm && !morphOn;
  const borrowSourceLook = raw.borrowSourceLook && !sourceless;
  if (morphOn && raw.keepSourceImage) issues.push('A morph deck invents one subject and grades it slide by slide, so the source photos are not kept.');
  if (sourceless && (raw.keepSourceImage || raw.borrowSourceLook)) issues.push('There is no source video, so there are no source images to keep or borrow a look from; every slide is created new from the brief.');
  if (sceneArm && raw.keepSourceImage && !sourceless) issues.push('Changing the scene re-stages every slide, so the source images are not kept unchanged.');
  let identity = raw.identity;
  if (sourceless && identity === 'source') identity = 'invented-per-slide';
  if (morphOn && identity !== 'invented-consistent') {
    issues.push('A morph deck shows one invented subject on every slide, so the identity is "invented-consistent".');
    identity = 'invented-consistent';
  }
  if (keepSourceImage && identity !== 'source' && identity !== 'none') {
    issues.push('Editing the source images keeps the source subject, so the identity is "source".');
    identity = 'source';
  }
  if (identity === 'invented-consistent' && !raw.identitySheet.trim()) throw new ContractError('contract_identity_sheet', 'An invented-consistent identity needs an identity sheet.');
  const identitySheet = identity === 'invented-consistent' ? raw.identitySheet.trim() : '';

  const frames = new Map<number, SourceFrameInfo>();
  for (const f of raw.sourceFrameLevels) {
    if (f.index < 0 || f.index >= input.frameCount || frames.has(f.index)) continue;
    frames.set(f.index, { index: f.index, level: arcOn ? f.level : 'none', showsPerson: f.showsPerson });
  }
  // A frame the model did not describe is unknown, and an unknown frame may show a person.
  for (let i = 0; i < input.frameCount; i++) if (!frames.has(i)) frames.set(i, { index: i, level: 'none', showsPerson: true });

  const sourceFrames = [...frames.values()].sort((a, b) => a.index - b.index);
  const sourceArc = normalizeSourceArc(raw.sourceArc, sourceless);
  if (!arcOn && sourceArc.magnitude !== 'none') issues.push(`The source frames show "${sourceArc.axis}", but the direction does not ask for a progression, so the slides do not follow it.`);
  const framing = { keepSourceImage, borrowSourceLook: borrowSourceLook && !keepSourceImage, identity, sourceFrames, arcAxis };
  const kept = framedIndices(framing, slides);
  const framed = kept.map(i => slides[i]!);
  if (!framed.length) throw new ContractError('contract_no_matching_frame', 'No source frame matches any slide, and the source images are kept.');
  if (framed.length < slides.length) {
    issues.push(`Keeping the source images: ${slides.length - framed.length} slide(s) had no unused source frame at their arc level and were dropped, so the deck has ${framed.length} slides.`);
    slides = framed;
  }

  let morph: MorphSpec | undefined;
  if (morphOn) {
    ({ morph, slides } = morphSlides(raw.morph, raw.slides.slice(0, slides.length), slides));
    lintMorphContract({ identitySheet, medium: raw.medium.trim(), slides, locks: hardLocks.map(l => l.text) });
  }
  const alternates = normalizeAlternates(raw.pools, input, arcOn, framing, slides, kept, { identitySheet, medium: raw.medium.trim() }, issues);
  return {
    version: 1, subject: raw.subject, identity, identitySheet, medium: raw.medium.trim(),
    keepSourceImage: framing.keepSourceImage, borrowSourceLook: framing.borrowSourceLook, arcAxis,
    sourceFrames, sourceArc, ...(morph ? { morph } : {}),
    hardLocks, keptSourceDefaults, droppedSourceDefaults, droppedLocks,
    slides, hook: slides[0]!.overlayText, alternates, issues,
  };
}

function normalizeSourceArc(a: RawContractT['sourceArc'], sourceless: boolean): SourceArc {
  if (!a) return { ...NO_SOURCE_ARC, levers: [] };
  const axis = a.axis.trim();
  const levers = uniq(a.levers.map(l => l.trim()).filter(Boolean), norm).slice(0, 8);
  const lowVsHigh = a.lowVsHigh.trim();
  // A change nobody can name is not a change the renderer can be held to.
  if (sourceless || !axis || a.magnitude === 'none' || (!levers.length && !lowVsHigh)) return { ...NO_SOURCE_ARC, levers: [] };
  return { axis, levers, magnitude: a.magnitude, lowVsHigh };
}

const asContractError = (err: unknown): never => {
  if (err instanceof MorphError) throw new ContractError(err.code, err.message);
  throw err;
};

/** SLA-867: the deck's grades, validated, with every slide's visibleChange written from them. */
function morphSlides(spec: RawContractT['morph'], raw: RawContractT['slides'], slides: ContractSlide[]): { morph: MorphSpec; slides: ContractSlide[] } {
  const named = uniq((spec?.attributes ?? []).map(morphAttribute).filter((a): a is MorphAttribute => !!a), a => a);
  let grades: MorphStep[][] = [];
  try { grades = normalizeMorphSlides(raw.map(s => s.morph ?? []), named.length ? named : undefined); } catch (err) { asContractError(err); }
  const anchor = grades[0]!;
  return {
    morph: { axis: spec?.axis.trim() || anchor.map(s => s.attribute).join(', '), attributes: anchor.map(s => s.attribute) },
    slides: slides.map((s, i) => ({ ...s, morph: grades[i]!, visibleChange: i ? morphChangeText(anchor, grades[i]!) : '' })),
  };
}

/** SLA-867: nothing the image model reads may carry a valuation word. The overlay copy is exempt: code draws it. */
function lintMorphContract(c: { identitySheet: string; medium: string; slides: ContractSlide[]; locks: string[] }): void {
  const fields: Record<string, string> = { identitySheet: c.identitySheet, medium: c.medium };
  c.slides.forEach((s, i) => { fields[`slides[${i}].scene`] = s.scene; fields[`slides[${i}].composition`] = s.composition; fields[`slides[${i}].morph`] = s.visibleChange; });
  c.locks.forEach((l, i) => { fields[`locks[${i}]`] = l; });
  try { assertNoValuationWords(fields); } catch (err) { asContractError(err); }
}

interface PoolValue { value: string; slides: ContractSlide[] }

const canonVariable = (v: string): string => (v.trim() === 'angle' ? 'concept' : v.trim());

/** The alternates: the model's value pools, cleaned and de-duplicated, combined by `planAlternates`. A variable with no usable value cannot be tested, so it fails the contract (one repair round, see the pipeline). */
function normalizeAlternates(
  pools: RawContractT['pools'], input: ContractInput, arcOn: boolean, framing: Parameters<typeof onlyFramedSlides>[0],
  armA: ContractSlide[], kept: number[], base: { identitySheet: string; medium: string }, issues: string[],
): ContractAlternate[] {
  const vars = armVariables(input.variables);
  const storyline = input.variables.includes('slides');
  const given = (input.sceneOverrides ?? []).map(x => x.trim()).filter(Boolean);
  if (given.length > 1 && given.length !== armA.length) throw new ContractError('contract_scene_count', `The scene needs one description for every slide or one per slide (${armA.length}); ${given.length} were given.`);
  const cleaned = new Map<ArmField, PoolValue[]>();
  for (const variable of vars) {
    const raws = pools.filter(p => canonVariable(p.variable) === variable || (variable === 'concept' && canonVariable(p.variable) === 'slides')).flatMap(p => p.values);
    const out: PoolValue[] = [];
    const seen = new Set<string>();
    const add = (v: PoolValue | null) => {
      if (!v) return;
      const key = norm(v.value) + '|' + v.slides.map(slideKey).join('|');
      if (seen.has(key)) return;
      seen.add(key); out.push(v);
    };
    if (variable === 'scene' && given.length) {
      // SLA-881: the model's per-slide re-staging keeps each slide's outfit and pose; the bare setting is the fallback.
      const restaged = (raws[0]?.slides ?? []).slice(0, armA.length).map(s => s.scene.trim());
      const usable = restaged.length === armA.length && restaged.every((x, i) => x && norm(x) !== norm(armA[i]!.scene));
      const scenes = usable ? restaged : armA.map((_, i) => given[given.length === 1 ? 0 : i]!);
      add({ value: given.join(' | '), slides: armA.map((s, i) => ({ ...s, scene: scenes[i]! })) });
    } else {
      for (const r of raws) add(poolValue(variable, r, { input, arcOn, framing, armA, kept, base, storyline }));
    }
    cleaned.set(variable, out.slice(0, POOL_CAP[variable]));
  }
  const need = poolNeeds(input);
  for (const variable of vars) {
    if (need[variable] && !cleaned.get(variable)!.length) throw new ContractError('contract_variant_missing', `The alternates need at least one usable, different value for "${variable}".`);
  }
  const sizes: Partial<Record<ArmField, number>> = {};
  for (const variable of vars) sizes[variable] = cleaned.get(variable)!.length;
  for (const variable of vars) if (need[variable] && sizes[variable]! < need[variable]!) issues.push(`Only ${sizes[variable]} distinct ${variable} value(s) came back, ${need[variable]} were asked for.`);
  const plans = planAlternates(input.variables, input.mode, input.alternates, sizes);
  if (!plans.length) throw new ContractError('contract_variant_missing', 'No alternate could be built from the values returned.');
  return plans.map(plan => ({ axes: plan.axes.map(a => ({ variable: a.variable, ...cleaned.get(a.variable)![a.pick]! })) }));
}

/** One model value as a pool entry, or null when it is empty or equal to arm A. */
function poolValue(
  variable: ArmField, r: RawContractT['pools'][number]['values'][number],
  c: { input: ContractInput; arcOn: boolean; framing: Parameters<typeof onlyFramedSlides>[0]; armA: ContractSlide[]; kept: number[]; base: { identitySheet: string; medium: string }; storyline: boolean },
): PoolValue | null {
  const value = r.value.trim();
  const slides = r.slides.slice(0, c.input.slideCount).map(s => cleanSlide(s, c.arcOn));
  switch (variable) {
    case 'hook': return value && norm(value) !== norm(c.armA[0]!.overlayText) ? { value, slides: [] } : null;
    case 'caption': case 'cta': return value ? { value, slides: [] } : null;
    case 'character': return value && norm(value) !== norm(c.base.identitySheet) ? { value, slides: [] } : null;
    case 'visualStyle': return value && norm(value) !== norm(c.base.medium) ? { value, slides: [] } : null;
    case 'scene': {
      const scenes = c.armA.map((_, i) => slides[i]?.scene || value);
      if (scenes.some(x => !x) || scenes.every((x, i) => norm(x) === norm(c.armA[i]!.scene))) return null;
      return { value: value || scenes[0]!, slides: c.armA.map((s, i) => ({ ...s, scene: scenes[i]! })) };
    }
    case 'concept': case 'slides': {
      if (slides.length < c.input.slideCount) return null;
      let alt: ContractSlide[];
      if (c.storyline) {
        alt = onlyFramedSlides(c.framing, slides);
        if (!alt.length) return null;
      } else {
        // The slides are locked: an angle retells only the words, on the same pictures.
        alt = c.armA.map((s, j) => ({ ...s, overlayText: slides[c.kept[j]!]!.overlayText }));
      }
      // On a morph deck an alternative storyline keeps arm A's grades: the subject still changes the same way.
      if (c.input.morph) alt = alt.map((s, i) => ({ ...s, morph: c.armA[i]?.morph ?? c.armA[c.armA.length - 1]!.morph, visibleChange: c.armA[i]?.visibleChange ?? '' }));
      if (alt.length === c.armA.length && alt.every((s, i) => slideKey(s) === slideKey(c.armA[i]!))) return null;
      return { value: variable === 'slides' ? '' : value, slides: alt };
    }
    case 'morph': {
      if (!c.input.morph) throw new ContractError('contract_variable', 'The morph variable needs a morph deck.');
      if (!value) return null;
      if (r.slides.length < c.armA.length) return null;
      // The alternate keeps arm A's subject: slide 1 is arm A's (so it is reused, not re-cast) and only the later grades differ.
      const anchor = c.armA[0]!.morph!;
      let grades: MorphStep[][] = [];
      try { grades = normalizeMorphSlides([anchor, ...r.slides.slice(1, c.armA.length).map(s => s.morph ?? [])], anchor.map(s => s.attribute)); } catch (err) { asContractError(err); }
      const alt = c.armA.map((s, i) => ({ ...s, morph: grades[i]!, visibleChange: i ? morphChangeText(anchor, grades[i]!) : '' }));
      if (alt.every((s, i) => JSON.stringify(s.morph) === JSON.stringify(c.armA[i]!.morph))) return null;
      return { value, slides: alt };
    }
  }
}

// ---- code decides how a source image is used ----------------------------------

/** `edit` only when the source images are kept. `style-only` only when the source
 *  look is borrowed AND the identity is not invented, or no source frame shows a
 *  person: image models copy whoever is in a reference. Everything else is `none`. */
export function chooseReferenceUse(c: Pick<ResolvedContract, 'keepSourceImage' | 'borrowSourceLook' | 'identity' | 'sourceFrames'>): ReferenceUse {
  if (c.keepSourceImage) return 'edit';
  if (c.borrowSourceLook && (!c.identity.startsWith('invented') || !c.sourceFrames.some(f => f.showsPerson))) return 'style-only';
  return 'none';
}

/** The indices of the slides that keep a source frame. With the source images kept, a slide that finds no frame would be rendered as a new photo, so it is dropped, never rendered. */
export function framedIndices(c: Pick<ResolvedContract, 'keepSourceImage' | 'borrowSourceLook' | 'identity' | 'sourceFrames' | 'arcAxis'>, slides: ContractSlide[]): number[] {
  if (!c.keepSourceImage) return slides.map((_, i) => i);
  const picks = pickFramesByArc({ ...c, slides });
  return slides.map((_, i) => i).filter(i => picks[i]!.frameIndex !== null);
}
export function onlyFramedSlides<T extends ContractSlide>(c: Pick<ResolvedContract, 'keepSourceImage' | 'borrowSourceLook' | 'identity' | 'sourceFrames' | 'arcAxis'>, slides: T[]): T[] {
  return framedIndices(c, slides).map(i => slides[i]!);
}

export interface FramePick { referenceUse: ReferenceUse; frameIndex: number | null; note?: string }

/** Frames are chosen by arc level, never by slide position. A frame is used once.
 *  A slide with no matching frame is created new (referenceUse none). */
export function pickFramesByArc(c: Pick<ResolvedContract, 'keepSourceImage' | 'borrowSourceLook' | 'identity' | 'sourceFrames' | 'arcAxis' | 'slides'>): FramePick[] {
  const use = chooseReferenceUse(c);
  const none = (note?: string): FramePick => ({ referenceUse: 'none', frameIndex: null, note });
  if (use === 'none') return c.slides.map(() => none());
  const used = new Set<number>();
  return c.slides.map(s => {
    const free = c.sourceFrames.filter(f => !used.has(f.index));
    // Style references may not carry a person when the identity is invented; the chooser already gated that per deck.
    let pool: SourceFrameInfo[];
    if (c.arcAxis && s.arcLevel !== 'none') {
      pool = free.filter(f => f.level === s.arcLevel);
      if (!pool.length) return none(`no unused source frame at the ${s.arcLevel} level`);
    } else pool = free.filter(f => f.level === 'none' || !c.arcAxis);
    if (!pool.length) return none('no unused source frame');
    const f = s.arcLevel === 'high' ? pool[pool.length - 1]! : pool[0]!;
    used.add(f.index);
    return { referenceUse: use, frameIndex: f.index };
  });
}

// ---- the slide prompt, compiled from the contract ------------------------------

export type SlideRole = 'edit' | 'anchor-edit' | 'baseline-edit' | 'fresh';
const ARC_WORDS: Record<Exclude<ArcLevel, 'none'>, string> = { low: 'LOW (worst / earliest)', mid: 'MIDDLE', high: 'HIGH (best / latest)' };

export function textLine(overlayText: string): string {
  return overlayText
    ? `TEXT: render exactly "${overlayText}" once, large, bold and legible, inside the safe area. It is the only caption. Text that is part of an app screen described in the scene is allowed; no other words, logos or watermarks.`
    : 'TEXT: no caption, no words.';
}

export function arcLine(c: Pick<ResolvedContract, 'arcAxis'>, s: ContractSlide): string {
  return c.arcAxis && s.arcLevel !== 'none'
    // Image models print a quoted axis as a scale or tier label; the state must be drawn, never written.
    ? `STORY POSITION: on the axis "${c.arcAxis}" this image is the ${ARC_WORDS[s.arcLevel]} point; the picture itself must visibly show that state. Do not write the axis, its end labels, a scale, a slider, a tier or level name, or a percentage anywhere in the image.`
    : '';
}

const LEVEL_RANK: Record<Exclude<ArcLevel, 'none'>, number> = { low: 0, mid: 1, high: 2 };

/** Steps between a slide and the first slide on the arc: 0 (same point or no arc), 1 (halfway), 2 (the other end). */
export function arcDistance(c: Pick<ResolvedContract, 'arcAxis' | 'slides'>, s: ContractSlide): number {
  const first = c.slides[0];
  if (!c.arcAxis || !first || s.arcLevel === 'none' || first.arcLevel === 'none') return 0;
  return Math.abs(LEVEL_RANK[s.arcLevel] - LEVEL_RANK[first.arcLevel]);
}

/** SLA-809: the source's own change, so the image model is told how far the subject moves, not only which way. */
export function sourceArcLine(c: Pick<ResolvedContract, 'arcAxis' | 'slides' | 'sourceArc'>, s: ContractSlide, role: SlideRole): string {
  const a = c.sourceArc;
  if (!a || a.magnitude === 'none' || !c.arcAxis || s.arcLevel === 'none') return '';
  const what = `SOURCE CHANGE: the source carousel moves its subject along "${a.axis}"${a.levers.length ? ` by changing ${a.levers.join(', ')}` : ''}${a.lowVsHigh ? `; between its two extremes: ${a.lowVsHigh}` : ''} (a ${a.magnitude} change).`;
  if (role === 'anchor-edit') {
    const d = arcDistance(c, s);
    if (d === 0) return '';
    return `${what} This image is ${d === 2 ? 'at the other end of the axis from the attached first image: show at least that whole difference' : 'halfway along the axis from the attached first image: show about half of that difference'}, as clearly as the source does.`;
  }
  return role === 'fresh' ? `${what} This image is the ${ARC_WORDS[s.arcLevel]} point: show the subject in that state at the source's scale.` : '';
}

export function feedbackLine(feedback: string): string {
  return feedback
    ? `USER FEEDBACK on the previous version of this image (highest priority, make the change clearly visible at phone size; keep everything the feedback does not mention): ${feedback}`
    : '';
}

/** `labelRule` is the source-label instruction (render-prompt.labelRenderInstruction); it is passed in because that module cannot be imported from here. */
export function compileSlidePrompt(c: ResolvedContract, index: number, role: SlideRole, referenceUse: ReferenceUse, fix = '', feedback = '', labelRule = '', edit: BaselineEdit = { character: false, scene: true }): string {
  const s = c.slides[index];
  if (!s) throw new RangeError('Slide index is outside the contract.');
  if (c.morph && role !== 'edit') return compileMorphPrompt(c, index, role, referenceUse, fix, feedback);
  const text = textLine(s.overlayText);
  const arc = arcLine(c, s);
  const fixLine = [feedbackLine(feedback), fix ? `FIX FROM QA: ${fix}` : ''].filter(Boolean).join('\n');
  if (role === 'edit') return [
    'Edit the attached image. Keep the photograph itself identical: same person, face, hair, makeup, jewelry, hands, clothing INCLUDING any print or graphic on clothing, objects and background. Do not re-shoot, reframe or restyle.',
    'Remove only caption text that was overlaid on top of the photo (if any). Do not remove text or graphics that belong to the scene (clothing prints, labels, signs).',
    text, fixLine].filter(Boolean).join('\n');
  const source = sourceArcLine(c, s, role);
  const hard = c.hardLocks.map(l => l.text);
  const hardLine = hard.length ? `HARD RULES (they win over the change and the source change above):\n- ${hard.join('\n- ')}` : '';
  // The attached frame is the baseline deck's own slide: only the named axes change, and the caption stays exactly as contracted.
  if (role === 'baseline-edit') {
    const { character, scene } = edit;
    const opener = character
      ? `Edit the attached 9:16 frame. Replace the person with the NEW PERSON below${scene ? ' and change the setting, props and action to the slide scene' : ''}. Keep the medium, lighting, camera, framing and composition${scene ? '' : ', and keep the setting, props and action exactly as they are'}.`
      : 'Edit the attached 9:16 frame. Keep the SAME person, outfit, pose, medium, lighting and camera. Change ONLY the setting and props to the slide scene.';
    return [
      opener, labelRule,
      character ? `NEW PERSON (the face, hair, build and outfit are theirs; nothing of the person in the attached frame stays): ${c.identitySheet}` : '',
      scene ? `SCENE for this image: ${s.scene}` : '', hard.length ? `HARD RULES:\n- ${hard.join('\n- ')}` : '',
      text, fixLine].filter(Boolean).join('\n');
  }
  if (role === 'anchor-edit') return [
    arcDistance(c, s) > 0
      // SLA-809: "keep the same face and build" froze exactly what an arc changes. On an arc only the identity is kept.
      ? `Edit the attached image, which is the first image of this carousel. Show the SAME ${c.subject === 'character' ? 'character at a later point of the story: keep the character recognisable and the art style' : 'person at a different point of the story: keep them recognisable (ethnicity, eye colour, hair colour, age, unless the change below names one)'}, the same outfit, the same medium, the same background and framing unless the scene below says otherwise. The change below alters the ${c.subject === 'character' ? 'character' : 'person\'s face and body'} itself: do not hold shape, proportions, fullness, definition or texture fixed where the change names them.`
      : `Edit the attached image, which is the first image of this carousel. Keep the same ${c.subject === 'character' ? 'character design and art style' : 'person: face, hair, skin, jewelry, build'}, the same outfit, the same medium, the same background and framing unless the scene below says otherwise.`,
    `Change ONLY this: ${s.visibleChange || s.scene}. Make the change clearly visible at phone size.`,
    `SCENE for this image: ${s.scene}`, arc, source,
    // The form's locked constraints bind every slide, the identity chain included (SLA-809).
    arcDistance(c, s) > 0 ? hardLine : '',
    'Remove the attached image\'s caption and any card or overlay it has.',
    text, fixLine].filter(Boolean).join('\n');
  const subject = c.identity === 'invented-consistent' ? `SUBJECT: ${c.identitySheet}`
    : c.identity === 'none' ? 'SUBJECT: only what the scene describes. No faces unless the scene asks for one.' : '';
  return [
    'Create one new 9:16 social carousel image. Do not print slide numbers, page dots or progress labels.',
    referenceUse === 'style-only' ? 'The attached image is a STYLE reference only: copy its drawing technique, line quality, shading and palette. Do NOT copy its layout, grid, subjects, faces or any of its text.' : '',
    `MEDIUM: ${c.medium}.`, subject,
    `SCENE: ${s.scene}`, s.composition ? `COMPOSITION: ${s.composition}` : '', arc, source,
    hard.length ? `HARD RULES:\n- ${hard.join('\n- ')}` : '',
    c.keptSourceDefaults.length ? `PREFERENCES (follow only if they do not conflict with anything above): ${c.keptSourceDefaults.join('; ')}` : '',
    text, fixLine].filter(Boolean).join('\n');
}

/** SLA-867: a morph slide. Slide 1 is created from the identity sheet at its anchor grades; every later slide is an edit of
 *  slide 1 that changes only the graded attributes. The result never carries a valuation word: QA text and feedback are
 *  scrubbed, and anything else that slipped through fails the slide before a provider call is paid for. */
function compileMorphPrompt(c: ResolvedContract, index: number, role: SlideRole, referenceUse: ReferenceUse, fix: string, feedback: string): string {
  const s = c.slides[index]!;
  const anchor = c.slides[0]?.morph ?? [];
  const grades = s.morph ?? anchor;
  const hard = c.hardLocks.map(l => l.text);
  const hardLine = hard.length ? `HARD RULES:\n- ${hard.join('\n- ')}` : '';
  const fixLine = [feedbackLine(redactValuation(feedback)), fix ? `FIX FROM QA: ${redactValuation(fix)}` : ''].filter(Boolean).join('\n');
  const prompt = role === 'anchor-edit'
    ? [
      'Edit the attached image, which is the first image of this carousel.',
      morphBlock(anchor, grades),
      `SCENE for this image: ${s.scene}`, hardLine,
      'Remove the attached image\'s caption and any card or overlay it has.',
      textLine(s.overlayText), fixLine].filter(Boolean).join('\n')
    : [
      'Create one new 9:16 social carousel image. Do not print slide numbers, page dots or progress labels.',
      referenceUse === 'style-only' ? 'The attached image is a STYLE reference only: copy its lighting, backdrop and camera. Do NOT copy its subject, face or any of its text.' : '',
      `MEDIUM: ${c.medium}.`, `SUBJECT: ${c.identitySheet}`,
      grades.length ? `FACE AND BUILD on this image: ${morphAnchorText(grades)}.` : '',
      `SCENE: ${s.scene}`, s.composition ? `COMPOSITION: ${s.composition}` : '', hardLine,
      textLine(s.overlayText), fixLine].filter(Boolean).join('\n');
  const words = valuationWords(prompt);
  if (words.length) throw new ContractError('morph_valuation_words', `The image prompt for slide ${index + 1} would carry valuation words (${words.join(', ')}); they are drawn in code, never rendered.`);
  return prompt;
}

export function captionEditPrompt(from: string, to: string, fix = ''): string {
  return [
    from
      ? `Edit the attached image. Keep everything identical, pixel for pixel, except the caption: replace the caption "${from}" with exactly "${to}" in the same position, size and style. No other text changes.`
      : `Edit the attached image. Keep everything identical, pixel for pixel, except add the caption exactly "${to}", large, bold and legible, inside the safe area. No other text changes.`,
    fix && `FIX FROM QA: ${fix}`].filter(Boolean).join('\n');
}

/** Which kind of render a slide needs. Anchor-edit is the invented-consistent identity chain. */
export function slideRole(c: Pick<ResolvedContract, 'identity' | 'keepSourceImage'>, index: number, pick: FramePick): SlideRole {
  if (pick.referenceUse === 'edit') return 'edit';
  if (index > 0 && c.identity === 'invented-consistent' && !c.keepSourceImage) return 'anchor-edit';
  return 'fresh';
}

// ---- QA: one vision call per arm, compiled from the same contract ---------------

const QA_SLIDE = { index: { type: 'integer' }, textSeen: S, overlayExact: B, sceneMatches: B, settingChanged: B, stateLevel: LEVEL, mediumMatches: B, lockResults: arr(obj({ lock: S, pass: B, note: S })) };
const QA_DECK = obj({ identityConsistent: B, sourceLikeness: B, arcVisibleWithoutText: B, notes: S });
export const QA_JSON_SCHEMA = obj({ slides: arr(obj(QA_SLIDE)), deck: QA_DECK });
/** SLA-867: a morph deck's QA also answers, per slide, whether it is slide 1's person and one check per graded attribute. */
export const MORPH_QA_JSON_SCHEMA = obj({ slides: arr(obj({ ...QA_SLIDE, samePerson: B, morphChecks: arr(obj({ check: S, pass: B, note: S })) })), deck: QA_DECK });
export const qaJsonSchema = (c: Pick<ResolvedContract, 'morph'>) => c.morph ? MORPH_QA_JSON_SCHEMA : QA_JSON_SCHEMA;
export const RawQa = z.object({
  slides: z.array(z.object({ index: z.number().int(), textSeen: z.string(), overlayExact: z.boolean(), sceneMatches: z.boolean(), settingChanged: z.boolean().optional(), stateLevel: Level, mediumMatches: z.boolean(), lockResults: z.array(z.object({ lock: z.string(), pass: z.boolean(), note: z.string() })),
    samePerson: z.boolean().optional(), morphChecks: z.array(z.object({ check: z.string(), pass: z.boolean(), note: z.string() })).optional() })),
  deck: z.object({ identityConsistent: z.boolean(), sourceLikeness: z.boolean(), arcVisibleWithoutText: z.boolean(), notes: z.string() }),
});
export type QaAnswer = z.infer<typeof RawQa>;

export const QA_SYSTEM = 'You are a strict visual QA checker. Judge only what is visible. Return JSON.';

/** `baselineImages`: a scene arm is judged against the baseline deck's slides, appended after the source frames. */
export function compileQaPrompt(c: ResolvedContract, opts: { slideCount: number; sourceImages: number; referenceUse: ReferenceUse; baselineImages?: number }): string {
  const edit = opts.referenceUse === 'edit';
  const hard = c.hardLocks.map(l => l.text);
  const n = opts.slideCount;
  const a = c.sourceArc;
  const scale = c.arcAxis && a && a.magnitude !== 'none' && !c.keepSourceImage
    ? ` Answer false also when the change is clearly smaller than the source's, which is a ${a.magnitude} change${a.lowVsHigh ? ` between its extremes: ${a.lowVsHigh}` : ''}.`
    : '';
  const sources = opts.sourceImages
    ? `Image ${n + 1}${opts.sourceImages > 1 ? `..${n + opts.sourceImages}` : ''} = source reference${edit ? ' frame(s) the slides were edited from, in slide order' : ' (only to judge likeness: the slides must NOT show this person)'}.`
    : '';
  const baselineAt = n + opts.sourceImages + 1;
  const baseline = opts.baselineImages
    ? `Image ${baselineAt}${opts.baselineImages > 1 ? `..${baselineAt + opts.baselineImages - 1}` : ''} = the baseline deck's slides, in slide order: this carousel was edited from them to change ONLY the setting, props and action; the person, medium, lighting, camera and caption were to stay.`
    : '';
  const sceneEdit = !!opts.baselineImages;
  return `Images 1..${n} are the slides of one carousel, in order. ${sources}${baseline ? `${sources ? ' ' : ''}${baseline}` : ''}
Contract: ${JSON.stringify({ medium: c.medium, identity: c.identity, identitySheet: c.identitySheet, arcAxis: c.arcAxis, slides: c.slides.map((s, i) => ({ index: i, overlayText: s.overlayText, arcLevel: s.arcLevel, scene: s.scene })) })}
For every slide: textSeen (all caption text you can read), overlayExact (the caption equals overlayText, ignoring case and punctuation; text inside an app screen is not a caption), sceneMatches (the scene is recognisably what the contract describes${edit ? '; for edited slides the photo is unchanged from its source frame apart from the caption, including clothing prints' : ''}), settingChanged (${sceneEdit ? 'the setting, props and action are clearly different from the matching baseline slide' : 'true; not applicable'}), stateLevel (the visible state on the arc axis judged from the PICTURE ONLY, ignoring captions, labels and app-screen numbers: low, mid, high, or none), mediumMatches, and lockResults for EACH of these locks: ${JSON.stringify(hard)}.
${morphQaLines(c)}deck.identityConsistent: ${sceneEdit ? 'the same person or character as in the baseline slides on every slide (true if the slides show no person)' : c.identity === 'invented-consistent' ? `the same person or character on every slide${c.arcAxis ? ` (changing along "${c.arcAxis}" is expected: they stay the same person while they remain recognisable)` : ''}` : 'true if not applicable'}. deck.arcVisibleWithoutText: ${c.arcAxis ? `cover all text with your hand: does the picture itself clearly progress along "${c.arcAxis}" from the first to the last slide?${scale}` : 'true if not applicable'}. deck.sourceLikeness: ${c.identity.startsWith('invented') ? 'true if any slide shows the source person' : 'false if not applicable'}.`;
}

/** The QA checks one morph slide must answer: one per graded attribute, judged against slide 1. Empty for slide 1 and non-morph decks. */
export function morphQaChecks(c: Pick<ResolvedContract, 'morph' | 'slides'>, index: number): string[] {
  const anchor = c.slides[0]?.morph;
  const s = c.slides[index];
  if (!c.morph || !anchor || !s?.morph || index === 0) return [];
  return morphChecks(anchor, s.morph).map(x => x.check);
}

function morphQaLines(c: ResolvedContract): string {
  if (!c.morph) return '';
  const checks = c.slides.map((_, i) => ({ index: i, checks: morphQaChecks(c, i) })).filter(x => x.checks.length);
  return `This is a morph deck: slide 1 is the reference person and every later slide is meant to be that SAME person with only some visible attributes changed. Do NOT judge attractiveness, rank or rate anyone; judge only whether each listed visible attribute looks as described. For every slide: samePerson (slide 1 itself: true; later slides: the same individual as slide 1, recognisable by ethnicity, eye colour, hair colour, outfit, backdrop and framing, even where the listed attributes differ) and morphChecks: one entry per check listed for that slide below (copy the check text; slide 1 has none, answer []), pass=true only if that change is clearly visible against slide 1 at phone size. Checks: ${JSON.stringify(checks.map(x => ({ slide: x.index + 1, index: x.index, checks: x.checks })))}.
`;
}

export interface QaVerdict {
  /** Hard failures per slide index (or 'deck'). Never downgraded to warnings. */
  failures: Record<string, string[]>;
  warnings: string[];
  passed: boolean;
}

/** Source defaults are never checked. Locks, caption, scene, medium, arc and identity are. */
export function qaVerdict(c: ResolvedContract, q: QaAnswer, opts: { slides?: number[]; sceneEdit?: boolean } = {}): QaVerdict {
  const failures: Record<string, string[]> = {};
  const warnings: string[] = [];
  const add = (k: string | number, m: string) => { (failures[String(k)] ??= []).push(m); };
  const judged = opts.slides ? new Set(opts.slides) : null;
  q.slides.forEach((s, k) => {
    const i = s.index ?? k;
    if (!c.slides[i] || (judged && !judged.has(i))) return;
    if (!s.overlayExact) add(i, `the caption must be exactly "${c.slides[i]!.overlayText}" (seen: "${s.textSeen}")`);
    if (!s.sceneMatches) add(i, 'the scene does not match the contract');
    if (!s.mediumMatches) add(i, `the medium must be ${c.medium}`);
    if (opts.sceneEdit && s.settingChanged !== true) add(i, 'the setting, props and action must differ from the baseline slide');
    for (const l of s.lockResults) if (!l.pass) add(i, `violates "${l.lock}": ${l.note}`);
    if (c.morph && i > 0) {
      if (s.samePerson === false) add(i, 'this is not the same person as slide 1; keep slide 1\'s person and change only the listed attributes');
      const answered = new Map((s.morphChecks ?? []).map(m => [norm(m.check), m] as const));
      for (const check of morphQaChecks(c, i)) {
        const got = answered.get(norm(check));
        if (!got) add(i, `unchecked: ${check}`);
        else if (!got.pass) add(i, `${check}${got.note ? ` (seen: ${got.note})` : ''}`);
      }
    }
    const want = c.slides[i]!.arcLevel;
    if (want !== 'none' && s.stateLevel !== want && !c.keepSourceImage) add(i, `the visible state reads as ${s.stateLevel}, it must read as ${want} on "${c.arcAxis}"`);
  });
  if ((c.identity === 'invented-consistent' || opts.sceneEdit) && !q.deck.identityConsistent) add('deck', `identity drifts between slides: ${q.deck.notes}`);
  if (c.arcAxis && !q.deck.arcVisibleWithoutText) {
    if (c.keepSourceImage) warnings.push(`The source photos do not show the progression "${c.arcAxis}" on their own: ${q.deck.notes}`);
    else add('deck', `the progression "${c.arcAxis}" is not visible in the pictures: ${q.deck.notes}`);
  }
  if (c.identity.startsWith('invented') && q.deck.sourceLikeness) add('deck', `a slide shows the source person: ${q.deck.notes}`);
  return { failures, warnings, passed: Object.keys(failures).length === 0 };
}

/** The slides one repair round re-renders: every failing slide, and when the deck failed (or an invented-consistent
 *  anchor slide was re-rendered) every later slide too, because they are edits of, or must stay consistent with, the earlier ones. */
export function repairSlides(failures: Record<string, string[]>, slideCount: number, opts: { chainFromAnchor?: boolean } = {}): number[] {
  const out = new Set<number>();
  for (const k of Object.keys(failures)) if (k !== 'deck') out.add(Number(k));
  const chain = !!failures.deck || (!!opts.chainFromAnchor && out.has(0));
  if (chain) for (let i = 1; i < slideCount; i++) out.add(i);
  return [...out].filter(i => i >= 0 && i < slideCount).sort((a, b) => a - b);
}

export function fixText(failures: Record<string, string[]>, index: number): string {
  return [...(failures[String(index)] ?? []), ...(failures.deck ?? [])].join(' | ').slice(0, 900);
}

// ---- A/B: the arms differ only in the declared variable, enforced by code -------

export interface ArmBrief {
  character: string; visualStyle: string; caption: string; cta: string;
  /** SLA-867: the arm's morph progression, "" outside a morph deck. */
  morph?: string;
  slides: Array<ContractSlide & { role?: string }>;
}
const slideKey = (s: ContractSlide) => JSON.stringify([s.overlayText, s.arcLevel, s.scene, s.composition, s.visibleChange, ...(s.morph?.length ? [s.morph] : [])]);
/** A slide without its morph grades (and the visibleChange written from them). */
const unmorphed = (s: ContractSlide): ContractSlide => ({ ...s, visibleChange: s.morph?.length ? '' : s.visibleChange, morph: undefined });

/** An alternate is A with exactly the declared variables replaced. A retold storyline goes first, then the scenes, then the hook, so the hook wins on slide 1. */
export function buildAlternate(a: ArmBrief, alt: ContractAlternate): ArmBrief {
  const next: ArmBrief = structuredClone(a);
  const order: ArmField[] = ['concept', 'slides', 'scene'];
  const rank = (v: ArmField) => { const i = order.indexOf(v); return i < 0 ? order.length : i; };
  for (const b of [...alt.axes].sort((x, y) => rank(x.variable) - rank(y.variable))) {
    switch (b.variable) {
      case 'hook': next.slides[0] = { ...next.slides[0]!, overlayText: b.value }; break;
      case 'caption': next.caption = b.value; break;
      case 'cta': next.cta = b.value; break;
      case 'character': next.character = b.value; break;
      case 'visualStyle': next.visualStyle = b.value; break;
      case 'scene': next.slides = next.slides.map((s, i) => ({ ...s, scene: b.slides[i]?.scene || b.value })); break;
      case 'morph':
        next.morph = b.value;
        next.slides = next.slides.map((s, i) => ({ ...s, morph: b.slides[i]?.morph ?? s.morph, visibleChange: b.slides[i]?.visibleChange ?? s.visibleChange })); break;
      case 'concept': case 'slides':
        next.slides = b.slides.map((s, i) => ({ ...s, ...(a.slides[i]?.role ? { role: a.slides[i]!.role } : {}) })); break;
      default: throw new ContractError('contract_variable', `Unsupported variable "${String(b.variable)}".`);
    }
  }
  return next;
}

/** The fields in which two arms differ, in terms of the experiment's variables. */
export function diffArms(a: ArmBrief, b: ArmBrief): ArmField[] {
  const out: ArmField[] = [];
  if (a.character !== b.character) out.push('character');
  if (a.visualStyle !== b.visualStyle) out.push('visualStyle');
  if (a.caption !== b.caption) out.push('caption');
  if (a.cta !== b.cta) out.push('cta');
  const same = a.slides.length === b.slides.length;
  // The morph grades (and the visibleChange written from them) are the morph variable, never a slides diff.
  const morphDiff = same && a.slides.some((s, i) => JSON.stringify(s.morph ?? []) !== JSON.stringify(b.slides[i]!.morph ?? []));
  if ((a.morph ?? '') !== (b.morph ?? '') || morphDiff) out.push('morph');
  // Beyond the hook (slide 1's caption) and the scenes, the slides must be identical for the diff to be named by field.
  const strip = (s: ContractSlide, i: number) => slideKey(unmorphed({ ...s, scene: '', ...(i === 0 ? { overlayText: '' } : {}) }));
  const onlyHookAndScene = same && a.slides.every((s, i) => strip(s, i) === strip(b.slides[i]!, i));
  if (!same || !onlyHookAndScene) { out.push('slides'); return out; }
  if (a.slides.some((s, i) => s.scene !== b.slides[i]!.scene)) out.push('scene');
  if (a.slides[0]!.overlayText !== b.slides[0]!.overlayText) out.push('hook');
  return out;
}

/** An alternate may differ from the baseline only in the variables it declares; a retold storyline (concept, slides) also moves the slides, the scenes and the first caption. */
export function assertArmDiffers(a: ArmBrief, b: ArmBrief, declared: readonly ArmField[]): void {
  const retells = declared.includes('concept') || declared.includes('slides');
  const extra = diffArms(a, b).filter(f => !declared.includes(f) && !(retells && (f === 'slides' || f === 'scene' || f === 'hook')));
  if (extra.length) throw new ContractError('arms_differ', `An alternate differs from arm A in ${extra.join(', ')}; only ${declared.map(d => `"${d}"`).join(', ')} may differ.`);
}

export type SlideWork = 'render' | 'caption-edit' | 'baseline-edit' | 'reuse';
/** What a baseline-edit changes on one slide; the prompt names exactly these. */
export interface BaselineEdit { character: boolean; scene: boolean }
/** What alternate `b` changes on slide `i` relative to baseline `a`, among the axes a baseline edit can carry. */
export function baselineEdit(a: ArmBrief, b: ArmBrief, i: number): BaselineEdit {
  return { character: a.character !== b.character, scene: a.slides[i]?.scene !== b.slides[i]?.scene };
}
/** What alternate `b` has to do for slide `i`, given baseline `a`. Deck-level changes touch every slide.
 *  `editFirst`: the alternate changes the person or the scene with the storyline locked, so a slide that differs only in
 *  those (and its caption) edits the baseline's picture; in any other test it is re-rendered. */
export function slideWork(a: ArmBrief, b: ArmBrief, i: number, editFirst = false): SlideWork {
  if (a.visualStyle !== b.visualStyle) return 'render';
  const sa = a.slides[i], sb = b.slides[i];
  if (!sa || !sb) return 'render';
  if (a.character === b.character) {
    if (slideKey(sa) === slideKey(sb)) return 'reuse';
    if (slideKey({ ...sa, overlayText: '' }) === slideKey({ ...sb, overlayText: '' })) return 'caption-edit';
  }
  return editFirst && slideKey({ ...sa, scene: '', overlayText: '' }) === slideKey({ ...sb, scene: '', overlayText: '' }) ? 'baseline-edit' : 'render';
}
