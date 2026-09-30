import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  failedBatchJson,
  generatingBatchJson,
  logicalGeneratedHookId,
  logicalHookBatchId,
  readStoredHookBatch,
  readyBatchJson,
  toHookBatchListItem,
} from './hook-delivery.js';

const base = {
  workspaceId: 'w',
  hookIds: ['b', 'a'],
  productDescription: 'A notes app for founders',
};

describe('logicalHookBatchId', () => {
  test('identical inputs share an id, and order and whitespace do not mint a new one', () => {
    const id = logicalHookBatchId(base);
    expect(id).toBe(logicalHookBatchId({ ...base, hookIds: ['a', 'b', 'a'] }));
    expect(id).toBe(logicalHookBatchId({ ...base, productDescription: '  A notes app   for founders  ' }));
    expect(logicalHookBatchId({ ...base, productDescription: 'A different app' })).not.toBe(id);
    expect(logicalHookBatchId({ ...base, workspaceId: 'other' })).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('child ids are stable per batch index and do not collide with the batch', () => {
    const batchId = logicalHookBatchId(base);
    const first = logicalGeneratedHookId(batchId, 0);
    expect(first).toBe(logicalGeneratedHookId(batchId, 0));
    expect(logicalGeneratedHookId(batchId, 1)).not.toBe(first);
    expect(first).not.toBe(batchId);
  });
});

describe('readStoredHookBatch', () => {
  test('parses the reservation sentinels and a ready payload', () => {
    expect(readStoredHookBatch(generatingBatchJson('2026-09-30T11:00:00.000Z'))).toEqual({
      status: 'generating',
      since: '2026-09-30T11:00:00.000Z',
    });
    expect(readStoredHookBatch(failedBatchJson('model down'))).toEqual({
      status: 'failed',
      error: 'model down',
    });
    const variations = [{
      id: 'h1',
      text: 'Your notes are the bottleneck',
      sourceIndex: 0,
      type: 'curiosity_gap',
      mechanism: 'names the pain',
    }];
    expect(readStoredHookBatch(readyBatchJson(variations))).toEqual({ status: 'ready', variations });
    expect(readStoredHookBatch('not-json').status).toBe('unreadable');
    expect(readStoredHookBatch(JSON.stringify({ status: 'ready', variations })).status).toBe('unreadable');
  });

  test('list items expose the reserved id and the saved variations', () => {
    const createdAt = new Date('2026-09-30T11:00:00.000Z');
    const variations = [{
      id: 'h1',
      text: 'Your notes are the bottleneck',
      sourceIndex: 0,
      type: 'curiosity_gap',
      mechanism: 'names the pain',
    }];
    expect(toHookBatchListItem({
      id: 'batch-1',
      videoId: 'v1',
      analysisId: 'a1',
      createdAt,
      text: readyBatchJson(variations),
    })).toEqual({
      id: 'batch-1',
      batchId: 'batch-1',
      videoId: 'v1',
      analysisId: 'a1',
      createdAt: '2026-09-30T11:00:00.000Z',
      status: 'ready',
      variations,
      error: null,
    });
    expect(toHookBatchListItem({
      id: 'batch-1',
      videoId: 'v1',
      analysisId: null,
      createdAt,
      text: failedBatchJson('model down'),
    })).toMatchObject({ status: 'failed', variations: null, error: 'model down' });
    expect(toHookBatchListItem({
      id: 'batch-1',
      videoId: 'v1',
      analysisId: null,
      createdAt,
      text: generatingBatchJson('2026-09-30T11:00:00.000Z'),
    })).toMatchObject({ status: 'generating', variations: null, error: null });
  });
});

test('generate_hook_variations reserves one batch id and replays it', () => {
  const src = readFileSync(new URL('../tools/hooks.ts', import.meta.url), 'utf8');
  const start = src.indexOf("server.tool('generate_hook_variations'");
  const body = src.slice(start);
  expect(start).toBeGreaterThan(-1);
  expect(body).toContain('readOnlyHint: false');
  expect(body).toContain('idempotencyKey: batchId');
  expect(body).toContain('logicalHookBatchId');
  expect(body).toContain('onLateFailure');
  expect(src).toContain('not: HOOK_BATCH_TYPE');
  expect(src).not.toMatch(/throw err;/);

  const listStart = src.indexOf("server.tool('list_hook_variations'");
  const listBody = src.slice(listStart);
  expect(listStart).toBeGreaterThan(start);
  expect(listBody).toContain('readOnlyHint: true');
  expect(listBody).toContain('hookType: HOOK_BATCH_TYPE');
  expect(listBody).not.toContain('runPreauthed');
  expect(listBody).not.toContain('CREDIT_COSTS');
});
