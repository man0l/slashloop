// SLA-511: a requeued slide must stop presenting a failure that is no longer
// happening, and must not lose the evidence of the attempt that did fail.
//
// The defect: retry cleared the JOB error and set `slides[i].status='pending'`,
// but left the slide's own `error` and its `qa` audit in place. The result was
// a slide that was simultaneously queued and failing with a timeout from an
// attempt that had already been refunded — and any consumer reading `qa` saw a
// fresh verdict for work that had not run yet.
//
// The transition is `applyRetry`, pure with respect to the experiment, so it is
// asserted here without a store: no provider call, no credit, no clock.
import { describe, expect, test } from 'bun:test';
import { applyRetry } from './service.js';
import { QA_HISTORY_LIMIT, type BriefData, type Experiment, type SlideQaRecord } from './schema.js';

const instructions = { goal: 'Sell tea', brand: 'Tea', audience: 'Adults', language: 'English', direction: 'Calm', lockedConstraints: [], variables: ['hook' as const], mode: 'controlled' as const };
const brief: BriefData = {
  concept: 'Tea routine', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: 'Tea time',
  cta: '', lockedConstraints: [],
  slides: [{ role: 'hook', scene: 'A steaming cup', overlayText: 'Take a break' }, { role: 'body', scene: 'Hands holding the cup', overlayText: 'Breathe' }, { role: 'end', scene: 'Empty cup', overlayText: '' }],
};
/** The QA audit the SLA-508 investigation read off production: an unverifiable
 *  slide, no checks, no deliverable, charge refunded. */
const timedOutQa = (): SlideQaRecord => ({
  verdict: 'error', contractHash: '1570b5ae5ed454cd985a7653dc30efbe', corrected: false, attempts: 1,
  reasons: ['story_check_error:The operation timed out.'], checks: [],
  diagnostics: { model: 'x-ai/grok-4.6', timeoutMs: 90_000, reasoningEffort: 'low', maxTokens: 1336, checksRequested: 15, elapsedMs: 90_004, outcome: 'error', errorCategory: 'timeout' },
});
const passedQa = (): SlideQaRecord => ({
  verdict: 'pass', contractHash: 'aaa', corrected: false, attempts: 1, reasons: [],
  checks: [{ check: 'the overlay matches exactly', status: 'pass' }],
});

/** Three slides on one variant: one timed out (retryable), one completed, one
 *  still queued; plus a second variant slide that failed and was NOT retried. */
function fixture(): Experiment {
  const slide = (index: number, over: Record<string, unknown>) => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: '', ...over });
  const v = {
    id: 'v1', revision: 1, status: 'failed', title: 'B', hypothesis: 'h', changedVariables: [],
    brief, frozenBrief: brief, generationBasis: 'text-directed' as const, history: [],
    error: 'provider_outcome_unknown:story_unverified',
    slides: [
      slide(0, { status: 'unknown', error: 'provider_outcome_unknown:story_unverified:story_check_error:The operation timed out.', qa: timedOutQa() }),
      slide(1, { status: 'done', url: 'https://thumbs.test/p/1.jpg', path: 'p/1.jpg', qa: passedQa() }),
      slide(2, { status: 'pending' }),
    ],
  };
  const w = { ...v, id: 'v2', status: 'failed', slides: [slide(0, { status: 'failed', error: 'provider_result_rejected:story_check_failed:overlay cropped', qa: { ...passedQa(), verdict: 'fail' as const, reasons: ['overlay cropped'] } })] };
  return {
    id: 'e', workspaceId: 'w', status: 'failed', version: 3, createdAt: '', updatedAt: '', instructions,
    variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 24, report: { summary: 'S' }, inputs: [],
    variants: [v, w], error: 'provider_outcome_unknown:story_unverified', generationBasis: 'text-directed',
    assetPolicy: 'retained',
    tasks: [
      { id: 'j0', kind: 'slide', target: 'v1', index: 0, status: 'unknown', attempts: 1, charged: 0, error: 'provider_outcome_unknown:story_unverified', nextAttemptAt: 999 },
      { id: 'j1', kind: 'slide', target: 'v1', index: 1, status: 'done', attempts: 1, charged: 10 },
      { id: 'j2', kind: 'slide', target: 'v1', index: 2, status: 'pending', attempts: 0, charged: 0 },
      { id: 'k0', kind: 'slide', target: 'v2', index: 0, status: 'failed', attempts: 2, charged: 10, error: 'provider_result_rejected:story_check_failed' },
    ],
    commands: {}, allowPartial: false, createFingerprint: 'x',
  } as unknown as Experiment;
}
const task = (e: Experiment, id: string) => e.tasks.find(t => t.id === id)!;

describe('retrying a slide clears the active failure and keeps the history', () => {
  test('the requeued slide is pending with no active error and no live QA', () => {
    const e = fixture();
    const prior = { ...e.variants[0]!.slides[0]!.qa!, prompt: 'the render prompt issued for that attempt' };
    e.variants[0]!.slides[0]!.qa = prior;
    applyRetry(e, [task(e, 'j0')]);

    const slide = e.variants[0]!.slides[0]!;
    expect(slide.status).toBe('pending');
    // The stale failure is gone: this attempt has not run, so it has not failed.
    expect(slide.error).toBeNull();
    expect(slide.qa ?? null).toBeNull();
    // Nothing is invented either: the queued slide has no verdict to show.
    expect(slide.qaHistory).toHaveLength(1);
    // The prior attempt survives, labelled as history, with its diagnostics —
    // minus the render prompt, so a repeatedly retried slide cannot grow the
    // stored document without bound.
    const { prompt: _prompt, ...record } = prior;
    expect(slide.qaHistory![0]).toEqual(record);
    expect('prompt' in slide.qaHistory![0]!).toBe(false);
    expect(slide.qaHistory![0]!.diagnostics?.errorCategory).toBe('timeout');

    // The job is requeued: error and backoff cleared, attempt count kept so the
    // manual-retry ceiling still applies, and no re-charge of the receipt.
    expect(task(e, 'j0')).toMatchObject({ status: 'pending', attempts: 1, charged: 0 });
    expect(task(e, 'j0').error).toBeUndefined();
    expect(task(e, 'j0').nextAttemptAt).toBeUndefined();
    // The variant is generating again, with its own error cleared.
    expect(e.variants[0]).toMatchObject({ status: 'generating', error: null });
  });

  test('completed slides and their verdicts are untouched', () => {
    const e = fixture();
    const done = structuredClone(e.variants[0]!.slides[1]!);
    applyRetry(e, [task(e, 'j0')]);
    expect(e.variants[0]!.slides[1]).toEqual(done);
    expect(e.variants[0]!.slides[1]!.qa?.verdict).toBe('pass');
    expect(e.variants[0]!.slides[1]!.qaHistory).toBeUndefined();
    // A completed job stays done and keeps its charge: a retry re-prices work,
    // it does not re-settle finished work.
    expect(task(e, 'j1')).toMatchObject({ status: 'done', charged: 10 });
  });

  test('slides outside the retry keep their failure and their audit', () => {
    const e = fixture();
    applyRetry(e, [task(e, 'j0')]);
    const other = e.variants[1]!.slides[0]!;
    expect(other.status).toBe('failed');
    expect(other.error).toBe('provider_result_rejected:story_check_failed:overlay cropped');
    expect(other.qa).toMatchObject({ verdict: 'fail', reasons: ['overlay cropped'] });
    expect(e.variants[1]).toMatchObject({ status: 'failed' });
    // A slide with no prior QA gets no invented history entry.
    expect(e.variants[0]!.slides[2]!.qaHistory).toBeUndefined();
    expect(e.variants[0]!.slides[2]!.error).toBeNull();
  });

  test('repeated retries accumulate history, bounded, newest last', () => {
    const e = fixture();
    applyRetry(e, [task(e, 'j0')]);
    // The second attempt fails too, and is retried again.
    e.variants[0]!.slides[0]!.qa = { ...timedOutQa(), reasons: ['story_check_error:rate limited'] };
    applyRetry(e, [task(e, 'j0')]);
    e.variants[0]!.slides[0]!.qa = { ...timedOutQa(), reasons: ['story_check_error:server error'] };
    applyRetry(e, [task(e, 'j0')]);
    const history = e.variants[0]!.slides[0]!.qaHistory!;
    expect(history).toHaveLength(QA_HISTORY_LIMIT);
    // Newest last, oldest dropped once the cap is reached.
    expect(history.map(r => r.reasons[0])).toEqual([
      'story_check_error:The operation timed out.',
      'story_check_error:rate limited',
      'story_check_error:server error',
    ]);
    expect(e.variants[0]!.slides[0]!.qa).toBeNull();
    expect(e.variants[0]!.slides[0]!.error).toBeNull();

    // A fourth round keeps only the most recent three.
    e.variants[0]!.slides[0]!.qa = { ...timedOutQa(), reasons: ['story_check_error:fourth'] };
    applyRetry(e, [task(e, 'j0')]);
    expect(e.variants[0]!.slides[0]!.qaHistory!.map(r => r.reasons[0])).toEqual([
      'story_check_error:rate limited', 'story_check_error:server error', 'story_check_error:fourth',
    ]);
  });

  test('a slide index the retry does not name is never reset', () => {
    const e = fixture();
    e.variants[0]!.slides[1]!.status = 'failed';
    e.variants[0]!.slides[1]!.error = 'provider_result_rejected:later failure';
    applyRetry(e, [task(e, 'j0')]);
    expect(e.variants[0]!.slides[1]).toMatchObject({ status: 'failed', error: 'provider_result_rejected:later failure' });
  });
});