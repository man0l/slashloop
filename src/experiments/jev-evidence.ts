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
 * to be skipped when the state cannot support the question at all.
 *
 * Contract, in one line: cover every source and candidate slide inside a fixed
 * budget, and where the budget or the evidence runs out, say so explicitly
 * rather than silently shortening the record.
 *
 * Nothing here awaits or reorders the report task. The report is scheduled
 * independently and may finish in either order; this module only records
 * whether its context was present at the time the state was built.
 */
import type { Experiment, Input, Proposal } from './schema.js';

export const JEV_EVIDENCE_VERSION = 1;

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

export interface SourceSlideEvidence {
  location: string;
  observation: string;
  truncated: boolean;
}

export interface JevSourceEvidence {
  /** `s0`, `s1`, … — the same id the analysis prompts use for this input. */
  source: string;
  videoId: string;
  status: string;
  /** Distinct observed slide locations (`slide:1`, `slide:2`, …). */
  slides: SourceSlideEvidence[];
  /** Evidence entries dropped to stay inside the source budget. */
  omitted: number;
}

export interface JevEvidenceContract {
  version: number;
  sources: JevSourceEvidence[];
  /** Largest slide count any source actually observed. */
  expectedSlides: number;
  /** Slides for which at least one source recorded an observation. */
  observedSlides: number;
  /** Slide positions with no observation from any source. */
  missingSlides: number[];
  /** Every source slide inside the budget, nothing dropped. */
  complete: boolean;
  report: { status: 'present' | 'absent'; summary: string; truncated: boolean; chars: number };
  /** Plain statements of what the judge is NOT being shown. */
  notes: string[];
  /** Enough context exists to ask "beats the original" at all. */
  sufficient: boolean;
}

const slidePosition = (location: string): number | null => {
  const m = /^slide:(\d+)/.exec(location);
  return m ? Number(m[1]) : null;
};

/**
 * Every ready input's evidence, in one bounded block.
 *
 * `evidence` is not per-slide: a location may be a timeline stamp or a segment
 * index, so entries are kept verbatim and the slide inventory is derived from
 * the `slide:` locations. Ordering is input order, then numeric slide order, so
 * the block is byte-stable for the same experiment.
 */
export function sourceEvidence(inputs: readonly Input[]): JevSourceEvidence[] {
  const sources: JevSourceEvidence[] = [];
  let remaining = SOURCE_BUDGET_CHARS;
  let ix = 0;
  for (const input of inputs) {
    if (input.status !== 'ready') continue;
    const ordered = [...input.evidence].sort((a, b) => {
      const pa = slidePosition(a.location), pb = slidePosition(b.location);
      if (pa !== null && pb !== null) return pa - pb;
      if (pa !== null) return -1;
      if (pb !== null) return 1;
      return a.location.localeCompare(b.location);
    });
    const slides: SourceSlideEvidence[] = [];
    let omitted = 0;
    for (const entry of ordered) {
      const bounded = boundText(entry.observation, PER_ENTRY_CHARS);
      if (bounded.text.length > remaining) {
        omitted++;
        continue;
      }
      remaining -= bounded.text.length;
      slides.push({ location: entry.location, observation: bounded.text, truncated: bounded.truncated });
    }
    sources.push({ source: `s${ix++}`, videoId: input.videoId, status: input.status, slides, omitted });
  }
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
 * honest at all: without a report AND without a single observed source slide
 * there is no original to beat, and a confident answer would be fabricated.
 */
export function jevEvidence(inputs: readonly Input[], report: Experiment['report']): JevEvidenceContract {
  const sources = sourceEvidence(inputs);
  const reportPart = reportEvidence(report);
  const positions = new Set<number>();
  let expectedSlides = 0;
  for (const s of sources) {
    for (const slide of s.slides) {
      const p = slidePosition(slide.location);
      if (p === null) continue;
      positions.add(p);
      if (p > expectedSlides) expectedSlides = p;
    }
  }
  const missingSlides: number[] = [];
  for (let i = 1; i <= expectedSlides; i++) if (!positions.has(i)) missingSlides.push(i);
  const observedSlides = positions.size;
  const droppedEntries = sources.reduce((n, s) => n + s.omitted, 0);
  const notes: string[] = [];
  if (reportPart.status === 'absent') notes.push('report summary absent: the report task is scheduled independently and was not awaited.');
  if (reportPart.truncated) notes.push(`report summary truncated to ${reportPart.summary.length} of ${reportPart.chars} characters.`);
  if (droppedEntries) notes.push(`${droppedEntries} source evidence entr${droppedEntries === 1 ? 'y was' : 'ies were'} dropped to stay inside the ${SOURCE_BUDGET_CHARS}-character evidence budget.`);
  if (missingSlides.length) notes.push(`no observation recorded for slide(s) ${missingSlides.join(', ')}.`);
  const truncatedScenes = sources.reduce((n, s) => n + s.slides.filter(v => v.truncated).length, 0);
  if (truncatedScenes) notes.push(`${truncatedScenes} observation(s) truncated to ${PER_ENTRY_CHARS} characters.`);
  if (!sources.length) notes.push('no ready source input carried evidence.');
  const sufficient = reportPart.status === 'present' || observedSlides > 0;
  return {
    version: JEV_EVIDENCE_VERSION,
    sources,
    expectedSlides,
    observedSlides,
    missingSlides,
    complete: !droppedEntries && !missingSlides.length && expectedSlides > 0,
    report: reportPart,
    notes,
    sufficient,
  };
}

export interface CandidateSlideEvidence { role: string; scene: string; overlayText: string; truncated: boolean }

/**
 * One candidate's whole storyboard inside the budget: every slide, each scene
 * bounded, and a flag when a scene was cut. A candidate whose scenes were cut
 * mid-sentence is visibly different from one that was not.
 */
export function candidateSlides(brief: Proposal['brief'] | undefined): { slides: CandidateSlideEvidence[]; truncated: boolean } {
  const slides = (brief?.slides ?? []).map(slide => {
    const scene = boundText(slide.scene, PER_ENTRY_CHARS);
    return { role: String(slide.role ?? ''), scene: scene.text, overlayText: boundText(slide.overlayText, PER_ENTRY_CHARS).text, truncated: scene.truncated };
  });
  return { slides, truncated: slides.some(s => s.truncated) };
}