// takeVideoRecreateJob must honour the single-owner claim contract (SLA-16
// Phase 2) like every other D1 claim: only queueOwner='d1' rows whose
// availableAt has elapsed. 'pg' / 'fallback_d1' rows and not-yet-available
// rows must never be taken, on either the queued claim or the resume branch.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realDb from '../db.js';
const REAL_DB = { ...realDb };

afterAll(() => {
  mock.module('../db.js', () => ({ ...REAL_DB }));
});

const seen: {
  sql: string[];
  values: unknown[][];
  findFirstWhere: Record<string, unknown> | undefined;
} = { sql: [], values: [], findFirstWhere: undefined };

mock.module('../db.js', () => ({
  db: {
    $queryRaw: async (...args: unknown[]) => {
      const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
      seen.sql.push(strings.join('?'));
      seen.values.push(values);
      return [];
    },
    $executeRaw: async () => 0,
    mediaJob: {
      findFirst: async (args: { where?: Record<string, unknown> }) => {
        seen.findFirstWhere = args?.where;
        return null;
      },
    },
  },
  dbDialect: () => 'sqlite',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { takeVideoRecreateJob } from './recreate-video-stream.js';

beforeEach(() => {
  seen.sql = [];
  seen.values = [];
  seen.findFirstWhere = undefined;
});

describe('takeVideoRecreateJob claim filters', () => {
  test('queued claim selects only D1-owned rows', async () => {
    await takeVideoRecreateJob();
    expect(seen.sql).toHaveLength(1);
    expect(seen.sql[0]).toContain(`"queueOwner" = 'd1'`);
  });

  test('queued claim skips rows whose availableAt is in the future', async () => {
    const before = Date.now();
    await takeVideoRecreateJob();
    expect(seen.sql[0]).toContain(`("availableAt" IS NULL OR "availableAt" <= ?)`);
    const dates = seen.values[0].filter((v): v is Date => v instanceof Date);
    // startedAt and the availableAt bound share one clock reading
    expect(dates).toHaveLength(2);
    expect(dates[0].getTime()).toBe(dates[1].getTime());
    expect(dates[1].getTime()).toBeGreaterThanOrEqual(before);
    expect(dates[1].getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('resume branch only resumes D1-owned running rows', async () => {
    await takeVideoRecreateJob();
    expect(seen.findFirstWhere).toMatchObject({
      kind: 'recreate',
      status: 'running',
      queueOwner: 'd1',
    });
  });
});
