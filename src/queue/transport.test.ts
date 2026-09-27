// Per-kind queue transport controls (SLA-16 Phase 2).
// No database: the WorkerControl read is stubbed via mock.module.
import { describe, expect, mock, test } from 'bun:test';

let controlRows: Record<string, string | undefined> = {};

mock.module('../db.js', () => ({
  db: {
    workerControl: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = controlRows[where.key];
        return value === undefined ? null : { key: where.key, value };
      },
    },
  },
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import {
  defaultQueueTransport,
  getQueueTransport,
  isEmergencyD1Override,
  isKnownQueueKind,
  queueTransportKey,
  resetTransportCacheForTests,
} from './transport.js';

function reset(env: Record<string, string | undefined>, rows: Record<string, string | undefined>) {
  resetTransportCacheForTests();
  controlRows = { ...rows };
  return env;
}

describe('queue transport controls', () => {
  test('missing control inherits QUEUE_BACKEND, default d1', async () => {
    const env = reset({ QUEUE_BACKEND: undefined }, {});
    expect(await getQueueTransport('thumb', { env: env as NodeJS.ProcessEnv })).toBe('d1');
    expect(defaultQueueTransport(env as NodeJS.ProcessEnv)).toBe('d1');
  });

  test('per-kind pg control wins over default d1', async () => {
    const env = reset({ QUEUE_BACKEND: undefined }, { 'queue.transport.thumb': 'pg' });
    expect(await getQueueTransport('thumb', { env: env as NodeJS.ProcessEnv })).toBe('pg');
    // Other kinds stay on the default.
    expect(await getQueueTransport('fetch', { env: env as NodeJS.ProcessEnv })).toBe('d1');
  });

  test('invalid control value falls back to QUEUE_BACKEND', async () => {
    const env = reset({ QUEUE_BACKEND: 'pg' }, { 'queue.transport.fetch': 'kafka' });
    expect(await getQueueTransport('fetch', { env: env as NodeJS.ProcessEnv })).toBe('pg');
  });

  test('QUEUE_BACKEND=d1 is the emergency override over per-kind pg', async () => {
    const env = reset({ QUEUE_BACKEND: 'd1' }, { 'queue.transport.thumb': 'pg' });
    expect(isEmergencyD1Override(env as NodeJS.ProcessEnv)).toBe(true);
    expect(await getQueueTransport('thumb', { env: env as NodeJS.ProcessEnv })).toBe('d1');
  });

  test('unset QUEUE_BACKEND is not an emergency override', async () => {
    const env = reset({ QUEUE_BACKEND: undefined }, { 'queue.transport.thumb': 'pg' });
    expect(isEmergencyD1Override(env as NodeJS.ProcessEnv)).toBe(false);
    expect(await getQueueTransport('thumb', { env: env as NodeJS.ProcessEnv })).toBe('pg');
  });

  test('jobs.<kind>.enabled kill switch keys are untouched', () => {
    // Transport keys live in a separate namespace; the existing kill switch
    // (filterKindsByControl) keeps working independently.
    expect(queueTransportKey('thumb')).toBe('queue.transport.thumb');
    expect(queueTransportKey('thumb')).not.toBe('jobs.thumb.enabled');
  });

  test('kind vocabulary matches the contract', () => {
    expect(isKnownQueueKind('refresh')).toBe(true);
    expect(isKnownQueueKind('bogus')).toBe(false);
  });
});
