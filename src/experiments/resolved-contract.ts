// SLA-700: the resolved slide contract. One format-agnostic document that follows
// the user's direction: user direction > workspace locks > source defaults.
// The renderer and QA both read it; nothing here knows which source format it is.
// Pure module: no I/O, no provider calls, so every rule below is unit-testable.
import { z } from 'zod/v4';

export const ARC_LEVELS = ['low', 'mid', 'high', 'none'] as const;
export type ArcLevel = (typeof ARC_LEVELS)[number];
export const IDENTITIES = ['none', 'source', 'invented-consistent', 'invented-per-slide'] as const;
export type Identity = (typeof IDENTITIES)[number];
export const SUBJECTS = ['none', 'objects', 'person', 'character', 'product-ui', 'mixed'] as const;
export type Subject = (typeof SUBJECTS)[number];
export type ReferenceUse = 'edit' | 'style-only' | 'none';
export type LockOrigin = 'user' | 'workspace';

export interface TaggedLock { text: string; origin: LockOrigin }
export interface ContractSlide { overlayText: string; arcLevel: ArcLevel; scene: string; composition: string; visibleChange: string }
export interface SourceFrameInfo { index: number; level: ArcLevel; showsPerson: boolean }
export interface VariantB { variable: string; value: string; slides: ContractSlide[] }
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
  hardLocks: TaggedLock[];
  keptSourceDefaults: string[];
  droppedSourceDefaults: Array<{ default: string; reason: string }>;
  droppedLocks: Array<{ lock: string; origin: LockOrigin; reason: string }>;
  slides: ContractSlide[];
  /** Derived from slides[0].overlayText; never an independent field. */
  hook: string;
  variantB: VariantB;
  /** Plain-language corrections code made to the model's answer. */
  issues: string[];
}

export interface ContractInput {
  direction: string;
  locks: TaggedLock[];
  sourceDefaults: string[];
  slideCount: number;
  frameCount: number;
  /** The one variable arm B changes. */
  variable: string;
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
const RawSlide = z.object({ overlayText: z.string(), arcLevel: Level, scene: z.string(), composition: z.string(), visibleChange: z.string() });
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
  slides: z.array(RawSlide),
  variantB: z.object({ variable: z.string(), value: z.string(), slides: z.array(RawSlide) }),
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
  slides: arr(SLIDE_JSON),
  variantB: obj({ variable: S, value: S, slides: arr(SLIDE_JSON) }),
});

export const CONTRACT_SYSTEM = 'You turn a user\'s creative direction into a format-agnostic slide contract for a 9:16 social carousel. '
  + 'Precedence: user direction and origin=user locks > origin=workspace locks > source defaults. '
  + 'A source default that conflicts with the direction or with any lock is DROPPED: list it in droppedSourceDefaults with the reason, copying its text exactly. '
  + 'A workspace lock is dropped ONLY if the user\'s direction explicitly contradicts it (for example the user keeps a real source person against a "no real people" lock); otherwise it stays. Never drop an origin=user lock. '
  + 'Never copy the source\'s overlay text unless the direction asks for it; the direction\'s exact wording for on-image text wins. Return JSON only.';

export function contractFieldGuide(input: ContractInput): Record<string, string> {
  return {
    subject: 'what the slides show',
    identity: 'none | source (the source subject is kept) | invented-consistent (one invented person or character on every slide) | invented-per-slide',
    identitySheet: 'if invented-consistent: a precise visual description reused verbatim on every slide (face, body, hair, outfit, art style). Otherwise "".',
    medium: 'the resolved medium plus style words for every slide',
    keepSourceImage: 'true ONLY if the direction says to keep the source images and change only the text',
    borrowSourceLook: 'true if the direction keeps the source medium or drawing style while changing the content',
    arcAxis: 'the story axis in a few words ONLY if the direction states a progression (before/after, low to high, week 1 to week 4); otherwise ""',
    'slides[].arcLevel': 'position on the arc axis (low, mid or high); none for every slide when arcAxis is ""',
    'slides[].overlayText': 'the exact on-image text for that slide ("" for none). The first slide\'s text is the hook.',
    'slides[].scene': 'what is in the image, concrete, from the direction. On an arc the LOW slide must show the low state unmistakably, described with the same landmarks as the HIGH slide.',
    'slides[].composition': 'layout and framing',
    'slides[].visibleChange': 'for slides after the first: the concrete physical difference from the FIRST slide (the image model only sees the first image), written as visible landmarks and proportions, not percentages (for example "X now as wide as Y", "Z clearly visible"), big enough to read at phone size. The composition of every slide must keep the feature that changes fully visible, nothing covering it. "" for the first slide or when nothing changes.',
    sourceFrameLevels: 'rank EVERY attached source frame (index from 0) on YOUR arcAxis (low/mid/high, none if it does not show the axis) by looking at the images, and set showsPerson=true if a person or character is visible in it',
    variantB: `arm B differs from arm A ONLY in the variable "${input.variable}". Return variable="${input.variable}". value: for hook, a different first-slide overlay text that tests a different hook while keeping the same story; for caption or cta, the alternative text; for character, an alternative identitySheet; for visualStyle, an alternative medium; for concept or slides, "" and give the alternative storyline in variantB.slides (${input.slideCount} slides). In every other case variantB.slides is [].`,
  };
}

export function contractPromptPayload(input: ContractInput, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra, direction: input.direction, locks: input.locks.map(l => ({ lock: l.text, origin: l.origin })),
    sourceDefaults: input.sourceDefaults, slideCount: input.slideCount, sourceFrameCount: input.frameCount,
    fieldGuide: contractFieldGuide(input),
  });
}

// ---- normalization: precedence and invariants live in code ---------------------

const cleanSlide = (s: ContractSlide, arcOn: boolean): ContractSlide => ({
  overlayText: s.overlayText.trim(), arcLevel: arcOn ? s.arcLevel : 'none',
  scene: s.scene.trim(), composition: s.composition.trim(), visibleChange: s.visibleChange.trim(),
});

export function normalizeContract(rawIn: unknown, input: ContractInput): ResolvedContract {
  const parsed = RawContract.safeParse(rawIn);
  if (!parsed.success) throw new ContractError('contract_invalid', 'The slide contract did not match its schema.');
  const raw = parsed.data;
  const issues: string[] = [];
  if (raw.slides.length < input.slideCount) throw new ContractError('contract_slide_count', `The contract has ${raw.slides.length} slides; ${input.slideCount} were requested.`);
  const arcAxis = raw.arcAxis.trim();
  const arcOn = arcAxis !== '';
  const slides = raw.slides.slice(0, input.slideCount).map(s => cleanSlide(s, arcOn));
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

  let identity = raw.identity;
  if (raw.keepSourceImage && identity !== 'source' && identity !== 'none') {
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

  const variantB = normalizeVariantB(raw.variantB, input, arcOn);
  return {
    version: 1, subject: raw.subject, identity, identitySheet, medium: raw.medium.trim(),
    keepSourceImage: raw.keepSourceImage, borrowSourceLook: raw.borrowSourceLook && !raw.keepSourceImage, arcAxis,
    sourceFrames: [...frames.values()].sort((a, b) => a.index - b.index),
    hardLocks, keptSourceDefaults, droppedSourceDefaults, droppedLocks,
    slides, hook: slides[0]!.overlayText, variantB, issues,
  };
}

function normalizeVariantB(b: RawContractT['variantB'], input: ContractInput, arcOn: boolean): VariantB {
  const variable = input.variable;
  const value = b.value.trim();
  const slides = b.slides.slice(0, input.slideCount).map(s => cleanSlide(s, arcOn));
  if ((variable === 'concept' || variable === 'slides')) {
    if (slides.length < input.slideCount) throw new ContractError('contract_variant_missing', `Arm B needs an alternative storyline of ${input.slideCount} slides.`);
  } else if (!value) throw new ContractError('contract_variant_missing', `Arm B needs a value for "${variable}".`);
  return { variable, value, slides: variable === 'concept' || variable === 'slides' ? slides : [] };
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

export type SlideRole = 'edit' | 'anchor-edit' | 'fresh';
const ARC_WORDS: Record<Exclude<ArcLevel, 'none'>, string> = { low: 'LOW (worst / earliest)', mid: 'MIDDLE', high: 'HIGH (best / latest)' };

export function textLine(overlayText: string): string {
  return overlayText
    ? `TEXT: render exactly "${overlayText}" once, large, bold and legible, inside the safe area. It is the only caption. Text that is part of an app screen described in the scene is allowed; no other words, logos or watermarks.`
    : 'TEXT: no caption, no words.';
}

export function arcLine(c: Pick<ResolvedContract, 'arcAxis'>, s: ContractSlide): string {
  return c.arcAxis && s.arcLevel !== 'none'
    ? `STORY POSITION: on the axis "${c.arcAxis}" this image is the ${ARC_WORDS[s.arcLevel]} point; the picture itself must visibly show that state.`
    : '';
}

export function compileSlidePrompt(c: ResolvedContract, index: number, role: SlideRole, referenceUse: ReferenceUse, fix = ''): string {
  const s = c.slides[index];
  if (!s) throw new RangeError('Slide index is outside the contract.');
  const text = textLine(s.overlayText);
  const arc = arcLine(c, s);
  const fixLine = fix ? `FIX FROM QA: ${fix}` : '';
  if (role === 'edit') return [
    'Edit the attached image. Keep the photograph itself identical: same person, face, hair, makeup, jewelry, hands, clothing INCLUDING any print or graphic on clothing, objects and background. Do not re-shoot, reframe or restyle.',
    'Remove only caption text that was overlaid on top of the photo (if any). Do not remove text or graphics that belong to the scene (clothing prints, labels, signs).',
    text, fixLine].filter(Boolean).join('\n');
  if (role === 'anchor-edit') return [
    `Edit the attached image, which is the first image of this carousel. Keep the same ${c.subject === 'character' ? 'character design and art style' : 'person: face, hair, skin, jewelry, build'}, the same outfit, the same medium, the same background and framing unless the scene below says otherwise.`,
    `Change ONLY this: ${s.visibleChange || s.scene}. Make the change clearly visible at phone size.`,
    `SCENE for this image: ${s.scene}`, arc,
    'Remove the attached image\'s caption and any card or overlay it has.',
    text, fixLine].filter(Boolean).join('\n');
  const subject = c.identity === 'invented-consistent' ? `SUBJECT: ${c.identitySheet}`
    : c.identity === 'none' ? 'SUBJECT: only what the scene describes. No faces unless the scene asks for one.' : '';
  const hard = c.hardLocks.map(l => l.text);
  return [
    'Create one new 9:16 social carousel image. Do not print slide numbers, page dots or progress labels.',
    referenceUse === 'style-only' ? 'The attached image is a STYLE reference only: copy its drawing technique, line quality, shading and palette. Do NOT copy its layout, grid, subjects, faces or any of its text.' : '',
    `MEDIUM: ${c.medium}.`, subject,
    `SCENE: ${s.scene}`, s.composition ? `COMPOSITION: ${s.composition}` : '', arc,
    hard.length ? `HARD RULES:\n- ${hard.join('\n- ')}` : '',
    c.keptSourceDefaults.length ? `PREFERENCES (follow only if they do not conflict with anything above): ${c.keptSourceDefaults.join('; ')}` : '',
    text, fixLine].filter(Boolean).join('\n');
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

export const QA_JSON_SCHEMA = obj({
  slides: arr(obj({ index: { type: 'integer' }, textSeen: S, overlayExact: B, sceneMatches: B, stateLevel: LEVEL, mediumMatches: B, lockResults: arr(obj({ lock: S, pass: B, note: S })) })),
  deck: obj({ identityConsistent: B, sourceLikeness: B, arcVisibleWithoutText: B, notes: S }),
});
export const RawQa = z.object({
  slides: z.array(z.object({ index: z.number().int(), textSeen: z.string(), overlayExact: z.boolean(), sceneMatches: z.boolean(), stateLevel: Level, mediumMatches: z.boolean(), lockResults: z.array(z.object({ lock: z.string(), pass: z.boolean(), note: z.string() })) })),
  deck: z.object({ identityConsistent: z.boolean(), sourceLikeness: z.boolean(), arcVisibleWithoutText: z.boolean(), notes: z.string() }),
});
export type QaAnswer = z.infer<typeof RawQa>;

export const QA_SYSTEM = 'You are a strict visual QA checker. Judge only what is visible. Return JSON.';

export function compileQaPrompt(c: ResolvedContract, opts: { slideCount: number; sourceImages: number; referenceUse: ReferenceUse }): string {
  const edit = opts.referenceUse === 'edit';
  const hard = c.hardLocks.map(l => l.text);
  const n = opts.slideCount;
  const sources = opts.sourceImages
    ? `Image ${n + 1}${opts.sourceImages > 1 ? `..${n + opts.sourceImages}` : ''} = source reference${edit ? ' frame(s) the slides were edited from, in slide order' : ' (only to judge likeness: the slides must NOT show this person)'}.`
    : '';
  return `Images 1..${n} are the slides of one carousel, in order. ${sources}
Contract: ${JSON.stringify({ medium: c.medium, identity: c.identity, identitySheet: c.identitySheet, arcAxis: c.arcAxis, slides: c.slides.map((s, i) => ({ index: i, overlayText: s.overlayText, arcLevel: s.arcLevel, scene: s.scene })) })}
For every slide: textSeen (all caption text you can read), overlayExact (the caption equals overlayText, ignoring case and punctuation; text inside an app screen is not a caption), sceneMatches (the scene is recognisably what the contract describes${edit ? '; for edited slides the photo is unchanged from its source frame apart from the caption, including clothing prints' : ''}), stateLevel (the visible state on the arc axis judged from the PICTURE ONLY, ignoring captions, labels and app-screen numbers: low, mid, high, or none), mediumMatches, and lockResults for EACH of these locks: ${JSON.stringify(hard)}.
deck.identityConsistent: ${c.identity === 'invented-consistent' ? 'the same person or character on every slide' : 'true if not applicable'}. deck.arcVisibleWithoutText: ${c.arcAxis ? `cover all text with your hand: does the picture itself clearly progress along "${c.arcAxis}" from the first to the last slide?` : 'true if not applicable'}. deck.sourceLikeness: ${c.identity.startsWith('invented') ? 'true if any slide shows the source person' : 'false if not applicable'}.`;
}

export interface QaVerdict {
  /** Hard failures per slide index (or 'deck'). Never downgraded to warnings. */
  failures: Record<string, string[]>;
  warnings: string[];
  passed: boolean;
}

/** Source defaults are never checked. Locks, caption, scene, medium, arc and identity are. */
export function qaVerdict(c: ResolvedContract, q: QaAnswer, opts: { slides?: number[] } = {}): QaVerdict {
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
    for (const l of s.lockResults) if (!l.pass) add(i, `violates "${l.lock}": ${l.note}`);
    const want = c.slides[i]!.arcLevel;
    if (want !== 'none' && s.stateLevel !== want && !c.keepSourceImage) add(i, `the visible state reads as ${s.stateLevel}, it must read as ${want} on "${c.arcAxis}"`);
  });
  if (c.identity === 'invented-consistent' && !q.deck.identityConsistent) add('deck', `identity drifts between slides: ${q.deck.notes}`);
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
  slides: Array<ContractSlide & { role?: string }>;
}
export type ArmField = 'hook' | 'character' | 'visualStyle' | 'caption' | 'cta' | 'concept' | 'slides';
const slideKey = (s: ContractSlide) => JSON.stringify([s.overlayText, s.arcLevel, s.scene, s.composition, s.visibleChange]);

/** Arm B is A with exactly the declared variable replaced. */
export function buildArmB(a: ArmBrief, b: VariantB): ArmBrief {
  const next: ArmBrief = structuredClone(a);
  switch (b.variable) {
    case 'hook': next.slides[0] = { ...next.slides[0]!, overlayText: b.value }; break;
    case 'caption': next.caption = b.value; break;
    case 'cta': next.cta = b.value; break;
    case 'character': next.character = b.value; break;
    case 'visualStyle': next.visualStyle = b.value; break;
    case 'concept': case 'slides':
      next.slides = b.slides.map((s, i) => ({ ...s, role: a.slides[i]?.role ?? s.role })); break;
    default: throw new ContractError('contract_variable', `Unsupported variable "${b.variable}".`);
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
  const onlyHook = same && a.slides.every((s, i) => i === 0 ? slideKey({ ...s, overlayText: '' }) === slideKey({ ...b.slides[0]!, overlayText: '' }) : slideKey(s) === slideKey(b.slides[i]!));
  if (!same || !onlyHook) out.push('slides');
  else if (a.slides[0]!.overlayText !== b.slides[0]!.overlayText) out.push('hook');
  return out;
}

export function assertArmsDifferOnly(a: ArmBrief, b: ArmBrief, variable: ArmField): void {
  const extra = diffArms(a, b).filter(f => f !== variable && !(variable === 'concept' && f === 'slides'));
  if (extra.length) throw new ContractError('arms_differ', `Arm B differs from arm A in ${extra.join(', ')}; only "${variable}" may differ.`);
}

export type SlideWork = 'render' | 'caption-edit' | 'reuse';
/** What arm B has to do for slide `i`, given arm A. Deck-level changes touch every slide. */
export function slideWork(a: ArmBrief, b: ArmBrief, i: number): SlideWork {
  if (a.character !== b.character || a.visualStyle !== b.visualStyle) return 'render';
  const sa = a.slides[i], sb = b.slides[i];
  if (!sa || !sb) return 'render';
  if (slideKey(sa) === slideKey(sb)) return 'reuse';
  return slideKey({ ...sa, overlayText: '' }) === slideKey({ ...sb, overlayText: '' }) ? 'caption-edit' : 'render';
}
