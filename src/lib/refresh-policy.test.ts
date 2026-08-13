// Unit tests for the refresh PLAN — how big a scrape a source actually needs.
//
// The plan is the whole cost lever: it decides how many results we buy from
// Apify and whether we ask for a date filter. Measured over 110 policy-era
// refreshes, capping the page at 5 cut cost per RUN by 84% but cost per NEW
// video by only 20% — 51.6% of what we bought was already in the library.
// The dry-source backoff is aimed at that remainder.
//
// db is stubbed, so these are pure decision tests: no Postgres, no network.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let videoCount = 0;
let recentRuns: Array<{ newVideos: number; itemsPulled: number }> = [];
let newestPostedAt: Date | null = null;

mock.module('../db.js', () => ({
  db: {
    video: {
      count: async () => videoCount,
      findFirst: async () => (newestPostedAt ? { postedAt: newestPostedAt } : null),
    },
    refreshRun: {
      findMany: async ({ take }: { take: number }) => recentRuns.slice(0, take),
    },
  },
}));

const {
  resolveRefreshPlan,
  REFRESH_BOOTSTRAP_CAP,
  REFRESH_INCREMENTAL_CAP,
  REFRESH_INCREMENTAL_DEFAULT,
  REFRESH_DRY_LIMIT,
  REFRESH_DRY_RUN_LOOKBACK,
} = await import('./refresh-policy.js');

const source = (over: Partial<Parameters<typeof resolveRefreshPlan>[0]> = {}) => ({
  id: 'src-1',
  sourceType: 'hashtag',
  videoLimit: 50,
  lastRefreshedAt: new Date(),
  ...over,
});

const productive = (n: number) =>
  Array.from({ length: n }, () => ({ newVideos: 2, itemsPulled: 5 }));
const dry = (n: number) =>
  Array.from({ length: n }, () => ({ newVideos: 0, itemsPulled: 5 }));

beforeEach(() => {
  videoCount = 40;
  recentRuns = productive(REFRESH_DRY_RUN_LOOKBACK);
  newestPostedAt = null;
});

describe('refresh-policy constants', () => {
  test('incremental default is small (new outliers, not full catalogue)', () => {
    expect(REFRESH_INCREMENTAL_DEFAULT).toBeLessThanOrEqual(10);
    expect(REFRESH_INCREMENTAL_DEFAULT).toBeGreaterThanOrEqual(3);
  });

  test('bootstrap cap is larger than incremental but still bounded', () => {
    expect(REFRESH_BOOTSTRAP_CAP).toBeGreaterThan(REFRESH_INCREMENTAL_DEFAULT);
    expect(REFRESH_BOOTSTRAP_CAP).toBeLessThanOrEqual(30);
  });

  test('incremental cap does not exceed bootstrap', () => {
    expect(REFRESH_INCREMENTAL_CAP).toBeLessThanOrEqual(REFRESH_BOOTSTRAP_CAP);
    expect(REFRESH_INCREMENTAL_CAP).toBeGreaterThanOrEqual(REFRESH_INCREMENTAL_DEFAULT);
  });

  test('a dry source buys strictly less than a live one', () => {
    expect(REFRESH_DRY_LIMIT).toBeLessThan(REFRESH_INCREMENTAL_DEFAULT);
    expect(REFRESH_DRY_LIMIT).toBeGreaterThanOrEqual(1);
  });
});

describe('resolveRefreshPlan — page size', () => {
  test('an empty source bootstraps, capped well below its legacy videoLimit', async () => {
    videoCount = 0;
    const plan = await resolveRefreshPlan(source({ videoLimit: 50 }));
    expect(plan.mode).toBe('bootstrap');
    expect(plan.limit).toBe(REFRESH_BOOTSTRAP_CAP);
    expect(plan.dry).toBe(false);
  });

  test('an established source pulls a small incremental page, not its videoLimit', async () => {
    const plan = await resolveRefreshPlan(source({ videoLimit: 50 }));
    expect(plan.mode).toBe('incremental');
    expect(plan.limit).toBe(REFRESH_INCREMENTAL_DEFAULT);
  });

  test('a creator gets a watermark so we stop rebuying the back catalogue', async () => {
    newestPostedAt = new Date('2026-08-10T00:00:00Z');
    const plan = await resolveRefreshPlan(source({ sourceType: 'creator' }));
    expect(plan.postedAfter).toBeInstanceOf(Date);
    // Overlapped backwards so clock skew cannot skip a video at the edge.
    expect(plan.postedAfter!.getTime()).toBeLessThan(newestPostedAt.getTime());
  });

  test('a hashtag gets no watermark — the actor filter is profile-scoped', async () => {
    const plan = await resolveRefreshPlan(source({ sourceType: 'hashtag' }));
    expect(plan.postedAfter).toBeUndefined();
  });
});

describe('resolveRefreshPlan — dry-source backoff', () => {
  test('a source that keeps finding nothing new buys a narrower page', async () => {
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK);
    const plan = await resolveRefreshPlan(source());
    expect(plan.dry).toBe(true);
    expect(plan.limit).toBe(REFRESH_DRY_LIMIT);
    expect(plan.reason).toContain('dry source');
  });

  test('one good run in the window keeps the source at full page', async () => {
    recentRuns = [...dry(REFRESH_DRY_RUN_LOOKBACK - 1), { newVideos: 3, itemsPulled: 5 }];
    const plan = await resolveRefreshPlan(source());
    expect(plan.dry).toBe(false);
    expect(plan.limit).toBe(REFRESH_INCREMENTAL_DEFAULT);
  });

  test('too little history to judge is not dry', async () => {
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK - 1);
    const plan = await resolveRefreshPlan(source());
    expect(plan.dry).toBe(false);
    expect(plan.limit).toBe(REFRESH_INCREMENTAL_DEFAULT);
  });

  test('runs that returned NOTHING AT ALL are a broken source, not a quiet one', async () => {
    // itemsPulled=0 means the actor gave us nothing — a bad handle or a
    // failing run. Narrowing the page neither diagnoses nor fixes that.
    recentRuns = Array.from({ length: REFRESH_DRY_RUN_LOOKBACK }, () => ({ newVideos: 0, itemsPulled: 0 }));
    const plan = await resolveRefreshPlan(source());
    expect(plan.dry).toBe(false);
    expect(plan.limit).toBe(REFRESH_INCREMENTAL_DEFAULT);
  });

  test('a bootstrapping source is never dry — it has no history to be dry about', async () => {
    videoCount = 0;
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK);
    const plan = await resolveRefreshPlan(source());
    expect(plan.dry).toBe(false);
    expect(plan.limit).toBe(REFRESH_BOOTSTRAP_CAP);
  });

  test('the queue passing the policy limit back in does not defeat the backoff', async () => {
    // The queue freezes the resolved limit into the job payload as
    // limitOverride so a concurrent insert cannot change the pre-auth size.
    // Treating that as a user demand would make every queued refresh — i.e.
    // all of them — immune to backoff.
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK);
    const plan = await resolveRefreshPlan(source(), REFRESH_INCREMENTAL_DEFAULT);
    expect(plan.limit).toBe(REFRESH_DRY_LIMIT);
  });

  test('an explicit limit BELOW the dry limit is still honoured', async () => {
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK);
    const plan = await resolveRefreshPlan(source(), 1);
    expect(plan.limit).toBe(1);
  });

  test('backoff never asks Apify for zero results', async () => {
    recentRuns = dry(REFRESH_DRY_RUN_LOOKBACK);
    const plan = await resolveRefreshPlan(source({ videoLimit: 1 }));
    expect(plan.limit).toBeGreaterThanOrEqual(1);
  });
});
