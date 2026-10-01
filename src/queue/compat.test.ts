// Handler compatibility: PG rows must deserialize into the same MediaJobRow
// shape processClaimedJob owns — without forking it. Pins the numeric policy
// mirroring AND the kind-expansion parity against the real lib/jobs.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';

// lib/jobs.ts pulls the store/db graph (which auto-inits Postgres when
// DATABASE_URL is set). The parity checks below only need its pure policy
// functions, so the store is left with an empty client — the same reason
// worker-control.test.ts fakes it, and through the same seam.
//
// swapActiveClientForTests, not mock.module('../db.js'): mock.module rewrites
// the process-wide registry shared by every file in a `bun test` run and Bun
// cannot undo it, so a fake installed here outlived this file. See
// docs/test-suite-policy.md.
const restoreStore = swapActiveClientForTests({} as AppPrismaClient);
afterAll(restoreStore);

import {
  expandQueueKinds,
  queueBackoffMs,
  toMediaJobShape,
  QUEUE_CANONICAL_LOCK_TTL_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_REFRESH_COALESCE_MS_DEFAULT,
  QUEUE_YIELD_COOLDOWN_MS,
} from './contract.js';

const {
  CANONICAL_LOCK_TTL_MS,
  expandWorkerKinds,
  MAX_ATTEMPTS,
  refreshCoalesceMs,
  requeueBackoffMs,
  YIELD_COOLDOWN_MS,
} = await import('../lib/jobs.js');

import type { MediaJobRow } from '../lib/jobs.js';

describe('policy parity with lib/jobs.ts (fails first on drift)', () => {
  test('attempts/backoff/yield/lock constants match', () => {
    expect(QUEUE_MAX_ATTEMPTS).toBe(MAX_ATTEMPTS);
    expect(queueBackoffMs(1)).toBe(requeueBackoffMs(1));
    expect(queueBackoffMs(2)).toBe(requeueBackoffMs(2));
    expect(QUEUE_YIELD_COOLDOWN_MS).toBe(YIELD_COOLDOWN_MS);
    expect(QUEUE_CANONICAL_LOCK_TTL_MS).toBe(CANONICAL_LOCK_TTL_MS);
    delete process.env.REFRESH_COALESCE_MS;
    delete process.env.REFRESH_BATCHING_ENABLED;
    expect(QUEUE_REFRESH_COALESCE_MS_DEFAULT).toBe(refreshCoalesceMs());
  });

  test('kind expansion matches expandWorkerKinds', () => {
    const cases: Array<[string[], string | undefined]> = [
      [['refresh'], 'proxy'],
      [['refresh'], 'apify'],
      [['refresh'], undefined],
      [['analyze'], 'proxy'],
      [['analyze', 'refresh'], 'proxy'],
      [['thumb'], 'proxy'],
      [['refresh', 'discover'], 'proxy'],
    ];
    for (const [kinds, provider] of cases) {
      const expected = expandWorkerKinds(kinds, provider);
      const saved = process.env.SCRAPER_PROVIDER;
      try {
        if (provider === undefined) delete process.env.SCRAPER_PROVIDER;
        else process.env.SCRAPER_PROVIDER = provider;
        expect(expandQueueKinds(kinds) as string[]).toEqual(expected);
      } finally {
        if (saved === undefined) delete process.env.SCRAPER_PROVIDER;
        else process.env.SCRAPER_PROVIDER = saved;
      }
    }
  });
});

describe('MediaJobRow shape compatibility', () => {
  test('PG-mapped shape satisfies the full MediaJobRow type', () => {
    const shape = toMediaJobShape({
      job_id: 'a',
      dedupe_key: null,
      kind: 'refresh',
      state: 'running',
      attempts: 1,
      max_attempts: 3,
      claimed_by: 'w',
      lease_expires_at: new Date().toISOString(),
      workspace_id: 'ws',
      video_id: null,
      source_id: 's',
      payload: { limitOverride: 10 },
      result: null,
      op_id: 'op',
      pre_auth_credits: 7,
      deadline_at: new Date().toISOString(),
      analysis_id: null,
      available_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null,
      last_error: null,
      cancel_requested_at: null,
      d1_synced_at: null,
      d1_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // Compile-time: assignable to the processor's row type.
    const asRow: MediaJobRow = shape as MediaJobRow;
    // Runtime: every key the processor reads exists (no undefined holes).
    for (const key of [
      'id',
      'workspaceId',
      'videoId',
      'sourceId',
      'deadlineAt',
      'preAuthCredits',
      'kind',
      'status',
      'attempts',
      'lastError',
      'payloadJson',
      'opId',
      'analysisId',
      'createdAt',
      'startedAt',
      'finishedAt',
      'availableAt',
    ] as const) {
      expect(asRow[key] !== undefined, key).toBe(true);
    }
    // The processor's video-scope guard sees a source-scoped refresh as such.
    expect(asRow.videoId).toBeNull();
    expect(asRow.sourceId).toBe('s');
    // processClaimedJob reads startedAt for the scrape-landed check.
    expect(asRow.startedAt instanceof Date).toBe(true);
  });

  test('video-mode recreate payload survives the mapping (processor guard intact)', () => {
    const shape = toMediaJobShape({
      job_id: 'b',
      dedupe_key: null,
      kind: 'recreate',
      state: 'running',
      attempts: 1,
      max_attempts: 3,
      claimed_by: 'w',
      lease_expires_at: null,
      workspace_id: 'ws',
      video_id: 'v',
      source_id: null,
      payload: { mode: 'video' },
      result: null,
      op_id: 'op',
      pre_auth_credits: 2,
      deadline_at: null,
      analysis_id: null,
      available_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      last_error: null,
      cancel_requested_at: null,
      d1_synced_at: null,
      d1_job_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // Same check the VPS drainer applies before processClaimedJob.
    expect(JSON.parse(shape.payloadJson).mode).toBe('video');
  });
});
