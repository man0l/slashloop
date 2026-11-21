import { describe, expect, test } from 'bun:test';
import { isReadOnlyD1Body, isReadOnlySql, retryD1Request } from './d1-retry.js';

const ok = () => new Response('{}', { status: 200 });
const opts = (logs: string[] = []) => ({ sleep: async () => {}, random: () => 1, log: (m: string) => { logs.push(m); } });

describe('isReadOnlySql', () => {
  test('reads yes, writes no', () => {
    expect(isReadOnlySql('SELECT * FROM "Video" WHERE id = ?')).toBe(true);
    expect(isReadOnlySql('  with x as (select 1) select * from x')).toBe(true);
    expect(isReadOnlySql('PRAGMA table_info(Video)')).toBe(true);
    expect(isReadOnlySql('INSERT INTO "Video" (id) VALUES (?)')).toBe(false);
    expect(isReadOnlySql('UPDATE "MediaJob" SET status = ?')).toBe(false);
    expect(isReadOnlySql('WITH x AS (SELECT 1) DELETE FROM "Video"')).toBe(false);
    expect(isReadOnlySql('PRAGMA foreign_keys = ON')).toBe(false);
    expect(isReadOnlySql(undefined)).toBe(false);
  });
  test('body: single, batch array, mixed batch, garbage', () => {
    expect(isReadOnlyD1Body(JSON.stringify({ sql: 'select 1', params: [] }))).toBe(true);
    expect(isReadOnlyD1Body(JSON.stringify({ batch: [{ sql: 'select 1' }, { sql: 'select 2' }] }))).toBe(true);
    expect(isReadOnlyD1Body(JSON.stringify({ batch: [{ sql: 'select 1' }, { sql: 'delete from x' }] }))).toBe(false);
    expect(isReadOnlyD1Body('not json')).toBe(false);
    expect(isReadOnlyD1Body(undefined)).toBe(false);
  });
});

describe('retryD1Request', () => {
  test('retries a timeout then succeeds, logging each retry', async () => {
    let n = 0;
    const logs: string[] = [];
    const res = await retryD1Request(async () => {
      if (++n < 3) throw new Error('Request timed out');
      return ok();
    }, opts(logs));
    expect(res.status).toBe(200);
    expect(n).toBe(3);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe('[d1] read request failed (Request timed out); retry 1/2 in 250ms');
  });

  test('retries 5xx/429 and returns the last response when exhausted', async () => {
    let n = 0;
    const res = await retryD1Request(async () => { n++; return new Response('x', { status: 503 }); }, opts());
    expect(res.status).toBe(503);
    expect(n).toBe(3);
  });

  test('gives up after maxRetries and rethrows the last error', async () => {
    let n = 0;
    await expect(retryD1Request(async () => { n++; throw new Error('Request timed out'); }, opts())).rejects.toThrow('Request timed out');
    expect(n).toBe(3);
  });

  test('4xx is returned immediately, not retried', async () => {
    let n = 0;
    const res = await retryD1Request(async () => { n++; return new Response('bad', { status: 400 }); }, opts());
    expect(res.status).toBe(400);
    expect(n).toBe(1);
  });
});
