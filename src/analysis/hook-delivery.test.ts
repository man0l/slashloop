import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  failedBatchJson,
  generatingBatchJson,
  hookIdContainsToken,
  logicalGeneratedHookId,
  logicalHookBatchId,
  readStoredHookBatch,
  readyBatchJson,
  toHookVariationListItem,
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

const sourceIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

describe('readStoredHookBatch', () => {
  test('parses the reservation sentinels and a ready payload', () => {
    expect(readStoredHookBatch(generatingBatchJson(sourceIds, '2026-09-30T11:00:00.000Z'))).toEqual({
      status: 'generating',
      since: '2026-09-30T11:00:00.000Z',
    });
    expect(readStoredHookBatch(failedBatchJson('model down', sourceIds))).toEqual({
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
    expect(readStoredHookBatch(readyBatchJson(variations, sourceIds))).toEqual({ status: 'ready', variations });
    expect(readStoredHookBatch('not-json').status).toBe('unreadable');
    expect(readStoredHookBatch(JSON.stringify({ status: 'ready', variations })).status).toBe('unreadable');
  });

  test('embeds each source hook id so list_hook_variations can find the batch', () => {
    const variations = [{
      id: 'h1',
      text: 'Your notes are the bottleneck',
      sourceIndex: 0,
      type: 'curiosity_gap',
      mechanism: 'names the pain',
    }];
    for (const json of [
      generatingBatchJson(sourceIds, '2026-09-30T11:00:00.000Z'),
      failedBatchJson('model down', sourceIds),
      readyBatchJson(variations, sourceIds),
    ]) {
      expect(json).toContain(hookIdContainsToken(sourceIds[0]!));
      expect(json).toContain(hookIdContainsToken(sourceIds[1]!));
      expect(hookIdContainsToken(sourceIds[0]!).length).toBeLessThanOrEqual(50);
    }
    const item = toHookVariationListItem({
      id: 'batch-1',
      text: readyBatchJson(variations, sourceIds),
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
      videoId: 'v',
    });
    expect(item.id).toBe('batch-1');
    expect(item.batchId).toBe('batch-1');
    expect(item.sourceHookIds).toEqual(sourceIds);
    expect(item.status).toBe('ready');
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
  expect(body).toContain('`${batchId}:fail`');
  expect(body).toContain('creditsCharged');
  expect(body).toContain('cost: costBlock');
  expect(src).toContain('not: HOOK_BATCH_TYPE');
  expect(src).toContain("server.tool('list_hook_variations'");
  expect(src).toContain('hookIdContainsToken(hookId)');
  expect(src).not.toContain('throw err');
});
