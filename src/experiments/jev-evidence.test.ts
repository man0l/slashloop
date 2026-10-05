// SLA-510 defect A: the evidence handed to the briefs-stage judge.
//
// The old state gave the judge `original_pattern` (empty whenever the
// independently scheduled report had not landed) and `original_shots` (two
// observations per input, joined and sliced to 800 characters). Slides 3..N were
// simply absent with nothing saying so, and the judge's answer was recorded as
// if it had ranked against the source.
import { describe, expect, test } from 'bun:test';
import { boundText, candidateSlides, jevEvidence, reportEvidence, sourceEvidence } from './jev-evidence.js';
import type { Input } from './schema.js';

const ready = (videoId: string, slides: number, observation = (n: number) => `observation for slide ${n}`): Input =>
  ({ videoId, status: 'ready', analysisId: null, jobId: null, error: null, coverage: null,
    evidence: Array.from({ length: slides }, (_, i) => ({ location: `slide:${i + 1}`, observation: observation(i + 1) })) } as Input);

describe('source evidence covers every slide inside the budget', () => {
  test('a seven-slide source reaches the judge with all seven observations', () => {
    const sources = sourceEvidence([ready('v1', 7)]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.slides.map(s => s.location)).toEqual(['slide:1', 'slide:2', 'slide:3', 'slide:4', 'slide:5', 'slide:6', 'slide:7']);
    expect(sources[0]!.omitted).toBe(0);
  });

  test('every ready source is present, and non-ready inputs are not counted', () => {
    const sources = sourceEvidence([ready('v1', 2), { ...ready('v2', 3), status: 'pending' }, ready('v3', 1)]);
    expect(sources.map(s => s.source)).toEqual(['s0', 's1']);
    expect(sources.map(s => s.videoId)).toEqual(['v1', 'v3']);
  });

  test('slide order is numeric, and non-slide locations are kept verbatim', () => {
    const input = { ...ready('v', 3), evidence: [
      { location: 'slide:10', observation: 'tenth' }, { location: 'second:0', observation: 'segment' }, { location: 'slide:2', observation: 'second' },
    ] } as Input;
    expect(sourceEvidence([input])[0]!.slides.map(s => s.location)).toEqual(['slide:2', 'slide:10', 'second:0']);
  });

  test('a long observation is truncated and the fact is recorded, not hidden', () => {
    const long = 'x'.repeat(900);
    const evidence = jevEvidence([ready('v', 1, () => long)], null);
    const slide = evidence.sources[0]!.slides[0]!;
    expect(slide.observation.length).toBeLessThan(long.length);
    expect(slide.truncated).toBe(true);
    expect(evidence.notes.join(' ')).toContain('truncated');
  });

  test('budget overflow drops entries explicitly and reports the count', () => {
    // 30 observations × 400 chars = 12000 chars over a 6000-char budget.
    const input = { ...ready('v', 1), evidence: Array.from({ length: 30 }, (_, i) => ({ location: `slide:${i + 1}`, observation: 'y'.repeat(400) })) } as Input;
    const evidence = jevEvidence([input], null);
    expect(evidence.sources[0]!.omitted).toBeGreaterThan(0);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toMatch(/dropped to stay inside/);
  });
});

describe('the report is recorded, never awaited', () => {
  test('an absent report is explicit absence, not an empty pattern', () => {
    expect(reportEvidence(null)).toEqual({ status: 'absent', summary: '', truncated: false, chars: 0 });
    const evidence = jevEvidence([ready('v', 3)], null);
    expect(evidence.report.status).toBe('absent');
    expect(evidence.notes.join(' ')).toContain('independently');
  });

  test('a present report contributes its bounded summary', () => {
    const summary = 'r'.repeat(800);
    const evidence = jevEvidence([ready('v', 1)], { summary } as never);
    expect(evidence.report.status).toBe('present');
    expect(evidence.report.chars).toBe(800);
    expect(evidence.report.truncated).toBe(true);
    expect(evidence.report.summary.length).toBe(500);
  });

  test('an empty report summary counts as absent', () => {
    expect(jevEvidence([ready('v', 1)], { summary: '' } as never).report.status).toBe('absent');
  });
});

describe('completeness and sufficiency are stated, not inferred by the caller', () => {
  test('a gap in the middle of a deck is listed', () => {
    const input = { ...ready('v', 1), evidence: [
      { location: 'slide:1', observation: 'one' }, { location: 'slide:3', observation: 'three' },
    ] } as Input;
    const evidence = jevEvidence([input], null);
    expect(evidence.expectedSlides).toBe(3);
    expect(evidence.observedSlides).toBe(2);
    expect(evidence.missingSlides).toEqual([2]);
    expect(evidence.complete).toBe(false);
    expect(evidence.notes.join(' ')).toContain('slide(s) 2');
  });

  test('complete evidence reports complete', () => {
    expect(jevEvidence([ready('v', 3)], { summary: 'S' } as never).complete).toBe(true);
  });

  test('sufficient means the question is answerable: a report OR an observed slide', () => {
    expect(jevEvidence([ready('v', 3)], null).sufficient).toBe(true);
    expect(jevEvidence([], { summary: 'S' } as never).sufficient).toBe(true);
    expect(jevEvidence([ready('v', 1)], null).sufficient).toBe(true);
  });

  test('no report and no ready source slide is explicitly insufficient', () => {
    const evidence = jevEvidence([], null);
    expect(evidence.sufficient).toBe(false);
    expect(evidence.notes).toContain('no ready source input carried evidence.');
    const nonSlide = jevEvidence([{ ...ready('v', 1), evidence: [{ location: 'second:0', observation: 'segment only' }] } as Input], null);
    expect(nonSlide.sufficient).toBe(false);
  });
});

describe('candidate scenes are bounded per slide with a truncation flag', () => {
  test('every slide is represented and a long scene is flagged', () => {
    const scene = 'z'.repeat(1000);
    const { slides, truncated } = candidateSlides({
      concept: '', hook: 'h', character: 'c', visualStyle: '', caption: '', cta: '', lockedConstraints: [],
      slides: [{ role: 'hook', scene, overlayText: 'a' }, { role: 'payoff', scene: 'short scene', overlayText: '' }],
    } as never);
    expect(slides).toHaveLength(2);
    expect(slides[0]!.role).toBe('hook');
    expect(slides[0]!.scene.length).toBe(400);
    expect(slides[0]!.truncated).toBe(true);
    expect(slides[1]!.truncated).toBe(false);
    expect(truncated).toBe(true);
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