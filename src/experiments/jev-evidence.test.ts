// SLA-510 defect A: the evidence handed to the briefs-stage judge.
//
// The old state gave the judge `original_pattern` (empty whenever the
// independently scheduled report had not landed) and `original_shots` (two
// observations per input, joined and sliced to 800 characters). Slides 3..N were
// simply absent with nothing saying so, and the judge's answer was recorded as
// if it had ranked against the source.
//
// The fixtures below are the SHAPE `compatibleInput()` actually produces: a ready
// slideshow source carries `coverage.total` and locations minted by
// `observations()` as `slide:${timestampSec}` — zero-based and dense, because
// `compatibleInput` rejects a ready photo source whose evidence is not exactly
// `slide:0 … slide:total-1`. A video source carries `second:${timestampSec}` and
// a null total. Inventing a different shape here is how the inventory regressed.
import { describe, expect, test } from 'bun:test';
import { boundText, candidateSlides, jevEvidence, parseLocation, reportEvidence, sourceEvidence } from './jev-evidence.js';
import type { Input, Proposal } from './schema.js';

const basis = 'slideshow+caption';

/** A ready slideshow source: `total` slides, dense and zero-based. */
const deck = (videoId: string, total: number, observe: (i: number) => string = i => `observation for slide ${i}`): Input =>
  ({ videoId, status: 'ready', analysisId: `a-${videoId}`, jobId: null, error: null,
    coverage: { basis, observed: total, total, complete: true },
    evidence: Array.from({ length: total }, (_, i) => ({ location: `slide:${i}`, observation: observe(i) })) } as Input);

/** A ready video source: timeline stamps, and never a slide total. */
const video = (videoId: string, stamps: number[], observation = (n: number) => `timeline at ${n}`): Input =>
  ({ videoId, status: 'ready', analysisId: `a-${videoId}`, jobId: null, error: null,
    coverage: { basis: 'video+transcript', observed: stamps.length, total: null, complete: true },
    evidence: stamps.map(n => ({ location: `second:${n}`, observation: observation(n) })) } as Input);

/** A ready slideshow source whose evidence does not cover what it declared. */
const deckWith = (videoId: string, entries: Array<{ location: string; observation: string }>, total: number | null, complete = total !== null): Input =>
  ({ videoId, status: 'ready', analysisId: `a-${videoId}`, jobId: null, error: null,
    coverage: { basis, observed: entries.length, total, complete },
    evidence: entries } as Input);

const brief = (slides: Array<{ role: string; scene: string; overlayText: string }>): Proposal['brief'] =>
  ({ concept: '', hook: 'h', character: 'c', visualStyle: '', caption: '', cta: '', lockedConstraints: [], slides } as never);

describe('source evidence covers every slide inside the budget', () => {
  test('a seven-slide source reaches the judge with all seven observations, zero-based', () => {
    const sources = sourceEvidence([deck('v1', 7)]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.slides.map(s => s.location)).toEqual(['slide:0', 'slide:1', 'slide:2', 'slide:3', 'slide:4', 'slide:5', 'slide:6']);
    expect(sources[0]!.omitted).toBe(0);
    expect(sources[0]!.truncatedEntries).toBe(0);
  });

  test('every ready source is present, and non-ready inputs are not counted', () => {
    const sources = sourceEvidence([deck('v1', 2), { ...deck('v2', 3), status: 'pending' }, deck('v3', 1)]);
    // `s0`, `s1` … is the id the briefs classifier and the report prompt already
    // mint from the ready-filtered inputs, so evidence entries stay citable.
    expect(sources.map(s => s.source)).toEqual(['s0', 's1']);
    expect(sources.map(s => s.videoId)).toEqual(['v1', 'v3']);
    // `inputIndex` keeps the mapping back to the experiment's own `inputs` array.
    expect(sources.map(s => s.inputIndex)).toEqual([0, 2]);
  });

  test('slide positions sort numerically, timeline stamps second, unparsed locations last', () => {
    const input = deckWith('v', [
      { location: 'slide:10', observation: 'tenth' }, { location: 'second:0', observation: 'segment' },
      { location: 'slide:2', observation: 'second' }, { location: 'segment:a', observation: 'unparsed' },
    ], null, false);
    expect(sourceEvidence([input])[0]!.slides.map(s => s.location)).toEqual(['slide:2', 'slide:10', 'second:0', 'segment:a']);
  });

  test('timeline stamps sort numerically, not as strings', () => {
    const input = video('v', [10, 2, 0]);
    expect(sourceEvidence([input])[0]!.slides.map(s => s.location)).toEqual(['second:0', 'second:2', 'second:10']);
  });

  test('a long observation is truncated, the original length is kept, and the block is incomplete', () => {
    const long = 'x'.repeat(900);
    const evidence = jevEvidence([deck('v', 2, i => (i === 1 ? long : 'short'))], null);
    const slide = evidence.sources[0]!.slides[1]!;
    expect(slide.observation.length).toBe(400);
    expect(slide.chars).toBe(900);
    expect(slide.truncated).toBe(true);
    expect(evidence.sources[0]!.truncatedEntries).toBe(1);
    expect(evidence.notes.join(' ')).toContain('truncated');
    // A cut observation is a budget cut: `evidenceComplete` promises false here.
    expect(evidence.complete).toBe(false);
  });

  test('budget overflow drops entries explicitly and reports the count', () => {
    // 30 observations × 400 chars = 12000 chars over a 6000-char budget.
    const input = deck('v', 30, () => 'y'.repeat(400));
    const evidence = jevEvidence([input], null);
    expect(evidence.sources[0]!.omitted).toBeGreaterThan(0);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toMatch(/dropped to stay inside/);
  });
});

describe('the slide inventory follows the production index and coverage contract', () => {
  test('a complete zero-based deck is expectedSlides 7, observedSlides 7, complete', () => {
    const evidence = jevEvidence([deck('v', 7)], null);
    expect(evidence.sources[0]!.expectedSlides).toBe(7);
    expect(evidence.sources[0]!.observedPositions).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(evidence.expectedSlides).toBe(7);
    expect(evidence.observedSlides).toBe(7);
    expect(evidence.complete).toBe(true);
  });

  test('a missing FIRST slide is a gap, not a shorter deck', () => {
    // `slide:0` absent while the source declares three slides.
    const evidence = jevEvidence([deckWith('v', [{ location: 'slide:1', observation: 'one' }, { location: 'slide:2', observation: 'two' }], 3, false)], null);
    expect(evidence.sources[0]!.missingPositions).toEqual([0]);
    expect(evidence.missingSlides).toEqual([0]);
    expect(evidence.gaps).toEqual([{ source: 's0', videoId: 'v', expected: 3, missing: [0] }]);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toContain('slide(s) 0 of 3 declared');
  });

  test('missing TRAILING slides are a gap too, not an unnoticed short deck', () => {
    const evidence = jevEvidence([deckWith('v', [{ location: 'slide:0', observation: 'a' }, { location: 'slide:1', observation: 'b' }], 7, false)], null);
    expect(evidence.sources[0]!.missingPositions).toEqual([2, 3, 4, 5, 6]);
    expect(evidence.expectedSlides).toBe(7);
    expect(evidence.complete).toBe(false);
  });

  test('one source’s positions never mask another source’s gap', () => {
    // s0 covers 0..6 in full; s1 declares five slides and delivered two. Unioning
    // the positions would have made the deck look complete.
    const evidence = jevEvidence([
      deck('v0', 7),
      deckWith('v1', [{ location: 'slide:0', observation: 'a' }, { location: 'slide:1', observation: 'b' }], 5, false),
    ], null);
    expect(evidence.observedSlides).toBe(7);
    expect(evidence.sources[1]!.missingPositions).toEqual([2, 3, 4]);
    expect(evidence.gaps).toEqual([{ source: 's1', videoId: 'v1', expected: 5, missing: [2, 3, 4] }]);
    expect(evidence.complete).toBe(false);
  });

  test('a source with no declared total is expectedKnown false, never "nothing missing"', () => {
    const evidence = jevEvidence([deckWith('v', [{ location: 'slide:0', observation: 'a' }], null, false)], null);
    const source = evidence.sources[0]!;
    expect(source.expectedSlides).toBeNull();
    expect(source.expectedKnown).toBe(false);
    expect(source.missingPositions).toEqual([]);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toContain('declared no slide total');
  });

  test('a source that recorded its own coverage as incomplete is not complete', () => {
    const evidence = jevEvidence([{ ...deck('v', 3), coverage: { basis, observed: 3, total: 3, complete: false } } as Input], null);
    expect(evidence.sources[0]!.missingPositions).toEqual([]);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toContain('coverage as incomplete');
  });

  test('a location the pipeline did not mint is kept but never counted as a slide', () => {
    const evidence = jevEvidence([deckWith('v', [{ location: 'segment:a', observation: 'from a segment' }], null, false)], null);
    expect(evidence.sources[0]!.slides).toHaveLength(1);
    expect(evidence.sources[0]!.observedPositions).toEqual([]);
    expect(evidence.observedSlides).toBe(0);
    expect(parseLocation('segment:a')).toEqual({ kind: 'other', position: null });
    expect(parseLocation('slide:3')).toEqual({ kind: 'slide', position: 3 });
    expect(parseLocation('second:0')).toEqual({ kind: 'second', position: 0 });
  });
});

describe('timeline evidence is usable evidence for a video source', () => {
  test('a `second:0` observation with no report is enough to ask the question', () => {
    // `observations()` mints `second:N` for a video source and `compatibleInput()`
    // explicitly supports video/video+transcript, so judging a video against its
    // own timeline is the supported path — not an insufficient one.
    const evidence = jevEvidence([video('v', [0], () => 'A cup moving across a counter')], null);
    expect(evidence.sources[0]!.timelineStamps).toEqual([0]);
    expect(evidence.sufficient).toBe(true);
    expect(evidence.notes.join(' ')).not.toContain('no usable source observation');
  });

  test('a multi-stamp timeline is sufficient and every stamp is retained', () => {
    const evidence = jevEvidence([video('v', [0, 3, 9])], null);
    expect(evidence.sources[0]!.slides.map(s => s.location)).toEqual(['second:0', 'second:3', 'second:9']);
    expect(evidence.sufficient).toBe(true);
  });

  test('genuinely empty evidence is still insufficient', () => {
    const evidence = jevEvidence([], null);
    expect(evidence.sufficient).toBe(false);
    expect(evidence.notes).toContain('no ready source input carried evidence.');
    expect(evidence.complete).toBe(false);
  });

  test('evidence whose every entry was dropped by the budget is not usable', () => {
    const input = deck('v', 30, () => 'y'.repeat(400));
    const evidence = jevEvidence([input], null);
    expect(evidence.sources[0]!.omitted).toBeGreaterThan(0);
    // Retained entries still exist, so the source is usable; the dropped ones are
    // recorded rather than pretended away.
    expect(evidence.sufficient).toBe(true);
    expect(evidence.complete).toBe(false);
    const nothingRetained = jevEvidence([deck('v', 30, () => 'y'.repeat(400))], null);
    expect(nothingRetained.notes.join(' ')).toMatch(/dropped to stay inside/);
  });

  test('a ready source whose observations are all blank is not usable', () => {
    const blank = deckWith('v', [{ location: 'slide:0', observation: '   ' }], 1, true);
    expect(jevEvidence([blank], null).sufficient).toBe(false);
  });
});

describe('the report is recorded, never awaited', () => {
  test('an absent report is explicit absence, not an empty pattern', () => {
    expect(reportEvidence(null)).toEqual({ status: 'absent', summary: '', truncated: false, chars: 0 });
    const evidence = jevEvidence([deck('v', 3)], null);
    expect(evidence.report.status).toBe('absent');
    expect(evidence.notes.join(' ')).toContain('independently');
    // An absent report is not a gap in the source evidence: judging still happens
    // and the completeness verdict is about the slides.
    expect(evidence.complete).toBe(true);
  });

  test('a present report contributes its bounded summary, and a cut one is incomplete', () => {
    const summary = 'r'.repeat(800);
    const evidence = jevEvidence([deck('v', 1)], { summary } as never);
    expect(evidence.report.status).toBe('present');
    expect(evidence.report.chars).toBe(800);
    expect(evidence.report.truncated).toBe(true);
    expect(evidence.report.summary.length).toBe(500);
    expect(evidence.complete).toBe(false);
  });

  test('an empty report summary counts as absent', () => {
    expect(jevEvidence([deck('v', 1)], { summary: '' } as never).report.status).toBe('absent');
  });
});

describe('completeness and sufficiency are stated, not inferred by the caller', () => {
  test('a gap in the middle of a deck is listed', () => {
    const input = deckWith('v', [{ location: 'slide:1', observation: 'one' }, { location: 'slide:3', observation: 'three' }], 4, false);
    const evidence = jevEvidence([input], null);
    expect(evidence.expectedSlides).toBe(4);
    expect(evidence.observedSlides).toBe(2);
    expect(evidence.missingSlides).toEqual([0, 2]);
    expect(evidence.complete).toBe(false);
  });

  test('complete evidence reports complete', () => {
    expect(jevEvidence([deck('v', 3)], { summary: 'S' } as never).complete).toBe(true);
    expect(jevEvidence([deck('v', 3)], null).complete).toBe(true);
  });

  test('sufficient means the question is answerable: a report OR a usable observation', () => {
    expect(jevEvidence([deck('v', 3)], null).sufficient).toBe(true);
    expect(jevEvidence([], { summary: 'S' } as never).sufficient).toBe(true);
    expect(jevEvidence([deck('v', 1)], null).sufficient).toBe(true);
    expect(jevEvidence([], null).sufficient).toBe(false);
  });
});

describe('candidate scenes and overlays are bounded per slide', () => {
  test('every slide is represented and a long scene is flagged', () => {
    const { slides, truncated } = candidateSlides(brief([
      { role: 'hook', scene: 'z'.repeat(1000), overlayText: 'a' },
      { role: 'payoff', scene: 'short scene', overlayText: '' },
    ]));
    expect(slides).toHaveLength(2);
    expect(slides[0]!.role).toBe('hook');
    expect(slides[0]!.scene.length).toBe(400);
    expect(slides[0]!.truncated).toBe(true);
    expect(slides[1]!.truncated).toBe(false);
    expect(truncated).toBe(true);
  });

  test('a cut OVERLAY is a cut instruction and is flagged in its own right', () => {
    // A 900-character overlay used to be cut to 400 and reported as intact,
    // because only the scene was tested for truncation.
    const { slides, truncated } = candidateSlides(brief([
      { role: 'hook', scene: 'short', overlayText: 'y'.repeat(900) },
    ]));
    expect(slides[0]!.overlayText.length).toBe(400);
    expect(slides[0]!.truncated).toBe(false);
    expect(slides[0]!.overlayTruncated).toBe(true);
    expect(truncated).toBe(true);
  });

  test('an intact slide reports no cut at all', () => {
    const { slides, truncated } = candidateSlides(brief([{ role: 'hook', scene: 'short', overlayText: 'short' }]));
    expect(slides[0]!.truncated).toBe(false);
    expect(slides[0]!.overlayTruncated).toBe(false);
    expect(truncated).toBe(false);
  });

  test('a brief with no slides yields no slides rather than throwing', () => {
    expect(candidateSlides(undefined)).toEqual({ slides: [], truncated: false });
  });
});

describe('boundText', () => {
  test('reports the original length and whether it cut', () => {
    expect(boundText('abc', 10)).toEqual({ text: 'abc', truncated: false, chars: 3 });
    expect(boundText('abcdef', 3)).toEqual({ text: 'abc', truncated: true, chars: 6 });
    expect(boundText(null, 3)).toEqual({ text: '', truncated: false, chars: 0 });
  });
});