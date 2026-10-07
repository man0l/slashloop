// SLA-617: experiment completion webhook. Real store + real D1 migrations on
// bun:sqlite, so the outbox INSERT-before-CAS ordering, the column placement
// and the claim lease are exercised against actual SQL. Delivery is driven
// through an injected HttpPost; no process-global mocks.
import { Database } from 'bun:sqlite';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Video } from '@prisma/client';
import type { RawStatement } from '../store.js';
import * as realStore from './store.js';
import { createExperiment, type CreateExperimentDeps } from './service.js';
import { ExperimentError, parseNotify, takeNotify, TERMINAL_STATUSES, type Experiment, type NotifyConfig } from './schema.js';
import { assertPublicHttpsUrl, isPrivateAddress, WebhookUrlError } from '../lib/webhook-url.js';
import {
  classifyPaperclipStatus, classifyStatus, deliver, describePaperclipEnv, guardedPost, isPaperclipConfigError, paperclipConfigFromEnv, redactedSnippet, signWebhook, webhookHeaders,
  type HttpGet, type HttpPost, type PaperclipConfig,
} from './webhook-delivery.js';
import { claimDue, MAX_ATTEMPTS, pruneSettled, retryDelayMs, RETRY_DELAYS_MS, runWebhookDeliveries } from './webhook-outbox.js';
import { webhookIdempotencyKey } from './webhook-payload.js';

const migration = (name: string) => readFileSync(new URL(`../../prisma/d1-migrations/${name}`, import.meta.url), 'utf8');

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  for (const m of ['0008_experiments.sql', '0016_experiment_ran_by.sql', '0017_experiment_webhook_outbox.sql']) db.exec(migration(m));
});
const run = async (statements: RawStatement[]) => statements.map(s => (
  db.query(s.sql).all(...((s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as any[]))
));
const create = (e: Experiment, key: string, notify: NotifyConfig | null = null) => realStore.create(e, key, run, notify);
const load = (id: string) => realStore.load('w1', id, run);
const save = (e: Experiment) => realStore.save(e, 0, undefined, [], run);
const outbox = () => db.query(`SELECT * FROM "ExperimentWebhookOutbox" ORDER BY "createdAt","version"`).all() as any[];

const ISSUE = '3b3b7ddf-0e2d-4c1a-9a6f-1d2e3f4a5b6c';
const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const urlNotify = (over: Partial<NotifyConfig> = {}): NotifyConfig => ({ url: 'https://hooks.example.com/slashloop', secret: SECRET, secretGenerated: false, metadata: { ticket: 'T-1' }, ...over });
const MARKETING_OPS = '1309863b-f9f9-4478-a379-854290f83ed8';
const MARKETING_OPS_CODEX = '6ec93e60-0093-4b66-90e1-ccde0b7fb410';
const paperclipNotify = (agentId: string | null = MARKETING_OPS): NotifyConfig => ({
  url: null, secret: null, secretGenerated: false, metadata: { paperclipIssueId: ISSUE, ...(agentId ? { agentId } : {}) },
});

function exp(id: string, over: Partial<Experiment> = {}): Experiment {
  return {
    id, workspaceId: 'w1', status: 'draft', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    instructions: { goal: id, brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 0, report: null, inputs: [], variants: [], error: null,
    generationBasis: 'text-directed', assetPolicy: 'retained', version: 0, tasks: [], commands: {}, allowPartial: false, createFingerprint: `fp-${id}`,
    ...over,
  };
}

describe('outbox on every terminal path', () => {
  for (const status of TERMINAL_STATUSES) {
    test(`generating -> ${status} queues exactly one event with the idempotency key experimentId:status:version`, async () => {
      const e = await create(exp(`e-${status}`, { status: 'generating' }), `k-${status}`, urlNotify());
      e.status = status;
      if (status === 'failed' || status === 'paused') e.error = 'provider_down';
      expect(await save(e)).toBe(true);
      const rows = outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        experimentId: `e-${status}`, workspaceId: 'w1', status, version: 1, state: 'pending', attempts: 0,
        idempotencyKey: webhookIdempotencyKey(`e-${status}`, status, 1),
      });
      const payload = JSON.parse(rows[0].payloadJson);
      expect(payload).toMatchObject({ type: `experiment.${status}`, experimentId: `e-${status}`, status, version: 1 });
      expect('error' in payload).toBe(status === 'failed' || status === 'paused');
      expect(JSON.parse(rows[0].notifyJson)).toMatchObject({ url: 'https://hooks.example.com/slashloop', secret: SECRET });
      expect(rows[0].payloadJson).not.toContain(SECRET);
    });
  }

  test('draft -> terminal (cancel before any run) also fires', async () => {
    const e = await create(exp('d1'), 'kd', urlNotify());
    e.status = 'cancelled';
    await save(e);
    expect(outbox().map(r => r.status)).toEqual(['cancelled']);
  });

  test('non-terminal -> non-terminal queues nothing', async () => {
    const e = await create(exp('n1'), 'kn', urlNotify());
    e.status = 'planning'; await save(e);
    e.status = 'generating'; await save(e);
    expect(outbox()).toHaveLength(0);
  });

  test('terminal -> terminal queues nothing', async () => {
    const e = await create(exp('t1', { status: 'generating' }), 'kt', urlNotify());
    e.status = 'review'; await save(e);
    e.status = 'cancelled'; await save(e);
    expect(outbox().map(r => r.status)).toEqual(['review']);
  });

  test('a retry that reaches a terminal status again fires again with a new version', async () => {
    const e = await create(exp('r1', { status: 'generating' }), 'kr', urlNotify());
    e.status = 'failed'; await save(e);
    e.status = 'generating'; await save(e);
    e.status = 'review'; await save(e);
    expect(outbox().map(r => [r.status, r.version])).toEqual([['failed', 1], ['review', 3]]);
  });

  test('experiments without notify config never queue', async () => {
    const e = await create(exp('p1', { status: 'generating' }), 'kp');
    e.status = 'completed'; await save(e);
    expect(await load('p1')).toMatchObject({ status: 'completed' });
    expect(outbox()).toHaveLength(0);
  });

  test('a stale-version CAS loser queues nothing and the winner queues once', async () => {
    const e = await create(exp('c1', { status: 'generating' }), 'kc', urlNotify());
    const loser = structuredClone(e);
    e.status = 'review';
    expect(await save(e)).toBe(true);
    loser.status = 'failed';
    expect(await save(loser)).toBe(false);
    expect(outbox().map(r => r.status)).toEqual(['review']);
  });

  test('re-queueing the same transition is a no-op (unique idempotency key)', () => {
    const e = exp('u1', { version: 0 });
    const next = { ...e, status: 'review' as const, version: 1 };
    db.run(`INSERT INTO "Experiment" ("id","workspaceId","status","version","dataJson","createdAt","updatedAt","createKey","notifyJson") VALUES ('u1','w1','generating',0,'{}','2026-10-01','2026-10-01','ku',?)`, [JSON.stringify(urlNotify())]);
    const stmt = realStore.outboxStatement(e, next, '', []);
    const once = db.query(stmt.sql).all(...(stmt.params as any[]).map(v => (v instanceof Date ? v.toISOString() : v)));
    const twice = db.query(stmt.sql).all(...(stmt.params as any[]).map(v => (v instanceof Date ? v.toISOString() : v)));
    expect(once).toHaveLength(1);
    expect(twice).toHaveLength(0);
    expect(outbox()).toHaveLength(1);
  });
});

describe('notify storage and create', () => {
  test('notify lives in its own column: not in dataJson, serialize(), load() or list()', async () => {
    await create(exp('s1'), 'ks', urlNotify());
    const row = db.query(`SELECT "dataJson","notifyJson" FROM "Experiment" WHERE "id"='s1'`).get() as any;
    expect(row.notifyJson).toContain(SECRET);
    expect(row.dataJson).not.toContain(SECRET);
    const loaded = await load('s1');
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
    expect(JSON.stringify(realStore.serialize(loaded))).not.toContain(SECRET);
    expect(JSON.stringify(await realStore.list('w1', 10, 0, undefined, run))).not.toContain(SECRET);
  });

  test('a generated secret is returned on create and is identical on an idempotent replay', async () => {
    const notify = parseNotify({ url: 'https://hooks.example.com/x' }, assertPublicHttpsUrl)!;
    expect(notify.secret).toMatch(/^whsec_/);
    const first = await create(exp('g1', { createFingerprint: 'same' }), 'kg', notify);
    expect(first.notify).toMatchObject({ url: 'https://hooks.example.com/x', signingSecret: notify.secret });
    const other = parseNotify({ url: 'https://hooks.example.com/x' }, assertPublicHttpsUrl)!;
    const replay = await create(exp('g2', { createFingerprint: 'same' }), 'kg', other);
    expect(replay.id).toBe('g1');
    expect(replay.notify?.signingSecret).toBe(notify.secret ?? undefined);
  });

  test('a caller-supplied secret is never echoed back', async () => {
    const created = await create(exp('g3'), 'kg3', urlNotify());
    expect(created.notify).toEqual({ url: 'https://hooks.example.com/slashloop', paperclipIssueId: null });
  });

  test('without notify there is no receipt', async () => {
    expect((await create(exp('g4'), 'kg4')).notify).toBeUndefined();
  });
});

describe('parseNotify', () => {
  const ok = (u: string) => assertPublicHttpsUrl(u);
  const reject = (raw: unknown) => { try { parseNotify(raw, ok); } catch (e) { return e as ExperimentError; } throw new Error('expected rejection'); };

  test('absent notify is null', () => {
    expect(parseNotify(undefined, ok)).toBeNull();
    expect(parseNotify(null, ok)).toBeNull();
  });
  test.each([
    ['http', { url: 'http://hooks.example.com/x' }],
    ['loopback', { url: 'https://127.0.0.1/x' }],
    ['metadata ip', { url: 'https://169.254.169.254/latest/meta-data' }],
    ['port', { url: 'https://hooks.example.com:8443/x' }],
    ['credentials', { url: 'https://user:pw@hooks.example.com/x' }],
    ['no target', { metadata: { a: 1 } }],
    ['empty', {}],
    ['bad paperclip id', { metadata: { paperclipIssueId: 'not-a-uuid' } }],
    ['short secret', { url: 'https://hooks.example.com/x', secret: 'short' }],
    ['unknown key', { url: 'https://hooks.example.com/x', extra: 1 }],
    ['oversize metadata', { url: 'https://hooks.example.com/x', metadata: { blob: 'x'.repeat(5000) } }],
  ])('rejects %s with 400 invalid_notify', (_name, raw) => {
    const err = reject(raw);
    expect(err).toBeInstanceOf(ExperimentError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('invalid_notify');
  });
  test('paperclip target needs no url and gets no secret', () => {
    expect(parseNotify({ metadata: { paperclipIssueId: ISSUE } }, ok)).toEqual({ url: null, secret: null, secretGenerated: false, metadata: { paperclipIssueId: ISSUE } });
  });
  test('takeNotify strips notify from the body', () => {
    expect(takeNotify({ a: 1, notify: { url: 'x' } })).toEqual({ body: { a: 1 }, notify: { url: 'x' } });
    expect(takeNotify({ a: 1 })).toEqual({ body: { a: 1 }, notify: undefined });
  });
});

describe('createExperiment service', () => {
  const source = { id: 'vid1', rawJson: JSON.stringify({ slideshowKeys: ['s0', 's1', 's2'] }), durationSec: 10, mediaStatus: 'slideshow', thumbnailUrl: null, creatorHandle: '@x', caption: 'c', views: 1 } as unknown as Video;
  const persisted: Array<{ e: Experiment; notify: NotifyConfig | undefined }> = [];
  let lookups = 0;
  const deps: CreateExperimentDeps = {
    findSource: async () => { lookups++; return source; },
    findLatestAnalysis: async () => null,
    buildInput: async v => ({ videoId: v.id, status: 'ready', analysisId: null, jobId: null, error: null, coverage: null, evidence: [] }),
    persist: async (e, _key, _run, notify) => { persisted.push({ e, notify: notify ?? undefined }); return e; },
  };
  const body = { workspaceId: 'w1', videoIds: ['vid1'], instructions: { goal: 'Find a hook', brand: '', audience: '', language: 'English', variables: ['hook'] }, variantCount: 3, slideCount: 3, maxCredits: 200, idempotencyKey: 'key-12345678' };
  beforeEach(() => { persisted.length = 0; lookups = 0; });

  test('notify is validated and handed to persist, and stays out of the fingerprint', async () => {
    await createExperiment(body, deps);
    await createExperiment({ ...body, notify: { url: 'https://hooks.example.com/x', metadata: { k: 1 } } }, deps);
    expect(persisted[0]!.notify).toBeUndefined();
    expect(persisted[1]!.notify).toMatchObject({ url: 'https://hooks.example.com/x', metadata: { k: 1 }, secretGenerated: true });
    expect(persisted[0]!.e.createFingerprint).toBe(persisted[1]!.e.createFingerprint);
  });
  test('a bad notify is rejected before any source lookup or persist', async () => {
    await expect(createExperiment({ ...body, notify: { url: 'http://hooks.example.com/x' } }, deps)).rejects.toMatchObject({ code: 'invalid_notify' });
    await expect(createExperiment({ ...body, notify: { url: 'https://10.0.0.5/x' } }, deps)).rejects.toMatchObject({ code: 'invalid_notify' });
    expect(lookups).toBe(0);
    expect(persisted).toHaveLength(0);
  });
});

describe('SSRF guard', () => {
  test.each([
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1',
    '2002:7f00:1::', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', 'not-an-ip', '256.1.1.1',
  ])('%s is private/blocked', ip => expect(isPrivateAddress(ip)).toBe(true));

  test.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8'])(
    '%s is public', ip => expect(isPrivateAddress(ip)).toBe(false));

  test.each([
    'https://localhost/x', 'https://app.localhost/x', 'https://intranet/x', 'https://db.internal/x', 'https://printer.local/x', 'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://127.1/x', 'https://017700000001/x',
    'ftp://hooks.example.com/x', 'http://hooks.example.com/x', 'https://hooks.example.com:444/x', 'https://a:b@hooks.example.com/x', 'nonsense', '',
  ])('%p is rejected at create time', raw => expect(() => assertPublicHttpsUrl(raw)).toThrow(WebhookUrlError));

  test('public https URLs, with or without explicit :443, a path and a query, are accepted', () => {
    expect(assertPublicHttpsUrl('https://hooks.example.com/a/b?c=1').hostname).toBe('hooks.example.com');
    expect(assertPublicHttpsUrl('https://hooks.example.com:443/a').port).toBe('');
    expect(assertPublicHttpsUrl('https://8.8.8.8/x').hostname).toBe('8.8.8.8');
  });

  test('connect-time guard refuses a private literal without opening a socket', async () => {
    await expect(guardedPost(new URL('https://127.0.0.1/hook'), {}, '{}')).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(guardedPost(new URL('https://[::1]/hook'), {}, '{}')).rejects.toMatchObject({ code: 'blocked_address' });
  });
  test('connect-time guard refuses a hostname that resolves to a private address', async () => {
    await expect(guardedPost(new URL('https://localhost/hook'), {}, '{}')).rejects.toMatchObject({ code: 'blocked_address' });
  });
});

describe('signing and headers', () => {
  test('matches an independent Standard Webhooks computation', () => {
    const id = 'e1:review:3'; const ts = 1_760_000_000; const body = '{"a":1}';
    const expected = 'v1,' + createHmac('sha256', Buffer.from('0123456789abcdef0123456789abcdef')).update(`${id}.${ts}.${body}`).digest('base64');
    expect(signWebhook(SECRET, id, ts, body)).toBe(expected);
  });
  test('a secret without the whsec_ prefix is used as raw bytes', () => {
    const expected = 'v1,' + createHmac('sha256', 'plain-secret-0123456789').update('i.1.b').digest('base64');
    expect(signWebhook('plain-secret-0123456789', 'i', 1, 'b')).toBe(expected);
  });
  test('headers carry id, unix-second timestamp, signature and the idempotency key', () => {
    const h = webhookHeaders('e1:review:3', SECRET, 1_760_000_000_999, '{}');
    expect(h['webhook-id']).toBe('e1:review:3');
    expect(h['idempotency-key']).toBe('e1:review:3');
    expect(h['webhook-timestamp']).toBe('1760000000');
    expect(h['webhook-signature']).toBe(signWebhook(SECRET, 'e1:review:3', 1_760_000_000, '{}'));
  });
  test('no secret, no signature header', () => {
    expect('webhook-signature' in webhookHeaders('i', null, 0, '{}')).toBe(false);
  });
});

describe('classifyStatus', () => {
  test.each([200, 201, 204, 299])('%i is delivered', s => expect(classifyStatus(s)).toMatchObject({ ok: true }));
  test.each([401, 403, 408, 425, 429, 500, 502, 503, 504])('%i retries', s => expect(classifyStatus(s)).toMatchObject({ ok: false, permanent: false, error: `http_${s}` }));
  test.each([301, 302, 400, 404, 410, 422])('%i is permanent', s => expect(classifyStatus(s)).toMatchObject({ ok: false, permanent: true }));
});

describe('deliver', () => {
  const row = (notify: NotifyConfig, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: 'e1:review:3', workspaceId: 'w1', notifyJson: JSON.stringify(notify),
    payloadJson: JSON.stringify({ type: 'experiment.review', experimentId: 'e1', status: 'review', version: 3, summary: { variants: 2, spentCredits: 40 } }), ...extra,
  });
  const capture = (status = 200) => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const post: HttpPost = async (url, headers, body) => { seen.push({ url: url.toString(), headers, body }); return { status }; };
    return { seen, post };
  };

  test('POSTs the signed payload with metadata echoed', async () => {
    const { seen, post } = capture();
    const res = await deliver(row(urlNotify()), { post, now: () => 1_760_000_000_000 });
    expect(res).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://hooks.example.com/slashloop');
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({ experimentId: 'e1', status: 'review', version: 3, metadata: { ticket: 'T-1' } });
    expect(seen[0]!.headers['webhook-signature']).toBe(signWebhook(SECRET, 'e1:review:3', 1_760_000_000, seen[0]!.body));
    expect(seen[0]!.headers['webhook-id']).toBe('e1:review:3');
  });
  test('a private target stored in the row is refused at delivery too (permanent, no request)', async () => {
    const { seen, post } = capture();
    const res = await deliver(row(urlNotify({ url: 'https://10.0.0.1/x' })), { post });
    expect(res).toMatchObject({ ok: false, permanent: true, error: 'url_host_not_public' });
    expect(seen).toHaveLength(0);
  });
  test('network errors retry and a corrupt row is permanent', async () => {
    const post: HttpPost = async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); };
    expect(await deliver(row(urlNotify()), { post })).toMatchObject({ ok: false, permanent: false, error: 'network_error:ECONNRESET' });
    expect(await deliver(row(urlNotify(), { payloadJson: '{nope' }), { post })).toMatchObject({ ok: false, permanent: true });
  });

  describe('Paperclip mode', () => {
    const paperclip: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: { [MARKETING_OPS]: 'pcp_key_claude', [MARKETING_OPS_CODEX]: 'pcp_key_codex' } };
    const COMPANY = '458c3a0e-dfbb-4a07-930c-ae211413197f';
    const PROJECT = '1be9c1ac-e4ae-4536-a251-a911167c050e';
    /** A fake Paperclip: GET returns the origin issue, POST creates a child task (deduped on idempotencyKey like the real server). */
    const paperclipServer = (over: { origin?: number; originBody?: string; create?: number; createBody?: string } = {}) => {
      const created = new Map<string, Record<string, unknown>>();
      const calls: Array<{ method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }> = [];
      const get: HttpGet = async (url, headers) => {
        calls.push({ method: 'GET', url: url.toString(), headers });
        return { status: over.origin ?? 200, body: over.originBody ?? JSON.stringify({ id: ISSUE, identifier: 'SLA-657', companyId: COMPANY, projectId: PROJECT }) };
      };
      const post: HttpPost = async (url, headers, body) => {
        calls.push({ method: 'POST', url: url.toString(), headers, body });
        const status = over.create ?? 201;
        if (status < 300) { const j = JSON.parse(body); if (!created.has(j.idempotencyKey)) created.set(j.idempotencyKey, j); }
        return { status, body: over.createBody };
      };
      return { created, calls, get, post };
    };
    const posts = (t: ReturnType<typeof paperclipServer>) => t.calls.filter(c => c.method === 'POST');
    const RUN_CONTEXT_403 = '{"error":"Cross-issue writes need a run to attribute them to","code":"cross_issue_influence_run_context_required"}';

    test('creates a child task under the originating issue, assigned to the requesting agent, without a run id', async () => {
      const t = paperclipServer();
      const res = await deliver(row(paperclipNotify()), { ...t, paperclip });
      expect(res).toMatchObject({ ok: true, error: null });
      expect(t.calls.map(c => c.method)).toEqual(['GET', 'POST']);
      expect(t.calls[0]!.url).toBe(`https://paperclip.example.com/api/issues/${ISSUE}`);
      const sent = posts(t)[0]!;
      expect(sent.url).toBe(`https://paperclip.example.com/api/companies/${COMPANY}/issues`);
      expect(sent.headers.authorization).toBe('Bearer pcp_key_claude');
      expect(Object.keys(sent.headers).map(k => k.toLowerCase())).not.toContain('x-paperclip-run-id');
      const body = JSON.parse(sent.body!);
      expect(body).toMatchObject({ parentId: ISSUE, assigneeAgentId: MARKETING_OPS, projectId: PROJECT, status: 'todo', idempotencyKey: 'slashloop-experiment:e1:review:3' });
      expect(body.title).toBe('Slashloop experiment e1 review');
      expect(body.description).toContain('`e1` reached **review**');
      expect(body.description).toContain('Variants: 2 · credits spent: 40');
      expect(body.description).toContain('Requested for SLA-657.');
      expect(body.description).toContain('get_experiment');
      expect(sent.body).not.toContain('pcp_key_claude');
    });
    test('the key and the assignee are chosen by metadata.agentId', async () => {
      const t = paperclipServer();
      await deliver(row(paperclipNotify(MARKETING_OPS_CODEX)), { ...t, paperclip });
      expect(t.calls.map(c => c.headers.authorization)).toEqual(['Bearer pcp_key_codex', 'Bearer pcp_key_codex']);
      expect(JSON.parse(posts(t)[0]!.body!).assigneeAgentId).toBe(MARKETING_OPS_CODEX);
    });
    test('no comment is ever posted', async () => {
      const t = paperclipServer();
      await deliver(row(paperclipNotify()), { ...t, paperclip });
      expect(t.calls.some(c => c.url.includes('/comments'))).toBe(false);
    });
    test('one task per experiment: four experiments on one issue make four tasks', async () => {
      const t = paperclipServer();
      for (const id of ['a', 'b', 'c', 'd']) {
        const r = row(paperclipNotify(), { idempotencyKey: `${id}:review:3`, payloadJson: JSON.stringify({ experimentId: id, status: 'review', version: 3, summary: { variants: 1, spentCredits: 0 } }) });
        expect(await deliver(r, { ...t, paperclip })).toMatchObject({ ok: true });
      }
      expect(t.created.size).toBe(4);
    });
    test('a retry sends the same idempotency key, so a landed delivery is not duplicated', async () => {
      const t = paperclipServer();
      await deliver(row(paperclipNotify()), { ...t, paperclip });
      expect(await deliver(row(paperclipNotify()), { ...t, paperclip })).toMatchObject({ ok: true });
      expect(posts(t)).toHaveLength(2);
      expect(t.created.size).toBe(1);
    });
    test('works the same when the originating issue belongs to another agent', async () => {
      const t = paperclipServer({ originBody: JSON.stringify({ id: ISSUE, identifier: 'SLA-658', companyId: COMPANY, assigneeAgentId: '02d158ba-5a8e-40ce-9cb0-46f65154a684' }) });
      expect(await deliver(row(paperclipNotify()), { ...t, paperclip })).toMatchObject({ ok: true });
      const body = JSON.parse(posts(t)[0]!.body!);
      expect(body).toMatchObject({ parentId: ISSUE, assigneeAgentId: MARKETING_OPS });
      expect(body).not.toHaveProperty('projectId');
    });
    test('a description cannot be broken by error text', async () => {
      const t = paperclipServer();
      const failed = row(paperclipNotify(), { payloadJson: JSON.stringify({ experimentId: 'e1', status: 'failed', version: 4, error: 'line one\nline two', summary: {} }), idempotencyKey: 'e1:failed:4' });
      await deliver(failed, { ...t, paperclip });
      expect(JSON.parse(posts(t)[0]!.body!).description).toContain('Error: line one line two');
    });

    describe('board key', () => {
      const boardCfg: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: {}, boardKey: 'board_secret_key_value' };
      /** A fake thread: GET lists comments, POST appends one. */
      const thread = (over: { listing?: number; create?: number; createBody?: string } = {}) => {
        const comments: string[] = [];
        const calls: Array<{ method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }> = [];
        const get: HttpGet = async (url, headers) => { calls.push({ method: 'GET', url: url.toString(), headers }); return { status: over.listing ?? 200, body: JSON.stringify(comments) }; };
        const post: HttpPost = async (url, headers, body) => {
          calls.push({ method: 'POST', url: url.toString(), headers, body });
          const status = over.create ?? 201;
          if (status < 300) comments.push(JSON.parse(body).body);
          return { status, body: over.createBody };
        };
        return { comments, calls, get, post };
      };
      test('posts a board comment on the origin issue: no run header, marker and resume, no agent key or agentId needed', async () => {
        const t = thread();
        expect(await deliver(row(paperclipNotify(null)), { ...t, paperclip: boardCfg })).toMatchObject({ ok: true, status: 201 });
        const post = t.calls.find(c => c.method === 'POST')!;
        expect(post.url).toBe(`https://paperclip.example.com/api/issues/${ISSUE}/comments`);
        expect(post.headers.authorization).toBe('Bearer board_secret_key_value');
        expect(Object.keys(post.headers).map(k => k.toLowerCase())).not.toContain('x-paperclip-run-id');
        const j = JSON.parse(post.body!);
        expect(j.resume).toBe(true);
        expect(j.body).toContain('<!-- slashloop-experiment:');
        expect(j.body).toContain('reached **review**');
      });
      test('works for any assignee: the same comment path whichever agent asked', async () => {
        for (const agentId of [MARKETING_OPS, '02d158ba-5a8e-40ce-9cb0-46f65154a684', null]) {
          const t = thread();
          expect(await deliver(row(paperclipNotify(agentId)), { ...t, paperclip: boardCfg })).toMatchObject({ ok: true });
          expect(t.calls.filter(c => c.method === 'POST')).toHaveLength(1);
        }
      });
      test('a replay finds the marker in the thread and posts nothing', async () => {
        const t = thread();
        await deliver(row(paperclipNotify()), { ...t, paperclip: boardCfg });
        expect(await deliver(row(paperclipNotify()), { ...t, paperclip: boardCfg })).toMatchObject({ ok: true });
        expect(t.calls.filter(c => c.method === 'POST')).toHaveLength(1);
      });
      test('the board key wins over agent keys when both are set', async () => {
        const t = thread();
        await deliver(row(paperclipNotify()), { ...t, paperclip: { ...paperclip, boardKey: 'board_secret_key_value' } });
        expect(t.calls.every(c => c.headers.authorization === 'Bearer board_secret_key_value')).toBe(true);
        expect(t.calls.some(c => c.url.includes('/comments') && c.method === 'POST')).toBe(true);
      });
      test('401/403 name the key as rejected, stay retryable, are config errors, and never leak the key', async () => {
        for (const status of [401, 403]) {
          const t = thread({ create: status, createBody: '{"error":"expired","token":"board_secret_key_value"}' });
          const res = await deliver(row(paperclipNotify()), { ...t, paperclip: boardCfg });
          expect(res).toMatchObject({ ok: false, permanent: false, status });
          expect(res.error).toStartWith(`paperclip_board_key_rejected: http_${status}`);
          expect(res.error).not.toContain('board_secret_key_value');
          expect(isPaperclipConfigError(res.error)).toBe(true);
        }
        const t = thread({ listing: 401 });
        expect(await deliver(row(paperclipNotify()), { ...t, paperclip: boardCfg })).toMatchObject({ ok: false, status: 401 });
        expect(t.calls.some(c => c.method === 'POST')).toBe(false);
      });
      test('404 is final, 5xx and 429 retry', async () => {
        expect(await deliver(row(paperclipNotify()), { ...thread({ create: 404 }), paperclip: boardCfg })).toMatchObject({ ok: false, permanent: true, status: 404 });
        for (const status of [429, 500, 503]) expect(await deliver(row(paperclipNotify()), { ...thread({ create: status }), paperclip: boardCfg })).toMatchObject({ ok: false, permanent: false, status });
      });
      test('env: a board key alone is enough, and the startup line reports only that it is set', () => {
        const env = { SLASHLOOP_PAPERCLIP_API_URL: 'https://paperclip.example.com', SLASHLOOP_BOARD_API_KEY: ' board_secret_key_value ' };
        expect(paperclipConfigFromEnv(env)).toEqual({ reason: null, config: { baseUrl: 'https://paperclip.example.com', keys: {}, boardKey: 'board_secret_key_value' } });
        expect(describePaperclipEnv(env)).toBe('paperclip delivery config: url=set board=set keys=0 agents=[] status=ok');
        expect(paperclipConfigFromEnv({ ...env, SLASHLOOP_BOARD_API_KEY: '  ' }).reason).toBe('paperclip_keys_missing');
        expect(paperclipConfigFromEnv({ ...env, SLASHLOOP_PAPERCLIP_API_URL: '' }).reason).toBe('paperclip_url_missing');
      });
    });

    describe('failures', () => {
      test('no key for the agent, no agentId: permanent, no request', async () => {
        const t = paperclipServer();
        expect(await deliver(row(paperclipNotify('00000000-0000-4000-8000-000000000000')), { ...t, paperclip })).toMatchObject({ ok: false, permanent: true, error: 'paperclip_agent_key_missing' });
        expect(await deliver(row(paperclipNotify(null)), { ...t, paperclip })).toMatchObject({ ok: false, permanent: true, error: 'paperclip_agent_id_missing' });
        expect(await deliver(row(paperclipNotify('__proto__')), { ...t, paperclip })).toMatchObject({ ok: false, permanent: true, error: 'paperclip_agent_key_missing' });
        expect(t.calls).toHaveLength(0);
      });
      test('a notify with no paperclipIssueId and no url is permanent', async () => {
        const t = paperclipServer();
        const n: NotifyConfig = { url: null, secret: null, secretGenerated: false, metadata: { agentId: MARKETING_OPS } };
        expect(await deliver(row(n), { ...t, paperclip })).toMatchObject({ ok: false, permanent: true, error: 'no_target' });
        expect(t.calls).toHaveLength(0);
      });
      test('the run-context 403 is its own permanent, loudly-named config error', async () => {
        const t = paperclipServer({ create: 403, createBody: RUN_CONTEXT_403 });
        const res = await deliver(row(paperclipNotify()), { ...t, paperclip });
        expect(res).toMatchObject({ ok: false, permanent: true, status: 403 });
        expect(res.error).toStartWith('paperclip_run_context_required: ');
        expect(res.error).toContain('Cross-issue writes need a run');
        expect(isPaperclipConfigError(res.error)).toBe(true);
        expect(isPaperclipConfigError('http_403: Agent cannot access this issue')).toBe(false);
        expect(isPaperclipConfigError('paperclip_url_missing')).toBe(false);
      });
      test('403 and 404 are permanent and keep a redacted snippet', async () => {
        for (const status of [403, 404]) {
          const get: HttpGet = async () => ({ status, body: '{"error":"Agent cannot access this issue","token":"pcp_key_claude","x":"abcdefghijklmnopqrstuvwxyz0123456789"}' });
          const res = await deliver(row(paperclipNotify()), { get, post: paperclipServer().post, paperclip });
          expect(res).toMatchObject({ ok: false, permanent: true, status });
          expect(res.error).toContain(`http_${status}: `);
          expect(res.error).toContain('Agent cannot access this issue');
          expect(res.error).not.toContain('pcp_key_claude');
          expect(res.error).not.toContain('abcdefghijklmnopqrstuvwxyz');
        }
        expect(await deliver(row(paperclipNotify()), { ...paperclipServer({ create: 403 }), paperclip })).toMatchObject({ ok: false, permanent: true, status: 403 });
      });
      test('5xx, 429, 401 and network errors retry, on the origin read and on the create', async () => {
        for (const status of [500, 502, 503, 429, 408, 401]) {
          const t = paperclipServer({ origin: status });
          expect(await deliver(row(paperclipNotify()), { ...t, paperclip })).toMatchObject({ ok: false, permanent: false, status });
          expect(posts(t)).toHaveLength(0);
          expect(await deliver(row(paperclipNotify()), { ...paperclipServer({ create: status }), paperclip })).toMatchObject({ ok: false, permanent: false, status });
        }
        const boom = () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); };
        expect(await deliver(row(paperclipNotify()), { get: async () => boom(), post: paperclipServer().post, paperclip })).toMatchObject({ ok: false, permanent: false, error: 'network_error:ECONNRESET' });
        expect(await deliver(row(paperclipNotify()), { get: paperclipServer().get, post: async () => boom(), paperclip })).toMatchObject({ ok: false, permanent: false, error: 'network_error:ECONNRESET' });
      });
      test('other 4xx are permanent', async () => {
        for (const status of [400, 409, 422]) {
          expect(await deliver(row(paperclipNotify()), { ...paperclipServer({ create: status }), paperclip })).toMatchObject({ ok: false, permanent: true, status });
        }
        expect(classifyPaperclipStatus(204)).toMatchObject({ ok: true });
      });
      test('an unreadable origin issue retries and posts nothing', async () => {
        for (const originBody of ['<html>', '{}', '{"companyId":""}']) {
          const t = paperclipServer({ originBody });
          expect(await deliver(row(paperclipNotify()), { ...t, paperclip })).toMatchObject({ ok: false, permanent: false, error: 'paperclip_origin_unreadable' });
          expect(posts(t)).toHaveLength(0);
        }
      });
      test('each env fault is retryable and names itself in lastError', async () => {
        const good = { SLASHLOOP_PAPERCLIP_API_URL: 'https://paperclip.example.com', SLASHLOOP_PAPERCLIP_AGENT_KEYS: JSON.stringify({ [MARKETING_OPS]: 'k1' }) };
        const cases: Array<[Record<string, string | undefined>, string]> = [
          [{ ...good, SLASHLOOP_PAPERCLIP_API_URL: undefined }, 'paperclip_url_missing'],
          [{ ...good, SLASHLOOP_PAPERCLIP_API_URL: 'http://paperclip.example.com' }, 'paperclip_url_not_public_https'],
          [{ ...good, SLASHLOOP_PAPERCLIP_AGENT_KEYS: undefined }, 'paperclip_keys_missing'],
          [{ ...good, SLASHLOOP_PAPERCLIP_AGENT_KEYS: 'not json' }, 'paperclip_keys_invalid_json'],
          [{ ...good, SLASHLOOP_PAPERCLIP_AGENT_KEYS: '{"a":""}' }, 'paperclip_keys_empty'],
        ];
        for (const [paperclipEnv, error] of cases) {
          const t = paperclipServer();
          expect(await deliver(row(paperclipNotify()), { ...t, paperclipEnv })).toMatchObject({ ok: false, permanent: false, status: null, error });
          expect(t.calls).toHaveLength(0);
        }
      });
    });

    test('a Paperclip issue id wins over any url in the same notify', async () => {
      const t = paperclipServer();
      await deliver(row({ ...urlNotify(), metadata: { paperclipIssueId: ISSUE, agentId: MARKETING_OPS } }), { ...t, paperclip });
      expect(posts(t)[0]!.url).toContain('/issues');
    });
    test('redactedSnippet masks keys, bearer tokens and long tokens, and caps length', () => {
      expect(redactedSnippet('Bearer abc.def key=SECRETVALUE1 ok', ['SECRETVALUE1'])).toBe('Bearer [redacted] key=[redacted] ok');
      expect(redactedSnippet('a'.repeat(500)).length).toBeLessThanOrEqual(160);
      expect(redactedSnippet(undefined)).toBe('');
    });
    test('env needs a public https API URL and a JSON map of agent keys', () => {
      const env = { SLASHLOOP_PAPERCLIP_API_URL: 'https://paperclip.example.com/api/', SLASHLOOP_PAPERCLIP_AGENT_KEYS: JSON.stringify({ [MARKETING_OPS]: ' k1 ', [MARKETING_OPS_CODEX]: 'k2', empty: '', bad: 5 }) };
      expect(paperclipConfigFromEnv(env)).toEqual({ reason: null, config: { baseUrl: 'https://paperclip.example.com', keys: { [MARKETING_OPS]: 'k1', [MARKETING_OPS_CODEX]: 'k2' } } });
      const reasonOf = (over: Record<string, string>) => paperclipConfigFromEnv({ ...env, ...over }).reason;
      expect(reasonOf({ SLASHLOOP_PAPERCLIP_API_URL: 'http://paperclip.example.com' })).toBe('paperclip_url_not_public_https');
      expect(reasonOf({ SLASHLOOP_PAPERCLIP_API_URL: 'https://10.0.0.5' })).toBe('paperclip_url_not_public_https');
      expect(reasonOf({ SLASHLOOP_PAPERCLIP_API_URL: '' })).toBe('paperclip_url_missing');
      expect(reasonOf({ SLASHLOOP_PAPERCLIP_API_URL: '  ' })).toBe('paperclip_url_missing');
      for (const keys of ['', '  ']) expect(reasonOf({ SLASHLOOP_PAPERCLIP_AGENT_KEYS: keys })).toBe('paperclip_keys_missing');
      for (const keys of ['not json', '[]', '"x"', 'null']) expect(reasonOf({ SLASHLOOP_PAPERCLIP_AGENT_KEYS: keys })).toBe('paperclip_keys_invalid_json');
      for (const keys of ['{}', '{"a":""}', '{"a":5}']) expect(reasonOf({ SLASHLOOP_PAPERCLIP_AGENT_KEYS: keys })).toBe('paperclip_keys_empty');
      expect(paperclipConfigFromEnv({})).toEqual({ config: null, reason: 'paperclip_url_missing' });
    });
    test('the startup line reports url, key count and agent ids, never key values', () => {
      const env = { SLASHLOOP_PAPERCLIP_API_URL: 'https://paperclip.example.com', SLASHLOOP_PAPERCLIP_AGENT_KEYS: JSON.stringify({ [MARKETING_OPS]: 'secret-one', [MARKETING_OPS_CODEX]: 'secret-two' }) };
      const line = describePaperclipEnv(env);
      expect(line).toBe(`paperclip delivery config: url=set board=unset keys=2 agents=[${MARKETING_OPS}, ${MARKETING_OPS_CODEX}] status=ok`);
      expect(line).not.toMatch(/secret|paperclip\.example/);
      expect(describePaperclipEnv({})).toBe('paperclip delivery config: url=unset board=unset keys=0 agents=[] status=paperclip_url_missing');
      expect(describePaperclipEnv({ ...env, SLASHLOOP_PAPERCLIP_AGENT_KEYS: '{bad' })).toContain('board=unset keys=0 agents=[] status=paperclip_keys_invalid_json');
    });
    test('the bridge is gone: its env names are not read', () => {
      const legacy = { SLASHLOOP_PAPERCLIP_API_URL: 'https://paperclip.example.com', SLASHLOOP_PAPERCLIP_API_KEY: 'k', PAPERCLIP_API_KEY_FOR_SLASHLOOP_BRIDGE_AGENT: 'k', SLASHLOOP_PAPERCLIP_COMPANY_ID: 'c', SLASHLOOP_PAPERCLIP_PROJECT_ID: 'p', SLASHLOOP_PAPERCLIP_ASSIGNEE_AGENT_ID: 'a' };
      expect(paperclipConfigFromEnv(legacy).reason).toBe('paperclip_keys_missing');
      expect(readFileSync(new URL('./webhook-delivery.ts', import.meta.url), 'utf8')).not.toMatch(/BRIDGE|ASSIGNEE_AGENT_ID|PAPERCLIP_PROJECT_ID|PAPERCLIP_COMPANY_ID/);
    });
  });
});

describe('backoff', () => {
  test('nine retries spanning about 24h, then the budget is spent', () => {
    expect(MAX_ATTEMPTS).toBe(10);
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(23 * 3_600_000);
    expect(total).toBeLessThan(24 * 3_600_000);
    expect(retryDelayMs(1, () => 0.5)).toBe(30_000);
    expect(retryDelayMs(9, () => 0.5)).toBe(36_000_000);
    expect(retryDelayMs(10)).toBeNull();
  });
  test('jitter stays within +-10%', () => {
    expect(retryDelayMs(3, () => 0)).toBe(540_000);
    expect(retryDelayMs(3, () => 0.999999)).toBe(660_000);
  });
});

describe('runWebhookDeliveries (end to end on SQLite)', () => {
  const T0 = new Date(Date.now() + 5_000);
  async function queue(id: string, notify: NotifyConfig, status: Experiment['status'] = 'review') {
    const e = await create(exp(id, { status: 'generating', workspaceId: 'w1' }), `k-${id}`, notify);
    e.status = status; await save(e);
  }

  test('retries with backoff then delivers; a delivered row is not sent again', async () => {
    await queue('x1', urlNotify());
    let now = T0.getTime();
    const statuses = [503, 200];
    const sent: string[] = [];
    const post: HttpPost = async (_u, h) => { sent.push(h['webhook-id']!); return { status: statuses.shift() ?? 200 }; };
    const sweep = () => runWebhookDeliveries({ run, post, clock: () => new Date(now) });

    expect(await sweep()).toEqual({ delivered: 0, retried: 1, dead: 0 });
    expect(await sweep()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    let r = outbox()[0];
    expect(r).toMatchObject({ state: 'pending', attempts: 1, lastError: 'http_503' });
    expect(new Date(r.nextAttemptAt).getTime() - T0.getTime()).toBeGreaterThanOrEqual(27_000);

    now += 60_000;
    expect(await sweep()).toEqual({ delivered: 1, retried: 0, dead: 0 });
    r = outbox()[0];
    expect(r).toMatchObject({ state: 'delivered', attempts: 2, lastError: null });
    now += 86_400_000;
    expect(await sweep()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expect(sent).toEqual(['x1:review:1', 'x1:review:1']);
  });

  test('a permanent failure goes dead immediately', async () => {
    await queue('x2', urlNotify());
    const post: HttpPost = async () => ({ status: 410 });
    expect(await runWebhookDeliveries({ run, post, clock: () => T0 })).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(outbox()[0]).toMatchObject({ state: 'dead', lastError: 'http_410' });
  });

  test('persistent failure dies after MAX_ATTEMPTS, about a day after the first try', async () => {
    await queue('x3', urlNotify());
    let now = T0.getTime();
    const post: HttpPost = async () => ({ status: 500 });
    let attempts = 0;
    for (let i = 0; i < 20 && outbox()[0].state === 'pending'; i++) {
      const s = await runWebhookDeliveries({ run, post, clock: () => new Date(now) });
      attempts += s.retried + s.dead;
      now += 11 * 3_600_000;
    }
    expect(attempts).toBe(MAX_ATTEMPTS);
    expect(outbox()[0]).toMatchObject({ state: 'dead', attempts: MAX_ATTEMPTS, lastError: 'http_500' });
  });

  test('claims are leased: two concurrent claimers get disjoint rows', async () => {
    await queue('y1', urlNotify()); await queue('y2', urlNotify()); await queue('y3', urlNotify());
    const [a, b] = await Promise.all([claimDue(T0, 2, run), claimDue(T0, 2, run)]);
    const ids = [...a, ...b].map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
    expect(await claimDue(T0, 10, run)).toHaveLength(1);
    expect(await claimDue(T0, 10, run)).toEqual([]);
    expect((await claimDue(new Date(T0.getTime() + 121_000), 10, run)).length).toBe(3);
  });

  test('Paperclip-mode events are delivered as a child task of the originating issue', async () => {
    await queue('pc1', paperclipNotify(), 'failed');
    const calls: string[] = [];
    const get: HttpGet = async (u) => { calls.push(`GET ${u.pathname}`); return { status: 200, body: '{"companyId":"c1"}' }; };
    const post: HttpPost = async (u) => { calls.push(`POST ${u.pathname}`); return { status: 201 }; };
    const paperclip: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: { [MARKETING_OPS]: 'k' } };
    expect(await runWebhookDeliveries({ run, get, post, paperclip, clock: () => T0 })).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(calls).toEqual([`GET /api/issues/${ISSUE}`, 'POST /api/companies/c1/issues']);
  });

  test('the run-context 403 goes dead at once, is logged as a config error, and can be requeued', async () => {
    await queue('pc3', paperclipNotify(), 'failed');
    const get: HttpGet = async () => ({ status: 200, body: '{"companyId":"c1"}' });
    const post: HttpPost = async () => ({ status: 403, body: '{"error":"Cross-issue writes need a run to attribute them to","code":"cross_issue_influence_run_context_required"}' });
    const paperclip: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: { [MARKETING_OPS]: 'k' } };
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try { expect(await runWebhookDeliveries({ run, get, post, paperclip, clock: () => T0 })).toEqual({ delivered: 0, retried: 0, dead: 1 }); } finally { console.error = orig; }
    expect(outbox()[0]).toMatchObject({ state: 'dead', attempts: 1 });
    expect(outbox()[0]!.lastError).toStartWith('paperclip_run_context_required:');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('CONFIG ERROR');
  });

  test('a Paperclip event whose agent has no key goes dead at once with the reason kept', async () => {
    await queue('pc2', paperclipNotify('00000000-0000-4000-8000-000000000000'), 'failed');
    const paperclip: PaperclipConfig = { baseUrl: 'https://paperclip.example.com', keys: { [MARKETING_OPS]: 'k' } };
    expect(await runWebhookDeliveries({ run, paperclip, clock: () => T0 })).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(outbox()[0]).toMatchObject({ state: 'dead', lastError: 'paperclip_agent_key_missing' });
  });

  test('settled rows are pruned after 30 days; pending rows never are', async () => {
    await queue('z1', urlNotify()); await queue('z2', urlNotify());
    await runWebhookDeliveries({ run, limit: 1, post: async () => ({ status: 200 }), clock: () => T0 });
    const later = new Date(T0.getTime() + 31 * 86_400_000);
    await pruneSettled(later, run);
    const left = outbox();
    expect(left).toHaveLength(1);
    expect(left[0].state).toBe('pending');
  });
});
