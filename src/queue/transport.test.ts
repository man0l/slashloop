// Per-kind queue transport controls (SLA-16 Phase 2).
// No database: the WorkerControl read is stubbed via mock.module.
import { afterAll, describe, expect, test } from 'bun:test';
import { swapActiveClientForTests, type AppPrismaClient } from '../store.js';

let controlRows: Record<string, string | undefined> = {};

// swapActiveClientForTests, not mock.module('../db.js'): mock.module rewrites
// the process-wide registry shared by every file in a `bun test` run and Bun
// cannot undo it, so a fake installed here outlived this file. See
// docs/test-suite-policy.md.
const restoreStore = swapActiveClientForTests({
  workerControl: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = controlRows[where.key];
      return value === undefined ? null : { key: where.key, value };
    },
  },
} as unknown as AppPrismaClient);
afterAll(restoreStore);

import {
  defaultQueueTransport,
  getQueueD1ProjectionMode,
  getQueueFallbackEnabled,
  getQueueTransport,
  isEmergencyD1Override,
  isKnownQueueKind,
  partitionKindsByTransport,
  queueTransportKey,
  resetTransportCacheForTests,
  shouldMirrorLifecycleToD1,
  shouldRunD1RecoverySweeps,
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

  test('fallback defaults off and WorkerControl 1 enables it', async () => {
    const env = reset({ QUEUE_FALLBACK_ENABLED: undefined }, {});
    expect(await getQueueFallbackEnabled({ env: env as NodeJS.ProcessEnv })).toBe(false);
    const on = reset({ QUEUE_FALLBACK_ENABLED: undefined }, { 'queue.fallback.enabled': '1' });
    expect(await getQueueFallbackEnabled({ env: on as NodeJS.ProcessEnv })).toBe(true);
    const envOff = reset({ QUEUE_FALLBACK_ENABLED: '0' }, { 'queue.fallback.enabled': '1' });
    expect(await getQueueFallbackEnabled({ env: envOff as NodeJS.ProcessEnv })).toBe(false);
    const envOn = reset({ QUEUE_FALLBACK_ENABLED: '1' }, {});
    expect(await getQueueFallbackEnabled({ env: envOn as NodeJS.ProcessEnv })).toBe(true);
  });

  test('D1 projection defaults to terminal and env wins over the control row', async () => {
    const env = reset({ QUEUE_D1_PROJECTION: undefined }, {});
    expect(await getQueueD1ProjectionMode({ env: env as NodeJS.ProcessEnv })).toBe('terminal');
    const row = reset({ QUEUE_D1_PROJECTION: undefined }, { 'queue.d1.projection': 'full' });
    expect(await getQueueD1ProjectionMode({ env: row as NodeJS.ProcessEnv })).toBe('full');
    const off = reset({ QUEUE_D1_PROJECTION: undefined }, { 'queue.d1.projection': 'off' });
    expect(await getQueueD1ProjectionMode({ env: off as NodeJS.ProcessEnv })).toBe('off');
    const bogus = reset({ QUEUE_D1_PROJECTION: undefined }, { 'queue.d1.projection': 'sometimes' });
    expect(await getQueueD1ProjectionMode({ env: bogus as NodeJS.ProcessEnv })).toBe('terminal');
    const override = reset({ QUEUE_D1_PROJECTION: 'full' }, { 'queue.d1.projection': 'off' });
    expect(await getQueueD1ProjectionMode({ env: override as NodeJS.ProcessEnv })).toBe('full');
  });

  test('terminal projection keeps done/failed and drops yield plus non-terminal fail', () => {
    expect(shouldMirrorLifecycleToD1('terminal', 'complete', true)).toBe(true);
    expect(shouldMirrorLifecycleToD1('terminal', 'fail', true)).toBe(true);
    expect(shouldMirrorLifecycleToD1('terminal', 'fail', false)).toBe(false);
    expect(shouldMirrorLifecycleToD1('terminal', 'yield', false)).toBe(false);
    expect(shouldMirrorLifecycleToD1('full', 'yield', false)).toBe(true);
    expect(shouldMirrorLifecycleToD1('full', 'fail', false)).toBe(true);
    expect(shouldMirrorLifecycleToD1('off', 'complete', true)).toBe(false);
    expect(shouldMirrorLifecycleToD1('off', 'fail', true)).toBe(false);
  });

  test('D1 recovery sweeps run for a d1 kind or when projection mode is full', () => {
    expect(shouldRunD1RecoverySweeps('terminal', 0)).toBe(false);
    expect(shouldRunD1RecoverySweeps('off', 0)).toBe(false);
    expect(shouldRunD1RecoverySweeps('full', 0)).toBe(true);
    expect(shouldRunD1RecoverySweeps('terminal', 1)).toBe(true);
    expect(shouldRunD1RecoverySweeps('off', 2)).toBe(true);
  });

  test('partitionKindsByTransport splits per-kind ownership', async () => {
    const env = reset({ QUEUE_BACKEND: undefined }, { 'queue.transport.thumb': 'pg' });
    const { d1, pg } = await partitionKindsByTransport(['thumb', 'fetch', 'rescore'], {
      env: env as NodeJS.ProcessEnv,
    });
    expect(pg).toEqual(['thumb']);
    expect(d1).toEqual(['fetch', 'rescore']);
  });
});
