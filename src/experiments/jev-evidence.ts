/**
 * Bounded evidence for the briefs-stage judge (SLA-510).
 *
 * The judge is asked which candidate beats THE ORIGINAL. That question is only
 * answerable with source evidence, and the previous state handed it two
 * degenerate strings: `original_pattern` was empty whenever the independently
 * scheduled report had not landed, and `original_shots` was two observations
 * per input joined and sliced to 800 characters — slides 3..N were absent with
 * nothing saying so. A judge handed incomplete context still returns confident
 * scores, so the incompleteness has to be visible IN the state and the call has
 * to be skipped only when the state cannot support the question at all.
 *
 * Contract, in one line: cover every source and candidate slide inside a fixed
 * budget, and where the budget or the evidence runs out, say so explicitly
 * rather than silently shortening the record.
 *
 * Three rules this module exists to hold (SLA-510 review):
 *   1. The slide inventory follows the PRODUCTION index/coverage contract.
 *      `observations()` mints `slide:${timestampSec}` for a slideshow and
 *      `second:${timestampSec}` for a video, and `compatibleInput()` accepts a
 *      ready slideshow source only when its evidence is exactly `slide:0 …
 *      slide:total-1`. Positions are therefore ZERO-BASED and dense, and the
 *      expected count comes from `Input.coverage`, never from a highest index
 *      seen. An unknown total is `expectedKnown: false`, which is not the same
 *      claim as "nothing is missing".
 *   2. A gap is a per-source fact. Two sources of seven and three slides do not
 *      cancel out into one complete deck, so gaps are recorded against the
 *      source that has them.
 *   3. `complete` means "the whole picture, nothing cut". A cut observation, a
 *      dropped entry, an unknown total and a declared gap all make it false,
 *      because `briefJudge.evidenceComplete` is documented as "false when the
 *      judge's evidence block had a gap or a budget cut".
 *
 * Nothing here awaits or reorders the report task. The report is scheduled
 * independently and may finish in either order; this module only records
 * whether its context was present at the time the state was built.
 */
import type { Experiment, Input, Proposal } from './schema.js';

/** Bumped to 2: the contract gained per-source coverage, gap and char facts. */
export const JEV_EVIDENCE_VERSION = 2;

/** Per-entry character cap. One observation/scene is quoted, never summarised. */
const PER_ENTRY_CHARS = 400;
/** Total cap for the source-evidence block; overflow is reported, never hidden. */
const SOURCE_BUDGET_CHARS = 6000;
/** The report summary is a pattern digest, not the source of truth. */
const PATTERN_CHARS = 500;

export interface BoundedText {
  text: string;
  /** True when the value exceeded its cap and was cut mid-string. */
  truncated: boolean;
  chars: number;
}

/** Cut a string to `limit`, recording whether anything was dropped. */
export function boundText(value: unknown, limit: number): BoundedText {
  const chars = String(value ?? '');
  return { text: chars.slice(0, limit), truncated: chars.length > limit, chars: chars.length };
}

export type LocationKind = 'slide' | 'second' | 'other';
export interface EvidenceLocation { kind: LocationKind; position: number | null }

/** The only two location shapes the analysis pipeline mints. Anything else is
 *  kept verbatim and counted as a non-positional entry, never as a slide. */
const LOCATION = /^(slide|second):(\d+)$/;

export function parseLocation(location: unknown): EvidenceLocation {
  const m = LOCATION.exec(String(location ?? '').trim());
  return m ? { kind: m[1] as LocationKind, position: Number(m[2]) } : { kind: 'other', position: null };
}

export interface SourceSlideEvidence {
  location: string;
  kind: LocationKind;
  /** Zero-based index for `slide:`/`second:`, null for anything else. */
  position: number | null;
  observation: string;
  /** This entry's own text was cut at `PER_ENTRY_CHARS`. */
  truncated: boolean;
  /** Length of the observation before this entry was bounded. */
  chars: number;
}

export interface JevSourceEvidence {
  /** `s0`, `s1`, … — the id the briefs classifier (`sources` above) and the
   *  report prompt already use, so evidence entries stay citable. */
  source: string;
  /** Index into the experiment's `inputs` array. The stable mapping back to the
   *  input a report citation refers to. */
  inputIndex: number;
  videoId: string;
  status: string;
  /** `Input.coverage.basis`, or 'unknown' when coverage is absent. */
  basis: string;
  /** `Input.coverage.total`: the declared slide count, or null when the source
   *  declared none (a video source never does). */
  expectedSlides: number | null;
  /** True only when `expectedSlides` came from verified coverage. */
  expectedKnown: boolean;
  /** The source's own coverage verdict, null when it stated none. */
  coverageComplete: boolean | null;
  /** Zero-based slide positions this source actually observed. */
  observedPositions: number[];
  /** Positions inside the declared range with no observation. Always empty when
   *  the total is unknown — that is `expectedKnown: false`, not "nothing
   *  missing". */
  missingPositions: number[];
  /** Timeline stamps (`second:N`) this source observed. For a video source
   *  these ARE the evidence, exactly as slide positions are for a slideshow. */
  timelineStamps: number[];
  /** Every retained entry: slide positions in order, then timeline stamps. */
  slides: SourceSlideEvidence[];
  /** Evidence entries dropped to stay inside the source budget. */
  omitted: number;
  /** Retained entries whose own text was cut. */
  truncatedEntries: number;
}

export interface SourceGap {
  source: string;
  videoId: string;
  expected: number | null;
  missing: number[];
}

export interface JevEvidenceContract {
  version: number;
  sources: JevSourceEvidence[];
  /** Largest DECLARED slide count across sources; null when none declared one. */
  expectedSlides: number | null;
  /** Distinct zero-based slide positions observed by at least one source. */
  observedSlides: number;
  /** Union of the per-source missing positions. */
  missingSlides: number[];
  /** Gaps attributed to the source that has them, so one source's positions can
   *  never mask another source's hole. */
  gaps: SourceGap[];
  /** True only when every source retained all of its evidence, every declared
   *  position was observed, and nothing anywhere in the block was cut. */
  complete: boolean;
  report: { status: 'present' | 'absent'; summary: string; truncated: boolean; chars: number };
  /** Plain statements of what the judge is NOT being shown. */
  notes: string[];
  /** Enough context exists to ask "beats the original" at all. */
  sufficient: boolean;
}

const KIND_RANK: Record<LocationKind, number> = { slide: 0, second: 1, other: 2 };

/**
 * Every ready input's evidence, in one bounded block.
 *
 * `evidence` is not per-slide: a location may be a timeline stamp or a segment
 * index, so entries are kept verbatim and the slide inventory is derived from
 * the `slide:` locations. Ordering is slide position, then timeline stamp, so a
 * slideshow and a video source are each read in their own natural order and the
 * block is byte-stable for the same experiment.
 */
export function sourceEvidence(inputs: readonly Input[]): JevSourceEvidence[] {
  const sources: JevSourceEvidence[] = [];
  let remaining = SOURCE_BUDGET_CHARS;
  let ix = 0;
  inputs.forEach((input, inputIndex) => {
    if (input.status !== 'ready') return;
    const ordered = [...input.evidence].sort((a, b) => {
      const pa = parseLocation(a.location), pb = parseLocation(b.location);
      if (pa.kind !== pb.kind) return KIND_RANK[pa.kind] - KIND_RANK[pb.kind];
      if (pa.position !== null && pb.position !== null) return pa.position - pb.position;
      return String(a.location).localeCompare(String(b.location));
    });
    const slides: SourceSlideEvidence[] = [];
    let omitted = 0;
    for (const entry of ordered) {
      const bounded = boundText(entry.observation, PER_ENTRY_CHARS);
      const at = parseLocation(entry.location);
      if (bounded.text.length > remaining) { omitted++; continue; }
      remaining -= bounded.text.length;
      slides.push({ location: String(entry.location), kind: at.kind, position: at.position, observation: bounded.text, truncated: bounded.truncated, chars: bounded.chars });
    }
    const declared = input.coverage?.total;
    const expectedKnown = typeof declared === 'number' && Number.isInteger(declared) && declared >= 0;
    const observedPositions = [...new Set(slides.filter(v => v.kind === 'slide' && v.position !== null).map(v => v.position!))].sort((a, b) => a - b);
    const timelineStamps = [...new Set(slides.filter(v => v.kind === 'second' && v.position !== null).map(v => v.position!))].sort((a, b) => a - b);
    // Positions the source declared but never delivered. Zero-based, because
    // `compatibleInput` accepts a ready slideshow source only when its evidence
    // is exactly `slide:0 … slide:total-1`.
    const missingPositions = expectedKnown
      ? Array.from({ length: declared as number }, (_, i) => i).filter(i => !observedPositions.includes(i))
      : [];
    sources.push({
      source: `s${ix++}`, inputIndex, videoId: input.videoId, status: input.status,
      basis: input.coverage?.basis ?? 'unknown',
      expectedSlides: expectedKnown ? (declared as number) : null, expectedKnown,
      coverageComplete: typeof input.coverage?.complete === 'boolean' ? input.coverage.complete : null,
      observedPositions, missingPositions, timelineStamps, slides, omitted,
      truncatedEntries: slides.filter(v => v.truncated).length,
    });
  });
  return sources;
}

/** The independently scheduled report's contribution, present or not. */
export function reportEvidence(report: Experiment['report']): JevEvidenceContract['report'] {
  const summary = typeof report?.summary === 'string' ? report.summary : '';
  const bounded = boundText(summary, PATTERN_CHARS);
  return { status: summary ? 'present' : 'absent', summary: bounded.text, truncated: bounded.truncated, chars: bounded.chars };
}

/**
 * Assemble the bounded, self-describing evidence contract.
 *
 * `sufficient` is the gate the caller uses to decide whether asking the judge is
 * honest at all: with no report AND no usable retained observation there is no
 * original to beat, and a confident answer would be fabricated. A timeline
 * observation (`second:0`) counts: `observations()` mints those for a video
 * source and `compatibleInput()` explicitly supports video/video+transcript, so
 * judging a video against its own timeline is the supported path, not a
 * degenerate one.
 */
export function jevEvidence(inputs: readonly Input[], report: Experiment['report']): JevEvidenceContract {
  const sources = sourceEvidence(inputs);
  const reportPart = reportEvidence(report);
  const positions = new Set<number>();
  for (const s of sources) for (const p of s.observedPositions) positions.add(p);
  const declared = sources.filter(s => s.expectedKnown).map(s => s.expectedSlides as number);
  const missingSlides = [...new Set(sources.flatMap(s => s.missingPositions))].sort((a, b) => a - b);
  const gaps: SourceGap[] = sources
    .filter(s => s.missingPositions.length)
    .map(s => ({ source: s.source, videoId: s.videoId, expected: s.expectedSlides, missing: s.missingPositions }));
  const notes: string[] = [];
  if (reportPart.status === 'absent') notes.push('report summary absent: the report task is scheduled independently and was not awaited.');
  if (reportPart.truncated) notes.push(`report summary truncated to ${reportPart.summary.length} of ${reportPart.chars} characters.`);
  if (!sources.length) notes.push('no ready source input carried evidence.');
  for (const s of sources) {
    const dropped = s.omitted;
    if (dropped) notes.push(`${s.source}: ${dropped} evidence entr${dropped === 1 ? 'y was' : 'ies were'} dropped to stay inside the ${SOURCE_BUDGET_CHARS}-character evidence budget.`);
    if (s.truncatedEntries) notes.push(`${s.source}: ${s.truncatedEntries} observation(s) truncated to ${PER_ENTRY_CHARS} characters.`);
    if (s.missingPositions.length) notes.push(`${s.source} (${s.videoId}): no observation recorded for slide(s) ${s.missingPositions.join(', ')} of ${s.expectedSlides} declared.`);
    if (!s.expectedKnown) notes.push(`${s.source} (${s.videoId}, basis ${s.basis}): declared no slide total, so full source coverage cannot be confirmed.`);
    else if (s.coverageComplete === false) notes.push(`${s.source} (${s.videoId}): the analysis recorded its own coverage as incomplete.`);
  }
  // A budget cut anywhere means the judge is reading a shortened record.
  const cut = reportPart.truncated || sources.some(s => s.omitted > 0 || s.truncatedEntries > 0);
  const gapped = sources.some(s => s.missingPositions.length || !s.expectedKnown || s.coverageComplete === false);
  const usable = sources.reduce((n, s) => n + s.slides.filter(v => v.observation.trim()).length, 0);
  const sufficient = reportPart.status === 'present' || usable > 0;
  if (!sufficient) notes.push('no usable source observation was retained, so there is no original for the judge to rank against.');
  return {
    version: JEV_EVIDENCE_VERSION,
    sources,
    expectedSlides: declared.length ? Math.max(...declared) : null,
    observedSlides: positions.size,
    missingSlides,
    gaps,
    complete: sources.length > 0 && !cut && !gapped,
    report: reportPart,
    notes,
    sufficient,
  };
}

export interface CandidateSlideEvidence {
  role: string;
  scene: string;
  overlayText: string;
  /** The scene was cut at `PER_ENTRY_CHARS`. */
  truncated: boolean;
  /** The overlay copy was cut at `PER_ENTRY_CHARS`. Recorded on its own: a cut
   *  overlay is a cut instruction, and the judge ranks against it. */
  overlayTruncated: boolean;
}

/**
 * One candidate's whole storyboard inside the budget: every slide, each scene
 * and each overlay bounded, and a flag for each cut. A candidate whose scenes or
 * overlays were cut mid-sentence is visibly different from one that was not.
 */
export function candidateSlides(brief: Proposal['brief'] | undefined): { slides: CandidateSlideEvidence[]; truncated: boolean } {
  const slides = (brief?.slides ?? []).map(slide => {
    const scene = boundText(slide.scene, PER_ENTRY_CHARS);
    const overlay = boundText(slide.overlayText, PER_ENTRY_CHARS);
    return {
      role: String(slide.role ?? ''), scene: scene.text, overlayText: overlay.text,
      truncated: scene.truncated, overlayTruncated: overlay.truncated,
    };
  });
  return { slides, truncated: slides.some(s => s.truncated || s.overlayTruncated) };
}