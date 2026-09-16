// Pure-function test for pickChangedScores (scoring.ts) — the D1 write-budget
// guard that stops repeat rescores from re-stamping unchanged Score rows.
// No db mock needed: the function is pure, so this file is safe anywhere in
// the run order (see rescore-stale.test.ts for why that matters).
import { describe, expect, test } from 'bun:test';
import { pickChangedScores, type ScoreResult, type StoredScore } from '../scoring.js';

const score = (videoId: string, outlierScore: number, explanation = 'same'): ScoreResult => ({
  videoId,
  outlierScore,
  scoreType: 'actual',
  explanation,
});

const stored = (r: ScoreResult): StoredScore => ({
  videoId: r.videoId,
  outlierScore: r.outlierScore,
  scoreType: r.scoreType,
  explanation: r.explanation,
});

describe('pickChangedScores — skip unchanged score writes', () => {
  test('a fully unchanged batch writes nothing', () => {
    const results = [score('v1', 1.5), score('v2', 3.2)];
    const existing = results.map(stored);
    expect(pickChangedScores(results, existing)).toEqual([]);
  });

  test('new videos (no stored row) are always written', () => {
    const results = [score('v1', 1.5)];
    expect(pickChangedScores(results, [])).toEqual(results);
  });

  test('any of the three columns moving triggers exactly that row', () => {
    const r1 = score('v1', 1.5);
    const r2 = score('v2', 3.2);
    const r3 = score('v3', 5.0);

    const scoreMoved = pickChangedScores([r1], [stored({ ...r1, outlierScore: 1.4 })]);
    expect(scoreMoved).toEqual([r1]);

    const typeMoved = pickChangedScores([r2], [stored({ ...r2, scoreType: 'estimated' })]);
    expect(typeMoved).toEqual([r2]);

    const explanationMoved = pickChangedScores([r3], [stored({ ...r3, explanation: 'old' })]);
    expect(explanationMoved).toEqual([r3]);
  });

  test('changed and unchanged rows in one batch are separated, not conflated', () => {
    const unchanged = score('v1', 1.5);
    const changed = score('v2', 3.2);
    const out = pickChangedScores([unchanged, changed], [stored(unchanged)]);
    expect(out).toEqual([changed]);
  });
});
