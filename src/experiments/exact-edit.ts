import { createHash } from 'node:crypto';
import {
  ExperimentError,
  EXACT_EDIT_OPERATION,
  EXACT_EDIT_VARIANT_COUNT,
  EXACT_EDIT_VERSION,
  ExactEditRequest,
  type ExactEditContract,
  type ExactEditRequestData,
  type ExactEditSlideContract,
} from './schema.js';

/**
 * SLA-451 `exact_edit`: one requested deck, one variant, source-preserving.
 *
 * This module owns the immutable deck contract and the two operations that make
 * preservation checkable: deterministic bounded compositing and the asset-reuse
 * comparison. It deliberately contains NO provider dispatch and NO selector call
 * — ranking alternatives is exactly what this operation does not do.
 *
 * Every stage (effective brief, compositor, QA) binds to one `contractHash`, so a
 * checker can never be handed a contract that a render request quietly replaced.
 */

function fail(code: string, message: string): never {
  throw new ExperimentError(422, code, message);
}

/** Deterministic canonical JSON: sorted keys, no undefined, stable arrays. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** Included output slides, ascending. Order comes from the request, never inferred. */
function includedOutputs(req: ExactEditRequestData) {
  return req.inclusions.filter(i => i.included).sort((a, b) => a.outputIndex - b.outputIndex);
}

/**
 * Resolve the ONE authoritative overlay for one output slide.
 *
 * Precedence is fixed and exact: an explicit override wins, including `""` (which
 * clears); an omitted override retains the resolved source copy. An `unresolved`
 * source state is an evidence gap and fails preparation — it never resolves to
 * empty, a caption, a default payoff, a prompt example or another slide's copy.
 */
export function resolveExactOverlay(
  req: ExactEditRequestData,
  outputIndex: number,
): { text: string; origin: 'source' | 'override'; mode: 'preserve' | 'replace' | 'clear' } {
  const key = String(outputIndex);
  const overrides = req.overlayOverrides ?? {};
  // Property presence decides, never truthiness: "" is a value, absence is not.
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    const value = overrides[key]!;
    return { text: value, origin: 'override', mode: value === '' ? 'clear' : 'replace' };
  }
  const copy = req.sourceCopy[key];
  if (!copy) fail('missing_source_copy', `No recorded source copy for output slide ${outputIndex}.`);
  if (copy.state === 'unresolved') {
    fail('unknown_source_copy', `Source copy for output slide ${outputIndex} is unresolved and no explicit override resolves it.`);
  }
  return { text: copy.text, origin: 'source', mode: copy.text === '' ? 'clear' : 'preserve' };
}

/**
 * Every required check for one output slide, derived from the contract itself so
 * a checker is never omitted a lock and never asked about a superseded field.
 */
export function exactEditChecks(contract: ExactEditContract, outputIndex: number): string[] {
  const slide = contract.slides.find(s => s.outputIndex === outputIndex);
  if (!slide) fail('invalid_slide_mapping', `Output slide ${outputIndex} is not in the contract.`);
  const checks: string[] = [
    `the on-image overlay matches exactly: ${JSON.stringify(slide.effectiveOverlayText)}`,
    `the frame comes from the original source slide ${slide.sourceIndex} at its pinned asset reference`,
    'aspect ratio, crop, panel arrangement, camera and medium are unchanged from the source',
    'slide order and narrative beats are unchanged from the source',
  ];
  if (slide.reuseOriginal) checks.push('the output bytes are identical to the pinned original asset');
  if (slide.character) {
    for (const r of slide.character.retained) checks.push(`the subject's ${r} is unchanged from the original reference`);
    if (slide.character.visibleTarget) checks.push(`the subject's requested visible target is present: ${slide.character.visibleTarget}`);
    if (slide.character.narrativeContrast) checks.push(`the source narrative contrast is preserved: ${slide.character.narrativeContrast}`);
    // A character change must not homogenize the sequence.
    checks.push("this slide's subject is not another subject's face");
  }
  for (const label of contract.labels.allowed) checks.push(`the source label "${label}" is still present, in its original position`);
  for (const label of contract.labels.removals) checks.push(`the mark "${label}" is not present anywhere on the slide`);
  if (contract.ending.choice === 'retain') {
    checks.push(`the source ending at index ${contract.ending.sourceIndices.join(', ')} is retained verbatim`);
    if (contract.ending.appCardException) checks.push('the retained source app card is preserved as supplied, with no invented UI or claims');
  }
  if (contract.ending.choice === 'replace') {
    checks.push(`the ending copy is exactly ${JSON.stringify(contract.ending.replacement.text)} at output slide ${contract.ending.replacement.outputIndex}`);
    checks.push('no app feature, claim or branding was invented in the ending');
  }
  if (contract.ending.choice === 'exclude') checks.push(`no content from source index ${contract.ending.sourceIndices.join(', ')} appears`);
  if (contract.openerEdit) {
    const g = contract.openerEdit.geometry;
    checks.push('every pixel outside the approved overlay mask is identical to the original frame');
    checks.push(`the approved opener region ${g.width}x${g.height} at (${g.x},${g.y}) is the only area that changed`);
  }
  return checks;
}

/**
 * Compile the immutable contract. Fails closed BEFORE any service call on:
 * unknown source copy, ambiguous casting, conflicting labels, a missing ending, a
 * missing or non-original original frame, or a hook mirror that contradicts the
 * resolved slide-zero overlay.
 */
export function compileExactEdit(raw: unknown): ExactEditContract {
  const parsed = ExactEditRequest.safeParse(raw);
  if (!parsed.success) {
    // Surface a precise preparation code rather than a generic 400.
    const issue = parsed.error.issues[0];
    fail('invalid_exact_edit_request', issue?.message ?? 'Invalid exact_edit request.');
  }
  const req = parsed.data;
  const included = includedOutputs(req);
  if (!included.length) fail('empty_inclusion_map', 'An exact_edit deck must include at least one output slide.');

  // Source revision must be truthful: known needs a value, unknown needs null.
  if (req.source.revisionState === 'unknown' && req.source.revision !== null)
    fail('invented_source_revision', 'Source revision is marked unknown; a revision value would be invented.');
  if (req.source.revisionState === 'known' && !req.source.revision)
    fail('missing_source_revision', 'Source revision is marked known but no revision was supplied.');

  // A missing ending choice is a preparation failure, never an implicit default.
  if (!req.ending) fail('missing_ending_choice', 'An explicit ending choice is required before preparation.');

  // Lock/unlock contradictions.
  const unlocked = new Set<string>(req.locks.unlocked);
  const contradiction = req.locks.locked.filter(l => unlocked.has(l));
  if (contradiction.length) fail('conflicting_locks', `Properties cannot be locked and unlocked at once: ${contradiction.join(', ')}.`);

  // Label rules that contradict each other.
  if (req.labels) {
    const clash = req.labels.allowed.filter(l => req.labels!.removals.includes(l));
    if (clash.length) fail('conflicting_label_policy', `Label rules conflict for: ${clash.join(', ')}.`);
  }

  const overlayOverrides = { ...(req.overlayOverrides ?? {}) };
  const slides: ExactEditSlideContract[] = included.map(inc => {
    const overlay = resolveExactOverlay(req, inc.outputIndex);
    const frame = req.originals.find(o => o.sourceIndex === inc.sourceIndex);
    if (!frame) fail('missing_original_frame', `No original asset for included source slide ${inc.sourceIndex}.`);
    // A generated baseline or recreated frame can never masquerade as an original.
    if (!frame.original) fail('non_original_frame', `Source slide ${inc.sourceIndex} has no ORIGINAL frame; a generated or recreated frame cannot stand in.`);

    const character = req.characters.find(c => c.outputIndex === inc.outputIndex) ?? null;
    if (character) {
      if (!character.visibleTarget && !character.approvedReferenceRef)
        fail('unresolved_casting_target', `Character target for slide ${inc.outputIndex} states no concrete visible target or approved reference.`);
      if (character.visibleTarget && character.approvedReferenceRef)
        fail('ambiguous_casting_target', `Character target for slide ${inc.outputIndex} carries both a visible target and a reference; state one.`);
      if (character.visibleTarget) {
        const why = unresolvedTargetReason(character.visibleTarget);
        if (why) fail('unresolved_casting_target', `Character target for slide ${inc.outputIndex} states ${why}, which is not a visible attribute.`);
      }
      // Role and layout are structural: a character change may not re-role or re-layout a slide.
      for (const required of ['role', 'layout'] as const) {
        if (!character.retained.includes(required))
          fail('character_lock_violation', `A character change must retain ${required} on slide ${inc.outputIndex}.`);
      }
      // Gaze is never unlocked by a hair/eyes/complexion target.
      if (!character.retained.includes('gaze'))
        fail('character_lock_violation', `A character change must retain gaze on slide ${inc.outputIndex}; a hair, eye or complexion target does not unlock it.`);
    }

    // Reuse: every unchanged included slide reuses its original asset directly.
    // The single exception is an approved bounded opener edit.
    const reuseOriginal = !(req.openerEdit && req.openerEdit.outputIndex === inc.outputIndex);
    return {
      outputIndex: inc.outputIndex,
      sourceIndex: inc.sourceIndex,
      included: true,
      reason: inc.reason,
      effectiveOverlayText: overlay.text,
      overlayOrigin: overlay.origin,
      overlayMode: overlay.mode,
      original: { assetRef: frame.assetRef, encodedSha256: frame.encodedSha256, dimensions: frame.dimensions, original: true },
      reuseOriginal,
      character: character
        ? {
            subjectId: character.subjectId,
            visibleTarget: character.visibleTarget,
            approvedReferenceRef: character.approvedReferenceRef,
            retained: [...character.retained],
            narrativeContrast: character.narrativeContrast,
          }
        : null,
    };
  });

  // Slide zero must exist, and the hook mirror must agree with it — blank included.
  const first = slides.find(s => s.outputIndex === 0);
  if (!first) fail('missing_slide_zero', 'An exact_edit deck must map an output slide 0.');
  const briefHook = first.effectiveOverlayText;
  if (req.hookMirror !== undefined && req.hookMirror !== briefHook)
    fail('hook_overlay_conflict', `brief.hook (${JSON.stringify(req.hookMirror)}) contradicts the resolved slide-0 overlay (${JSON.stringify(briefHook)}).`);

  if (req.openerEdit) {
    const target = slides.find(s => s.outputIndex === req.openerEdit!.outputIndex);
    if (!target) fail('invalid_slide_mapping', 'The approved opener edit names an unmapped output slide.');
    // Without a genuinely clean base/layer, bounded compositing is not attempted:
    // the scope must be revised rather than the frame regenerated.
    if (!req.openerEdit.mask.clean || !req.openerEdit.mask.cleanBaseRef)
      fail('unsupported_compositing', 'The opener edit needs an approved clean base/layer; bounded compositing cannot proceed without one and the frame must not be regenerated.');
    if (target.overlayOrigin !== 'override')
      fail('missing_opener_override', 'An opener composite requires an explicit slide-0 overlay override.');
  }

  const base = {
    operation: EXACT_EDIT_OPERATION as typeof EXACT_EDIT_OPERATION,
    contractVersion: EXACT_EDIT_VERSION as typeof EXACT_EDIT_VERSION,
    variantCount: EXACT_EDIT_VARIANT_COUNT as 1,
    source: {
      videoId: req.source.videoId,
      revision: req.source.revision,
      revisionState: req.source.revisionState,
      provenance: req.source.provenance,
    },
    slides,
    briefHook,
    locks: { locked: [...req.locks.locked], unlocked: [...req.locks.unlocked] },
    labels: { allowed: [...(req.labels?.allowed ?? [])], removals: [...(req.labels?.removals ?? [])] },
    ending: req.ending,
    openerEdit: req.openerEdit ?? null,
    overlayOverrides,
  };
  const canonicalSha256 = sha256(base);
  const contractHash = createHash('sha256').update(canonicalSha256).digest('hex').slice(0, 32);
  return {
    ...base,
    canonicalSha256,
    contractHash,
    contractId: `${EXACT_EDIT_OPERATION}:v${EXACT_EDIT_VERSION}:${canonicalSha256.slice(0, 16)}`,
  };
}

/**
 * Visible casting attributes a target may name. An undefined attractiveness
 * score, a celebrity/similarity claim, or a national/ethnic label carrying no
 * visible attribute is unresolved: it does not authorize an inferred appearance.
 */
const VISIBLE_ATTRIBUTE = /\b(?:hair|hairstyle|eyes?|eye\s?colou?rs?|complexion|freckles?|skin|beards?|mustaches?|moustache|stubble|facial\s+hair|goatees?|curls?|waves?|coily|ponytail|updo|buns?|bangs?|undercut|fade|buzz\w*|bald|short|long|straight|wavy|curly|colou?red|dark|light|brown|blonde|blond|ginger|red|auburn|greys?|gr[ae]y|silver|golden|hazel|green|blue|amber|fair|pale|tanned|olive|deep)\b/i;
/** Phrases that are not visible attributes on their own, however specific. */
const NON_VISIBLE_ONLY = [
  /\b\d+(?:\.\d+)?\s*(?:psl|rating|score|tier|\/\s*\d+|out of)\b/i,
  /\d+\.\d+/,
  /\b(?:celebrity|famous|star-?studded|resembles?|like a celebrity|similar|peer)\b/i,
  /\b(?:european|nordic|scandinavian|mediterranean|latino|latina|asian|african|arab|middle-eastern|eastern-european|beautiful|attractive|good-looking|stunning)\b/i,
];

/** Returns a short reason when the target names no visible attribute, else null. */
export function unresolvedTargetReason(target: string): string | null {
  const text = String(target ?? '').trim();
  if (!text) return 'nothing';
  // A visible attribute anywhere in the target makes it concrete enough.
  if (VISIBLE_ATTRIBUTE.test(text)) return null;
  if (NON_VISIBLE_ONLY.some(re => re.test(text))) return `the unresolved target "${text.slice(0, 80)}"`;
  return null;
}

/** Recompute the hash from a stored contract. A mismatch means the contract was
 *  mutated after preparation, which invalidates every downstream artifact. */
export function assertExactEditContractIntact(contract: ExactEditContract): ExactEditContract {
  const { canonicalSha256, contractHash, contractId, ...rest } = contract;
  const next = sha256(rest);
  if (next !== canonicalSha256) {
    fail('exact_edit_contract_mutated', 'The exact_edit contract no longer matches its canonical hash; preparation must be redone.');
  }
  const nextHash = createHash('sha256').update(next).digest('hex').slice(0, 32);
  const nextId = `${EXACT_EDIT_OPERATION}:v${EXACT_EDIT_VERSION}:${next.slice(0, 16)}`;
  if (nextHash !== contractHash || nextId !== contractId) {
    fail('exact_edit_contract_mutated', 'The exact_edit contract hash or id does not match its content; preparation must be redone.');
  }
  return contract;
}

/** The effective brief for the render and QA stages: the same authoritative
 *  overlay per slide, the same contract hash, no planner-authored copy. */
export function exactEditBrief(contract: ExactEditContract): {
  contractId: string;
  contractHash: string;
  hook: string;
  variantCount: number;
  slides: Array<{ index: number; sourceIndex: number; overlayText: string; overlayMode: string; overlayOrigin: string; reuseOriginal: boolean }>;
} {
  assertExactEditContractIntact(contract);
  return {
    contractId: contract.contractId,
    contractHash: contract.contractHash,
    hook: contract.briefHook,
    variantCount: contract.variantCount,
    slides: contract.slides.map(s => ({
      index: s.outputIndex,
      sourceIndex: s.sourceIndex,
      overlayText: s.effectiveOverlayText,
      overlayMode: s.overlayMode,
      overlayOrigin: s.overlayOrigin,
      reuseOriginal: s.reuseOriginal,
    })),
  };
}

/* ------------------------------------------------------------------------- *
 * Deterministic bounded compositing and asset-reuse comparison.
 *
 * Both work on decoded RGBA pixels so the comparison is exact and transport
 * encoding is irrelevant: different encoded hashes alone prove nothing.
 * ---------------------------------------------------------------------- */
export type Rgba = { width: number; height: number; data: Uint8Array };

function assertSameDimensions(a: Rgba, b: Rgba, what = 'frames'): void {
  if (a.width !== b.width || a.height !== b.height) {
    fail('dimension_mismatch', `${what} differ in size: ${a.width}x${a.height} vs ${b.width}x${b.height}.`);
  }
  if (a.data.length !== a.width * a.height * 4 || b.data.length !== b.width * b.height * 4) {
    fail('invalid_pixel_buffer', 'Pixel buffer length does not match its declared dimensions.');
  }
}

export interface MaskComparison {
  /** Pixels compared outside the approved mask. */
  outsidePixels: number;
  /** Pixels differing outside the approved mask. Must be 0 to pass. */
  outsideDiffPixels: number;
  result: 'exact' | 'mismatch';
}

/**
 * Compare every pixel OUTSIDE the approved mask, exactly. A changed body pixel,
 * or a changed pixel just outside the mask, fails; an in-mask difference is
 * expected and is not counted. No sampling, no missing-frame pass.
 */
export function compareOutsideMask(original: Rgba, output: Rgba, mask: Rgba, geometry: { x: number; y: number; width: number; height: number }): MaskComparison {
  assertSameDimensions(original, output, 'Original and composited frames');
  assertSameDimensions(original, mask, 'Frame and mask');
  let outsidePixels = 0;
  let outsideDiffPixels = 0;
  for (let y = 0; y < original.height; y++) {
    for (let x = 0; x < original.width; x++) {
      const i = (y * original.width + x) * 4;
      const inGeometry = x >= geometry.x && x < geometry.x + geometry.width && y >= geometry.y && y < geometry.y + geometry.height;
      const masked = inGeometry && mask.data[i]! >= 128 && mask.data[i + 1]! >= 128 && mask.data[i + 2]! >= 128;
      if (masked) continue;
      outsidePixels++;
      if (original.data[i] !== output.data[i] || original.data[i + 1] !== output.data[i + 1]
        || original.data[i + 2] !== output.data[i + 2] || original.data[i + 3] !== output.data[i + 3]) outsideDiffPixels++;
    }
  }
  return { outsidePixels, outsideDiffPixels, result: outsideDiffPixels === 0 ? 'exact' : 'mismatch' };
}

/**
 * Deterministic opener compositor: replace ONLY the approved mask region with the
 * supplied already-rendered overlay layer, byte for byte, and copy every other
 * pixel from the original. No blending model, no inpainting, no resize, no
 * full-frame fallback — the output differs from the original only inside the
 * approved region, and identical inputs give identical bytes.
 */
export function composeApprovedMask(original: Rgba, mask: Rgba, layer: Rgba, geometry: { x: number; y: number; width: number; height: number }): Rgba {
  assertSameDimensions(original, mask, 'Original frame and mask');
  assertSameDimensions(original, layer, 'Original frame and overlay layer');
  const out: Rgba = { width: original.width, height: original.height, data: new Uint8Array(original.data) };
  for (let y = geometry.y; y < geometry.y + geometry.height; y++) {
    if (y < 0 || y >= original.height) continue;
    for (let x = geometry.x; x < geometry.x + geometry.width; x++) {
      if (x < 0 || x >= original.width) continue;
      const i = (y * original.width + x) * 4;
      if (mask.data[i]! < 128 || mask.data[i + 1]! < 128 || mask.data[i + 2]! < 128) continue;
      out.data[i] = layer.data[i]!;
      out.data[i + 1] = layer.data[i + 1]!;
      out.data[i + 2] = layer.data[i + 2]!;
      out.data[i + 3] = layer.data[i + 3]!;
    }
  }
  return out;
}

export interface ReuseVerdict {
  /** `byte_identical` proves reuse from hashes alone; `pixel_identical` proves it
   *  after a decode; `inconclusive` proves nothing and may not complete. */
  result: 'byte_identical' | 'pixel_identical' | 'mismatch' | 'inconclusive';
  detail: string;
}

/**
 * Prove an unchanged included slide was reused, or refuse to.
 * An identical pinned SHA-256 is proof. Otherwise the caller must supply canonical
 * decoded pixels; a bare hash difference is inconclusive, never a pass.
 */
export function verifyAssetReuse(args: {
  pinnedSha256: string | null;
  outputSha256: string | null;
  originalPixels?: Rgba;
  outputPixels?: Rgba;
}): ReuseVerdict {
  const { pinnedSha256, outputSha256, originalPixels, outputPixels } = args;
  if (pinnedSha256 && outputSha256 && pinnedSha256 === outputSha256) {
    return { result: 'byte_identical', detail: 'Pinned and output SHA-256 match: the original asset was reused directly.' };
  }
  if (!originalPixels || !outputPixels) {
    return { result: 'inconclusive', detail: 'Encoded hashes differ and no canonical decoded pixels were supplied; a hash difference alone proves nothing.' };
  }
  if (originalPixels.width !== outputPixels.width || originalPixels.height !== outputPixels.height) {
    return { result: 'mismatch', detail: `Canonical dimensions differ: ${originalPixels.width}x${originalPixels.height} vs ${outputPixels.width}x${outputPixels.height}.` };
  }
  assertSameDimensions(originalPixels, outputPixels, 'Canonical frames');
  for (let i = 0; i < originalPixels.data.length; i++) {
    if (originalPixels.data[i] !== outputPixels.data[i]) {
      return { result: 'mismatch', detail: `Canonical pixel differs at byte ${i}; the original frame was not preserved.` };
    }
  }
  return { result: 'pixel_identical', detail: 'Every canonical RGBA pixel matches the original frame.' };
}

/* ------------------------------------------------------------------------- *
 * Completion gate.
 * ---------------------------------------------------------------------- */
export interface CheckOutcome {
  outputIndex: number;
  check: string;
  status: 'pass' | 'fail' | 'error' | 'unavailable';
  detail?: string;
}

/** The checks required to complete one output slide: the contract's own list. */
export function requiredChecks(contract: ExactEditContract, outputIndex: number): string[] {
  return exactEditChecks(contract, outputIndex);
}

/**
 * A slide completes only when EVERY check derived from its contract passed.
 * `fail`, `error` and `unavailable` are all terminal negatives: an unavailable
 * visual comparison or an errored decoder is unverified, never a pass. There is
 * no reduced check set and no auto-pass for a missing visual observer.
 */
export function exactEditSlideCompletion(
  contract: ExactEditContract,
  outputIndex: number,
  outcomes: readonly CheckOutcome[],
): { complete: boolean; reasons: string[] } {
  assertExactEditContractIntact(contract);
  const required = new Map(requiredChecks(contract, outputIndex).map(c => [c, true]));
  const reasons: string[] = [];
  for (const o of outcomes) {
    if (o.outputIndex !== outputIndex) continue;
    if (!required.has(o.check)) {
      reasons.push(`Unexpected check "${o.check}" for slide ${outputIndex}: it is not part of contract ${contract.contractHash}.`);
      continue;
    }
    required.delete(o.check);
    if (o.status !== 'pass') reasons.push(`${o.check}: ${o.status}${o.detail ? ` — ${o.detail}` : ''}`);
  }
  for (const missing of required.keys()) reasons.push(`No result recorded for required check: ${missing}`);
  return { complete: reasons.length === 0, reasons };
}

/** exact_edit is one deck and one variant. Any attempt to rank or select between
 *  alternatives is a contract violation. */
export function assertSingleVariant(contract: ExactEditContract): void {
  if (contract.variantCount !== EXACT_EDIT_VARIANT_COUNT) {
    fail('exact_edit_variant_count', `exact_edit is one deck/one variant; got ${contract.variantCount}.`);
  }
}