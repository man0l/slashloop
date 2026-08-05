// Unit tests for the pure HTTP mapping of analyze outcomes — no DB, no Gemini.
// The point of mapAnalyzeOutcomeToHttp existing as a pure function is exactly
// that the REST route's error semantics (402/429/422) are testable offline.
import { describe, expect, test } from 'bun:test';
import { mapAnalyzeOutcomeToHttp, type AnalyzeVideoOutcome } from './video-service.js';
import type { MediaJobRow } from './jobs.js';

const fakeJob = {
  id: 'job-1',
  workspaceId: 'ws-1',
  videoId: 'vid-1',
  sourceId: null,
  deadlineAt: null,
  preAuthCredits: null,
  kind: 'analyze',
  status: 'queued',
  attempts: 0,
  lastError: null,
  payloadJson: '{}',
  opId: null,
  analysisId: null,
  createdAt: new Date(),
  startedAt: null,
  finishedAt: null,
} as unknown as MediaJobRow;

describe('mapAnalyzeOutcomeToHttp — failures', () => {
  test('not_found -> 404 video_not_found', () => {
    const o: AnalyzeVideoOutcome = { ok: false, errorCode: 'not_found', error: 'Video not found.', creditsCharged: 0, creditsRemaining: 30 };
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'video_not_found' });
  });

  test('insufficient_credits -> 402 with required/remaining/upgradeUrl', () => {
    const o: AnalyzeVideoOutcome = { ok: false, errorCode: 'insufficient_credits', error: 'needs 5, has 2', required: 5, creditsCharged: 0, creditsRemaining: 2 };
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: 'insufficient_credits', required: 5, remaining: 2 });
    expect(r.body.upgradeUrl).toBeTypeOf('string');
  });

  test('gemini_quota -> 429 gun quota_exhausted, retryable, not charged', () => {
    const o: AnalyzeVideoOutcome = { ok: false, errorCode: 'gemini_quota', error: 'Gemini ... (429): RESOURCE_EXHAUSTED', creditsCharged: 0, creditsRemaining: 27 };
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'gemini_quota_exhausted', retryable: true, errorCode: 'gemini_quota', creditsCharged: 0, creditsRemaining: 27 });
    // The frontend gets a friendly message, the raw detail stays separate.
    expect(String(r.body.message).toLowerCase()).toContain('credits');
    expect(String(r.body.detail)).toContain('RESOURCE_EXHAUSTED');
  });

  test('gemini_rate_limit -> 429 gun_rate_limited', () => {
    const o: AnalyzeVideoOutcome = { ok: false, errorCode: 'gemini_rate_limit', error: 'RATE_LIMIT_EXCEEDED', creditsCharged: 0, creditsRemaining: 27 };
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('gemini_rate_limited');
    expect(r.body.retryable).toBe(true);
  });

  test('gemini_server / gemini_timeout -> 429 transient error', () => {
    for (const errorCode of ['gemini_server', 'gemini_timeout']) {
      const o: AnalyzeVideoOutcome = { ok: false, errorCode, error: 'upstream', creditsCharged: 0, creditsRemaining: 27 };
      const r = mapAnalyzeOutcomeToHttp(o);
      expect(r.status).toBe(429);
      expect(r.body.error).toBe('gemini_transient_error');
      expect(r.body.retryable).toBe(true);
    }
  });

  test('auth / request / other -> 422 analyze_failed (not retryable) ', () => {
    for (const errorCode of ['gemini_auth', 'gemini_request', 'other']) {
      const o: AnalyzeVideoOutcome = { ok: false, errorCode, error: 'nope', creditsCharged: 0, creditsRemaining: 27 };
      const r = mapAnalyzeOutcomeToHttp(o);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: 'analyze_failed', errorCode, creditsCharged: 0, creditsRemaining: 27 });
    }
  });
});

describe('mapAnalyzeOutcomeToHttp — successes', () => {
  test('queued (gemini-native) -> 200 with jobId + status', () => {
    const o: AnalyzeVideoOutcome = { ok: true, queued: true, job: fakeJob, dispatched: true, backend: 'gemini-native', creditsCharged: 5, creditsRemaining: 25 };
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queued: true, jobId: 'job-1', status: 'queued', backend: 'gemini-native', creditsCharged: 5, creditsRemaining: 25 });
  });

  test('inline (gemini-text) -> 200 with analysis', () => {
    // The full VideoAnalysisData shape is irrelevant here — the mapper only
    // reads a few fields on the result, so stand in with a minimal fake.
    const o = {
      ok: true, queued: false,
      result: { id: 'a-1', analysis: { some: 'data' }, analysisBasis: 'transcript-only', confidence: 0.6 as const, backend: 'gemini-text', model: 'gemini-3.5-flash', costCents: 0.2 },
      creditsCharged: 5, creditsRemaining: 20,
    } as unknown as AnalyzeVideoOutcome;
    const r = mapAnalyzeOutcomeToHttp(o);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queued: false, analysisBasis: 'transcript-only', backend: 'gemini-text', model: 'gemini-3.5-flash', creditsCharged: 5, creditsRemaining: 20 });
    expect(r.body.analysis).toEqual({ some: 'data' });
  });
});
