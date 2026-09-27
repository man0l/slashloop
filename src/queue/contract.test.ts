// Fast unit tests: contract parity, targets, dedupe keys, error envelope.
// No database.
import { describe, expect, test } from 'bun:test';
import {
  dedupeKeyFor,
  expandQueueKinds,
  fallbackDedupeKey,
  normalizeKindList,
  queueBackoffMs,
  queueError,
  toJobStatus,
  toMediaJobShape,
  validateJobTargets,
  QUEUE_ABANDONED_AFTER_MINUTES,
  QUEUE_BODY_MAX_BYTES,
  QUEUE_CANONICAL_LOCK_TTL_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_REFRESH_COALESCE_MS_DEFAULT,
  QUEUE_STUCK_AFTER_MINUTES,
  QUEUE_YIELD_COOLDOWN_MS,
  type PgQueueJobRow,
} from './contract.js';

function pgRow(over: Partial<PgQueueJobRow> = {}): PgQueueJobRow {
  const now = new Date().toISOString();
  return {
    job_id: '11111111-1111-4111-8111-111111111111',
    dedupe_key: 'analyze:video:v1',
    kind: 'analyze',
    state: 'queued',
    attempts: 0,
    max_attempts: 3,
    claimed_by: null,
    lease_expires_at: null,
    workspace_id: 'ws1',
    video_id: 'v1',
    source_id: null,
    payload: { forceBackend: 'openrouter-video' },
    result: null,
    op_id: 'op-1',
    pre_auth_credits: 5,
    deadline_at: null,
    analysis_id: null,
    available_at: now,
    started_at: null,
    finished_at: null,
    last_error: null,
    cancel_requested_at: null,
    d1_synced_at: null,
    d1_job_id: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe('queue policy constants mirror lib/jobs.ts (compat pins the values)', () => {
  test('attempts, backoff, cooldowns, sweeps', () => {
    expect(QUEUE_MAX_ATTEMPTS).toBe(3);
    expect(queueBackoffMs(1)).toBe(2 * 60_000);
    expect(queueBackoffMs(2)).toBe(8 * 60_000);
    expect(queueBackoffMs(3)).toBe(8 * 60_000);
    expect(QUEUE_YIELD_COOLDOWN_MS).toBe(60_000);
    expect(QUEUE_STUCK_AFTER_MINUTES).toBe(15);
    expect(QUEUE_ABANDONED_AFTER_MINUTES).toBe(90);
    expect(QUEUE_REFRESH_COALESCE_MS_DEFAULT).toBe(30_000);
    expect(QUEUE_CANONICAL_LOCK_TTL_MS).toBe(10 * 60_000);
    expect(QUEUE_BODY_MAX_BYTES).toBe(64 * 1024);
  });
});

describe('normalizeKindList', () => {
  test('allowlist + dedupe, rejects injection', () => {
    expect(normalizeKindList(['refresh', 'refresh', 'bogus', "x'; DROP TABLE"])).toEqual(['refresh']);
    expect(normalizeKindList([])).toEqual([]);
    expect(normalizeKindList(['ANALYZE'])).toEqual([]);
  });
});

describe('expandQueueKinds parity with expandWorkerKinds', () => {
  test('refresh pulls discover on proxy only; analyze pulls recreate', () => {
    expect(expandQueueKinds(['refresh'], 'proxy')).toEqual(['refresh', 'discover']);
    expect(expandQueueKinds(['refresh'], 'apify')).toEqual(['refresh']);
    expect(expandQueueKinds(['analyze'], 'proxy')).toEqual(['analyze', 'recreate']);
    expect(expandQueueKinds(['thumb'], 'proxy')).toEqual(['thumb']);
  });
});

describe('validateJobTargets matrix', () => {
  test('discover null/null; refresh source-only; others video-only', () => {
    expect(validateJobTargets('discover', null, null)).toBeNull();
    expect(validateJobTargets('discover', 'v', null)).not.toBeNull();
    expect(validateJobTargets('discover', null, 's')).not.toBeNull();
    expect(validateJobTargets('refresh', null, 's')).toBeNull();
    expect(validateJobTargets('refresh', 'v', 's')).not.toBeNull();
    expect(validateJobTargets('refresh', null, null)).not.toBeNull();
    for (const kind of ['fetch', 'analyze', 'recreate', 'thumb', 'rescore']) {
      expect(validateJobTargets(kind, 'v', null)).toBeNull();
      expect(validateJobTargets(kind, null, 's')).not.toBeNull();
      expect(validateJobTargets(kind, null, null)).not.toBeNull();
      expect(validateJobTargets(kind, 'v', 's')).not.toBeNull();
    }
  });
});

describe('dedupe keys', () => {
  test('deterministic convention + D1 fallback stability', () => {
    expect(dedupeKeyFor('analyze', 'v1', null)).toBe('analyze:video:v1');
    expect(dedupeKeyFor('refresh', null, 's1')).toBe('refresh:source:s1');
    expect(fallbackDedupeKey('abc')).toBe('d1:abc');
    expect(fallbackDedupeKey('abc')).toBe(fallbackDedupeKey('abc'));
  });
});

describe('toMediaJobShape', () => {
  test('carries every field processClaimedJob reads', () => {
    const shape = toMediaJobShape(pgRow());
    expect(shape.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(shape.workspaceId).toBe('ws1');
    expect(shape.videoId).toBe('v1');
    expect(shape.sourceId).toBeNull();
    expect(shape.kind).toBe('analyze');
    expect(shape.status).toBe('queued');
    expect(shape.attempts).toBe(0);
    expect(shape.opId).toBe('op-1');
    expect(shape.preAuthCredits).toBe(5);
    expect(JSON.parse(shape.payloadJson)).toEqual({ forceBackend: 'openrouter-video' });
    expect(shape.createdAt instanceof Date).toBe(true);
    expect(shape.availableAt instanceof Date).toBe(true);
    expect(shape.startedAt).toBeNull();
  });

  test('string payloads pass through verbatim', () => {
    const shape = toMediaJobShape(pgRow({ payload: '{"mode":"video"}' }));
    expect(shape.payloadJson).toBe('{"mode":"video"}');
  });
});

describe('toJobStatus', () => {
  test('queue-safe fields only', () => {
    const status = toJobStatus(pgRow({ state: 'running', attempts: 1 }));
    expect(status).toEqual({
      jobId: '11111111-1111-4111-8111-111111111111',
      kind: 'analyze',
      state: 'running',
      attempts: 1,
      availableAt: expect.any(String),
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      lastError: null,
    });
    expect('payload' in status).toBe(false);
    expect('opId' in status).toBe(false);
  });
});

describe('error envelope', () => {
  test('shape + retryability classification', () => {
    expect(queueError('invalid_target', 'bad')).toEqual({
      error: { code: 'invalid_target', message: 'bad', retryable: false, jobId: null },
    });
    expect(queueError('rate_limited', 'slow', 'j1').error.retryable).toBe(true);
    expect(queueError('queue_unavailable', 'down').error.retryable).toBe(true);
    expect(queueError('replay_detected', 'again').error.retryable).toBe(false);
    expect(queueError('unauthenticated', 'no').error.retryable).toBe(false);
  });
});
