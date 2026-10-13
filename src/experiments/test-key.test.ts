// SLA-806: Experiment.testKey — every attempt of one test (one hypothesis)
// carries the same key, so attempts and their spend are grouped in slashloop
// itself, a test-wide credit cap is enforced on charges, and Paperclip-mode
// experiments get one Paperclip case per test mirrored by the worker. Real
// store + real D1 migrations on bun:sqlite; HTTP through injected get/post.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { RawStatement } from '../store.js';
import * as realStore from './store.js';
import { createExperiment, type CreateExperimentDeps } from './service.js';
import { ExperimentError, normalizeTestKey, takeTest, type Experiment, type NotifyConfig } from './schema.js';
import { buildWebhookPayload } from './webhook-payload.js';
import { paperclipCaseBody, paperclipCaseStatus, type HttpGet, type HttpPost, type PaperclipConfig } from './webhook-delivery.js';
import { runWebhookDeliveries } from './webhook-outbox.js';
import type { Video } from '@prisma/client';

const migration = (name: string) => readFileSync(new URL(`../../prisma/d1-migrations/${name}`, import.meta.url), 'utf8');
let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['0008_experiments.sql', '0016_experiment_ran_by.sql', '0017_experiment_webhook_outbox.sql', '0019_experiment_test_key.sql']) db.exec(migration(m));
});
const run = async (statements: RawStatement[]) => statements.map(s => (
  db.query(s.sql).all(...((s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as any[]))
));
const create = (e: Experiment, key: string, notify: NotifyConfig | null = null) => realStore.create(e, key, run, notify);
const ids = (rows: Experiment[]) => rows.map(r => r.id);

function exp(id: string, createdAt: string, over: Partial<Experiment> = {}): Experiment {
  return {
    id, workspaceId: 'w1', status: 'draft', createdAt, updatedAt: createdAt,
    instructions: { goal: `goal of ${id}`, brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 1, slideCount: 3, maxCredits: 1000, creditsCharged: 0, report: null, inputs: [], variants: [], error: null,
    generationBasis: 'text-directed', assetPolicy: 'retained', version: 0, tasks: [], commands: {}, allowPartial: false, createFingerprint: `fp-${id}`,
    ...over,
  };
}
const MEWING = 'tier-ladder-mewing';

describe('test key parsing', () => {
  test('normalizes to a lower-case slug; blank means none', () => {
    expect(normalizeTestKey('  Tier-Ladder-Mewing ')).toBe(MEWING);
    expect(normalizeTestKey('')).toBeNull();
    expect(normalizeTestKey(undefined)).toBeNull();
    expect(normalizeTestKey('content-cell:jawline.v2_a')).toBe('content-cell:jawline.v2_a');
  });
  test.each([['spaces', 'tier ladder'], ['slash', 'a/b'], ['leading dash', '-x'], ['too long', 'x'.repeat(81)], ['number', 5]])('refuses %s', (_n, v) => {
    expect(() => normalizeTestKey(v)).toThrow(ExperimentError);
  });
  test('takeTest strips test_key and test_max_credits (either spelling) off the body', () => {
    expect(takeTest({ a: 1, test_key: MEWING, test_max_credits: 600 })).toEqual({ body: { a: 1 }, testKey: MEWING, testMaxCredits: 600 });
    expect(takeTest({ a: 1, testKey: MEWING, testMaxCredits: 600 })).toEqual({ body: { a: 1 }, testKey: MEWING, testMaxCredits: 600 });
    expect(takeTest({ a: 1 })).toEqual({ body: { a: 1 }, testKey: null, testMaxCredits: null });
  });
  test('a test cap needs a test key and a positive integer', () => {
    expect(() => takeTest({ test_max_credits: 600 })).toThrow(/needs a test_key/);
    expect(() => takeTest({ test_key: MEWING, test_max_credits: 0 })).toThrow(ExperimentError);
    expect(() => takeTest({ test_key: MEWING, test_max_credits: 1.5 })).toThrow(ExperimentError);
  });
});

describe('createExperiment', () => {
  const source = { id: 'vid1', rawJson: JSON.stringify({ slideshowKeys: ['s0', 's1', 's2'] }), durationSec: 10, mediaStatus: 'slideshow', thumbnailUrl: null, creatorHandle: '@x', caption: 'c', views: 1 } as unknown as Video;
  const persisted: Experiment[] = [];
  const deps: CreateExperimentDeps = {
    findSource: async () => source,
    findLatestAnalysis: async () => null,
    buildInput: async v => ({ videoId: v.id, status: 'ready', analysisId: null, jobId: null, error: null, coverage: null, evidence: [] }),
    persist: async e => { persisted.push(e); return e; },
  };
  const body = { workspaceId: 'w1', videoIds: ['vid1'], instructions: { goal: 'Find a hook', brand: '', audience: '', language: 'English', variables: ['hook'] }, variantCount: 3, slideCount: 3, maxCredits: 200, idempotencyKey: 'key-12345678' };
  beforeEach(() => { persisted.length = 0; });

  test('stores the test key and cap, and keeps both out of the idempotency fingerprint', async () => {
    await createExperiment(body, deps);
    await createExperiment({ ...body, test_key: 'Tier-Ladder-Mewing', test_max_credits: 600 }, deps);
    expect(persisted[1]).toMatchObject({ testKey: MEWING, testMaxCredits: 600 });
    expect(persisted[0]!.createFingerprint).toBe(persisted[1]!.createFingerprint);
  });
  test('a malformed test key is refused before persist', async () => {
    await expect(createExperiment({ ...body, test_key: 'not a slug' }, deps)).rejects.toMatchObject({ code: 'invalid_test_key' });
    expect(persisted).toHaveLength(0);
  });
});

describe('store', () => {
  async function seedMewing() {
    await create(exp('a1', '2026-10-12T19:27:12Z', { testKey: MEWING, status: 'failed', creditsCharged: 96, error: 'qa_failed: slide 5', testMaxCredits: 600 }), 'k1');
    await create(exp('other', '2026-10-12T20:00:00Z', { testKey: 'jawline', creditsCharged: 280 }), 'k2');
    await create(exp('a2', '2026-10-13T08:26:21Z', { testKey: MEWING, status: 'failed', creditsCharged: 84, testMaxCredits: 600 }), 'k3');
    await create(exp('loose', '2026-10-13T09:00:00Z'), 'k4');
    await create(exp('a3', '2026-10-13T09:48:20Z', { testKey: MEWING, status: 'review', creditsCharged: 2, testMaxCredits: 600 }), 'k5');
  }

  test('testKey round-trips through create, load and list; the list filter is exact and workspace-scoped', async () => {
    await seedMewing();
    await create(exp('elsewhere', '2026-10-13T10:00:00Z', { workspaceId: 'w2', testKey: MEWING }), 'k6');
    expect((await realStore.load('w1', 'a3', run)).testKey).toBe(MEWING);
    expect((await realStore.load('w1', 'loose', run)).testKey).toBeNull();
    expect(ids(await realStore.list('w1', 50, 0, { testKey: MEWING }, run))).toEqual(['a3', 'a2', 'a1']);
    expect(ids(await realStore.list('w1', 50, 0, { testKey: 'TIER-LADDER-MEWING' }, run))).toEqual(['a3', 'a2', 'a1']);
    expect(ids(await realStore.list('w1', 50, 0, { testKey: 'tier-ladder' }, run))).toEqual([]);
    expect(ids(await realStore.list('w1', 50, 0, null, run))).toEqual(['a3', 'loose', 'a2', 'other', 'a1']);
  });

  test('testSummary lists every attempt oldest first with their spend added up against the cap', async () => {
    await seedMewing();
    const t = (await realStore.testSummary('w1', MEWING, run))!;
    expect(t.attempts.map(a => [a.experimentId, a.status, a.creditsCharged])).toEqual([['a1', 'failed', 96], ['a2', 'failed', 84], ['a3', 'review', 2]]);
    expect(t).toMatchObject({ testKey: MEWING, attemptCount: 3, creditsChargedTotal: 182, testMaxCredits: 600, creditsRemaining: 418, latestExperimentId: 'a3', latestStatus: 'review' });
    expect(t.attempts[0]!.error).toBe('qa_failed: slide 5');
    expect(await realStore.testSummary('w1', 'nope', run)).toBeNull();
  });

  test('an idempotent replay returns the first row and its test key', async () => {
    await create(exp('first', '2026-10-13T09:00:00Z', { testKey: MEWING }), 'same');
    const replay = await create(exp('second', '2026-10-13T09:01:00Z', { testKey: 'jawline', createFingerprint: 'fp-first' }), 'same');
    expect(replay).toMatchObject({ id: 'first', testKey: MEWING });
  });

  test('save refuses a charge that would push the test past its cap, before any write', async () => {
    await seedMewing();
    const e = await realStore.load('w1', 'a3', run);
    const before = db.query(`SELECT "version","dataJson" FROM "Experiment" WHERE "id"='a3'`).get();
    // 96 + 84 already spent by the other attempts, 2 by this one: 418 left of 600.
    await expect(realStore.save(e, 419, 'ref', [], run)).rejects.toMatchObject({ statusCode: 402, code: 'test_budget_exceeded' });
    expect(db.query(`SELECT "version","dataJson" FROM "Experiment" WHERE "id"='a3'`).get()).toEqual(before);
  });

  test('the in-CAS gate sums the other attempts of the same test only', async () => {
    await seedMewing();
    const gate = (next: number, cap: number) => (db.query(`SELECT ${realStore.siblingChargedSql('sqlite')} + ? <= ? AS ok`).get('w1', MEWING, 'a3', next, cap) as { ok: number }).ok;
    expect(gate(420, 600)).toBe(1);
    expect(gate(421, 600)).toBe(0);
  });
});

describe('webhook payload and Paperclip case mirror', () => {
  const ISSUE = '3b3b7ddf-0e2d-4c1a-9a6f-1d2e3f4a5b6c';
  const AGENT = '1309863b-f9f9-4478-a379-854290f83ed8';
  const paperclipNotify: NotifyConfig = { url: null, secret: null, secretGenerated: false, metadata: { paperclipIssueId: ISSUE, agentId: AGENT } };
  const paperclip: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: { [AGENT]: 'k' } };
  const T0 = new Date(Date.now() + 5_000);

  test('the completion payload carries the test key', () => {
    expect(buildWebhookPayload(exp('a', '2026-10-13T00:00:00Z', { testKey: MEWING }))).toMatchObject({ testKey: MEWING });
    expect(buildWebhookPayload(exp('b', '2026-10-13T00:00:00Z'))).toMatchObject({ testKey: null });
  });

  test('case status follows the newest attempt', () => {
    expect(['draft', 'planning', 'generating', 'failed', 'paused', 'review', 'completed', 'cancelled'].map(paperclipCaseStatus))
      .toEqual(['draft', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_review', 'done', 'cancelled']);
  });

  test('a delivered Paperclip event upserts the test case with every attempt and the total spend', async () => {
    await create(exp('a1', '2026-10-12T19:27:12Z', { testKey: MEWING, status: 'failed', creditsCharged: 96, testMaxCredits: 600 }), 'k1');
    const e = await create(exp('a2', '2026-10-13T08:26:21Z', { testKey: MEWING, status: 'generating', creditsCharged: 84, testMaxCredits: 600, inputs: [{ videoId: 'vid1', status: 'ready', analysisId: null, jobId: null, error: null, coverage: null, evidence: [] }] }), 'k2', paperclipNotify);
    e.status = 'review'; await realStore.save(e, 0, undefined, [], run);
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const get: HttpGet = async u => { calls.push({ method: 'GET', path: u.pathname }); return { status: 200, body: '{"companyId":"c1","status":"in_progress"}' }; };
    const post: HttpPost = async (u, _h, body) => { calls.push({ method: 'POST', path: u.pathname, body: JSON.parse(body) }); return { status: u.pathname.endsWith('/cases') ? 200 : 201 }; };
    expect(await runWebhookDeliveries({ run, get, post, paperclip, clock: () => T0 })).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET /api/issues/${ISSUE}`, 'POST /api/companies/c1/issues', `GET /api/issues/${ISSUE}`, 'POST /api/companies/c1/cases']);
    const upsert = calls.at(-1)!.body;
    expect(upsert).toMatchObject({
      caseType: 'slashloop_experiment', key: `slashloop:w1:${MEWING}`, title: `Experiment: ${MEWING} (2 attempts)`, status: 'in_review',
      fields: { test_slug: MEWING, current_experiment_id: 'a2', current_status: 'review', credits_charged_total: 180, approved_credits: 600, credits_remaining: 420, paperclip_issue_id: ISSUE, source_video_ids: ['vid1'] },
    });
    expect(upsert.summary.split('\n')[0]).toBe('attempts: a1 a2');
  });

  test('a failed mirror is logged and never un-delivers the event', async () => {
    const e = await create(exp('a1', '2026-10-13T08:26:21Z', { testKey: MEWING, status: 'generating' }), 'k1', paperclipNotify);
    e.status = 'failed'; await realStore.save(e, 0, undefined, [], run);
    const get: HttpGet = async () => ({ status: 200, body: '{"companyId":"c1"}' });
    const post: HttpPost = async u => ({ status: u.pathname.endsWith('/cases') ? 403 : 201, body: 'Cases are disabled' });
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { expect(await runWebhookDeliveries({ run, get, post, paperclip, clock: () => T0 })).toEqual({ delivered: 1, retried: 0, dead: 0 }); } finally { console.warn = orig; }
    expect(warnings.some(w => w.includes('case mirror') && w.includes('http_403'))).toBe(true);
  });

  test('experiments without a test key, or without Paperclip delivery, are not mirrored', async () => {
    const plain = await create(exp('p1', '2026-10-13T08:00:00Z', { status: 'generating' }), 'k1', paperclipNotify);
    plain.status = 'review'; await realStore.save(plain, 0, undefined, [], run);
    const url = await create(exp('u1', '2026-10-13T08:01:00Z', { status: 'generating', testKey: MEWING }), 'k2', { url: 'https://hooks.example.com/x', secret: 'whsec_x'.padEnd(24, 'x'), secretGenerated: false, metadata: null });
    url.status = 'review'; await realStore.save(url, 0, undefined, [], run);
    const paths: string[] = [];
    const get: HttpGet = async u => { paths.push(u.pathname); return { status: 200, body: '{"companyId":"c1"}' }; };
    const post: HttpPost = async u => { paths.push(u.pathname); return { status: 201 }; };
    await runWebhookDeliveries({ run, get, post, paperclip, clock: () => T0 });
    expect(paths.filter(p => p.endsWith('/cases'))).toEqual([]);
  });

  test('the case body replaces fields whole and is built from slashloop rows only', () => {
    const body = paperclipCaseBody('w1', {
      testKey: 'jawline', attempts: [{ experimentId: 'x', status: 'completed', creditsCharged: 280, maxCredits: 620, error: null, createdAt: '2026-10-13T00:00:00Z' }],
      attemptCount: 1, creditsChargedTotal: 280, testMaxCredits: null, creditsRemaining: null, latestExperimentId: 'x', latestStatus: 'completed', goal: 'Find\n a hook', ranBy: 'agent:Marketing Ops', videoIds: [],
    }, ISSUE, new Date('2026-10-13T10:00:00Z'));
    expect(body).toMatchObject({ title: 'Experiment: jawline (1 attempt)', status: 'done', summary: 'attempts: x\nFind a hook', fields: { source_mode: 'brief', approved_credits: null, last_synced_at: '2026-10-13T10:00:00.000Z' } });
  });
});

describe('slashloop-experiments skill stays portable', () => {
  for (const path of ['../../skills/slashloop-experiments/SKILL.md', '../../packages/slashloop-skills/skills/slashloop-experiments/SKILL.md']) {
    test(`${path.split('/').slice(2, -1).join('/')} uses test_key and never the Paperclip cases API`, () => {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(text).toContain('test_key');
      expect(text).not.toMatch(/\/cases\b|caseType|Paperclip case/i);
    });
  }
});
