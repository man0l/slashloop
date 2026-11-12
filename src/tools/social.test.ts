// Social scheduler MCP tools through a real MCP client/server pair, over the
// real store + 0005 migration in an in-memory SQLite (so owner scoping and the
// PROCESSING guards are the actual SQL, not a stub). Only identity resolution
// and the URL upload are injected.
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setActiveClient } from '../store.js';
import { UploadError } from '../social/media-upload.js';
import { searchInstagramAudio } from '../social/audio.js';
import { setPostThumbnail } from '../social/thumbnail.js';
import { defaultSocialDeps, registerSocialTools, type SocialToolDeps } from './social.js';

const NOW_MS = Date.parse('2026-11-01T00:00:00Z');
const FUTURE = '2026-11-03T15:00:00Z';
const FUTURE_S = Date.parse(FUTURE) / 1000;
const LATER = '2026-11-05T09:30:00+02:00';
const IMG = { type: 'image', url: 'https://cdn.example.com/a.jpg' };

let db: Database;
let teams: Record<string, string[]>;
let managed: Record<string, string[]>;
let me: { userId: string; email: string | null } | null;

function deps(over: Partial<SocialToolDeps> = {}): SocialToolDeps {
  return {
    ...defaultSocialDeps,
    caller: () => me,
    resolveOwners: async (userId) => teams[userId] ?? [userId],
    managedOwners: async (userId) => managed[userId] ?? [],
    now: () => NOW_MS,
    connectUrl: () => 'https://site.test/calendar',
    uploadFromUrl: async () => ({ url: 'https://media.test/social/x.jpg', type: 'image', key: 'social/x.jpg', sizeBytes: 12 }),
    ...over,
  };
}

async function call(name: string, args: Record<string, unknown> = {}, over: Partial<SocialToolDeps> = {}) {
  const server = new McpServer({ name: 't', version: '0' });
  registerSocialTools(server, deps(over));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: res.isError ?? false, raw: res.content[0]!.text, body: JSON.parse(res.content[0]!.text) };
}

function addIntegration(id: string, owner: string, provider: string, extra: { refreshNeeded?: number; disabled?: number } = {}) {
  db.run(
    `INSERT INTO social_integrations (id, owner_id, provider, internal_id, profile, name, token, refresh_token, refresh_needed, disabled, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'SECRET-TOKEN', 'SECRET-REFRESH', ?, ?, ?, 0, 0)`,
    [id, owner, provider, id, `${id}_handle`, `${id} name`, extra.refreshNeeded ?? 0, extra.disabled ?? 0, extra.refreshNeeded ? 'token expired' : null],
  );
}

const rowsOf = (groupId: string) =>
  db.query('SELECT owner_id, state, publish_date FROM social_posts WHERE group_id = ? ORDER BY id').all(groupId) as Array<{ owner_id: string; state: string; publish_date: number }>;

async function createDraft(owner = 'alice', integrationIds = ['tt-a']) {
  me = { userId: owner, email: null };
  const { body } = await call('create_social_post', { integrationIds, content: 'hello', media: [IMG] });
  return body.groupId as string;
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of ['0005_social_scheduler.sql', '0025_social_lanes.sql', '0029_social_insights_status.sql']) {
    db.exec(readFileSync(new URL(`../../prisma/d1-migrations/${f}`, import.meta.url), 'utf8'));
  }
  setActiveClient({} as never, async (statements) => statements.map((st) => db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[]));
  teams = {};
  managed = {};
  me = { userId: 'alice', email: null };
  addIntegration('tt-a', 'alice', 'tiktok');
  addIntegration('ig-a', 'alice', 'instagram');
  addIntegration('tt-b', 'bob', 'tiktok');
});
afterEach(() => db.close());

describe('registration', () => {
  test('all ten tools are listed', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerSocialTools(server, deps());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['list_social_accounts', 'upload_social_media', 'create_social_post', 'list_social_posts', 'get_social_stats', 'reschedule_social_post', 'delete_social_post', 'set_social_post_thumbnail', 'search_instagram_audio', 'tag_social_account', 'set_rotation', 'plan_rotation']) {
      expect(names).toContain(n);
    }
    const create = (await client.listTools()).tools.find((t) => t.name === 'create_social_post')!;
    expect(create.description).toContain('CONFIRM FIRST');
  });

  test('refused without an authenticated caller (local stdio)', async () => {
    me = null;
    const { isError, body } = await call('list_social_accounts');
    expect(isError).toBe(true);
    expect(body.error).toBe('auth_required');
  });
});

describe('list_social_accounts', () => {
  test('reports status per account and never leaks tokens', async () => {
    addIntegration('th-a', 'alice', 'threads', { refreshNeeded: 1 });
    addIntegration('pi-a', 'alice', 'pinterest', { disabled: 1 });
    const { raw, body } = await call('list_social_accounts');
    const byId = Object.fromEntries(body.accounts.map((a: { id: string }) => [a.id, a]));
    expect(byId['tt-a'].status).toBe('active');
    expect(byId['th-a']).toMatchObject({ status: 'reconnect_needed', needsReconnect: true, error: 'token expired' });
    expect(byId['pi-a']).toMatchObject({ status: 'disabled', disabled: true });
    expect(byId['tt-b']).toBeUndefined();
    expect(body.usable).toBe(2);
    expect(raw).not.toContain('SECRET');
  });

  test('Instagram accounts report whether insights can be read, and why not', async () => {
    addIntegration('ig-new', 'alice', 'instagram');
    addIntegration('ig-ok', 'alice', 'instagram');
    addIntegration('ig-bad', 'alice', 'instagram');
    db.run("UPDATE social_integrations SET insights_status = 'ok' WHERE id = 'ig-ok'");
    db.run("UPDATE social_integrations SET insights_status = 'personal_account' WHERE id = 'ig-bad'");
    const { body } = await call('list_social_accounts');
    const byId = Object.fromEntries(body.accounts.map((a: { id: string }) => [a.id, a]));
    expect(byId['ig-new'].insights).toBe('unknown');
    expect(byId['ig-ok'].insights).toBe('available');
    expect(byId['ig-bad']).toMatchObject({ insights: 'unavailable', insightsReason: 'personal_account' });
    expect(byId['ig-bad'].insightsHint).toContain('Business/Creator');
    expect(byId['tt-a'].insights).toBeUndefined();
  });

  test('no accounts → connect URL hint', async () => {
    me = { userId: 'nobody', email: null };
    const { isError, body } = await call('list_social_accounts');
    expect(isError).toBe(false);
    expect(body.accounts).toEqual([]);
    expect(body.connectUrl).toBe('https://site.test/calendar');
  });

  test('a teammate\'s accounts are visible through visibleOwnerIds, nobody else\'s', async () => {
    teams.alice = ['alice', 'bob'];
    const { body } = await call('list_social_accounts');
    expect(body.accounts.map((a: { id: string }) => a.id).sort()).toEqual(['ig-a', 'tt-a', 'tt-b']);
  });
});

describe('create_social_post', () => {
  test('omitting publishAt saves a draft (DRAFT rows, no date)', async () => {
    const { isError, body } = await call('create_social_post', { integrationIds: ['tt-a', 'ig-a'], content: ' hi ', media: [IMG] });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ state: 'draft', publishAt: null, accounts: 2, skipped: [] });
    expect(rowsOf(body.groupId)).toEqual([
      { owner_id: 'alice', state: 'DRAFT', publish_date: 0 },
      { owner_id: 'alice', state: 'DRAFT', publish_date: 0 },
    ]);
    expect((db.query('SELECT content FROM social_posts WHERE group_id = ?').get(body.groupId) as { content: string }).content).toBe('hi');
  });

  test('publishAt schedules (QUEUE rows at that instant)', async () => {
    const { body } = await call('create_social_post', { integrationIds: ['tt-a'], content: 'go', media: [IMG], publishAt: FUTURE });
    expect(body).toMatchObject({ state: 'scheduled', publishAt: '2026-11-03T15:00:00.000Z' });
    expect(rowsOf(body.groupId)).toEqual([{ owner_id: 'alice', state: 'QUEUE', publish_date: FUTURE_S }]);
  });

  test('rejects times without an offset, unparseable times and the past', async () => {
    for (const [publishAt, error] of [['2026-11-03T15:00:00', 'invalid_time'], ['soon', 'invalid_time'], ['2026-10-01T00:00:00Z', 'time_in_past']] as const) {
      const { isError, body } = await call('create_social_post', { integrationIds: ['tt-a'], content: 'x', media: [IMG], publishAt });
      expect(isError).toBe(true);
      expect(body.error).toBe(error);
    }
    expect(db.query('SELECT COUNT(*) AS n FROM social_posts').get()).toEqual({ n: 0 });
  });

  test('platforms that reject the post are skipped with their reason; the rest still create', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ type: 'image', url: `https://cdn.example.com/${i}.jpg` }));
    const { body } = await call('create_social_post', { integrationIds: ['tt-a', 'ig-a'], content: 'deck', media: eleven });
    expect(body.accounts).toBe(1);
    expect(body.skipped).toEqual([{ provider: 'instagram', message: expect.stringContaining('at most 10') }]);
    const none = await call('create_social_post', { integrationIds: ['ig-a'], content: 'deck', media: eleven });
    expect(none.isError).toBe(true);
    expect(none.body.error).toBe('invalid_for_provider');
  });

  test('accounts needing a reconnect cannot be targeted', async () => {
    addIntegration('th-a', 'alice', 'threads', { refreshNeeded: 1 });
    const { isError, body } = await call('create_social_post', { integrationIds: ['th-a'], content: 'x', media: [IMG] });
    expect(isError).toBe(true);
    expect(body.error).toBe('no_valid_integrations');
  });

  test('owner scoping: another owner\'s integration id is not usable', async () => {
    const { isError, body } = await call('create_social_post', { integrationIds: ['tt-b'], content: 'x', media: [IMG] });
    expect(isError).toBe(true);
    expect(body.error).toBe('no_valid_integrations');
    expect(db.query('SELECT COUNT(*) AS n FROM social_posts').get()).toEqual({ n: 0 });
  });

  test('a teammate\'s integration is usable; the post is owned by the caller', async () => {
    teams.alice = ['alice', 'bob'];
    const { body } = await call('create_social_post', { integrationIds: ['tt-b'], content: 'x', media: [IMG] });
    expect(rowsOf(body.groupId)).toEqual([{ owner_id: 'alice', state: 'DRAFT', publish_date: 0 }]);
  });

  test('stripMetadata queues through SCRUB and marks the media', async () => {
    const { body } = await call('create_social_post', { integrationIds: ['tt-a'], content: 'x', media: [IMG], publishAt: FUTURE, stripMetadata: true });
    expect(rowsOf(body.groupId)[0]!.state).toBe('SCRUB');
    expect((db.query('SELECT media FROM social_posts WHERE group_id = ?').get(body.groupId) as { media: string }).media).toContain('"scrub":true');
  });
});

describe('get_social_stats', () => {
  test('returns per-account buckets for the caller, defaulting to the last 30 days', async () => {
    for (const f of ['0026_social_post_metrics.sql', '0027_social_post_more_metrics.sql', '0031_social_post_metrics_daily.sql']) {
      db.exec(readFileSync(new URL(`../../prisma/d1-migrations/${f}`, import.meta.url), 'utf8'));
    }
    db.run(`INSERT INTO social_posts (id, group_id, owner_id, integration_id, provider, state, publish_date, content, attempts, created_at, updated_at, published_at, views)
            VALUES ('p', 'g', 'alice', 'tt-a', 'tiktok', 'PUBLISHED', 0, 'x', 0, 0, 0, ${Date.parse('2026-10-30T10:00:00Z') / 1000}, 42),
                   ('pb', 'g', 'bob', 'tt-b', 'tiktok', 'PUBLISHED', 0, 'x', 0, 0, 0, ${Date.parse('2026-10-30T10:00:00Z') / 1000}, 999)`);
    const { isError, body } = await call('get_social_stats', { mode: 'posted', bucket: 'week' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ mode: 'posted', bucket: 'week', trackingSince: null });
    expect(body.accounts.map((a: { id: string }) => a.id).sort()).toEqual(['ig-a', 'tt-a']);
    expect(body.buckets.find((b: { start: string }) => b.start === '2026-10-26').byAccount).toEqual({ 'tt-a': 42, 'ig-a': 0 });

    const filtered = await call('get_social_stats', { accounts: ['ig-a'], from: '2026-10-28', to: '2026-11-01' });
    expect(filtered.body.accounts.map((a: { id: string }) => a.id)).toEqual(['ig-a']);
    expect(filtered.body.buckets).toHaveLength(5);
  });

  test('rejects a range over 400 days and refuses without a caller', async () => {
    const tooBig = await call('get_social_stats', { from: '2025-01-01', to: '2026-11-01' });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.body.error).toBe('range_too_large');
    me = null;
    expect((await call('get_social_stats')).isError).toBe(true);
  });
});

describe('list_social_posts', () => {
  test('returns scheduled posts in range plus drafts, with ISO times', async () => {
    const draft = await createDraft();
    const sched = (await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: FUTURE })).body.groupId;
    const outside = (await call('create_social_post', { integrationIds: ['tt-a'], content: 'o', media: [IMG], publishAt: '2027-03-01T00:00:00Z' })).body.groupId;

    const { body } = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(body.posts.map((p: { groupId: string }) => p.groupId)).toEqual([sched]);
    expect(body.posts[0]).toMatchObject({ state: 'queued', publishAt: '2026-11-03T15:00:00.000Z' });
    expect(body.drafts.map((p: { groupId: string }) => p.groupId)).toEqual([draft]);
    expect(body.drafts[0]).toMatchObject({ state: 'draft', publishAt: null });
    expect(JSON.stringify(body)).not.toContain(outside);
  });

  test('echoes a video thumbnail on each media item', async () => {
    const video = { type: 'video', url: 'https://cdn.example.com/c.mp4', thumbnail: 'https://cdn.example.com/c.jpg' };
    await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [video], publishAt: FUTURE });
    const { body } = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(body.posts[0].media).toEqual([video]);
  });

  test('defaults to now → +30 days', async () => {
    await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: FUTURE });
    const { body } = await call('list_social_posts');
    expect(body.range).toEqual({ from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' });
    expect(body.posts).toHaveLength(1);
  });

  test('owner scoping: another owner sees none of it; a teammate sees it', async () => {
    const draft = await createDraft();
    const sched = (await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: FUTURE })).body.groupId;

    me = { userId: 'bob', email: null };
    const bobView = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(bobView.body.posts).toEqual([]);
    expect(bobView.body.drafts).toEqual([]);

    teams.bob = ['bob', 'alice'];
    const teamView = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(teamView.body.posts.map((p: { groupId: string }) => p.groupId)).toEqual([sched]);
    expect(teamView.body.drafts.map((p: { groupId: string }) => p.groupId)).toEqual([draft]);
  });

  test('compact output without account pictures (SLA-1508)', async () => {
    db.run("UPDATE social_integrations SET picture = 'https://cdn.example.com/avatar.jpg?sig=xyz' WHERE id = 'tt-a'");
    await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: FUTURE });
    const { raw, body } = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(raw).not.toContain('\n');
    expect(raw).not.toContain('avatar.jpg');
    expect(body.posts[0].posts[0].account).toEqual({ id: 'tt-a', name: 'tt-a name', profile: 'tt-a_handle', lane: null });
  });

  test('limit caps each list and reports truncated + nextFrom; paging with nextFrom reads the rest', async () => {
    const times = ['2026-11-03T15:00:00Z', '2026-11-04T15:00:00Z', '2026-11-05T15:00:00Z'];
    const ids: string[] = [];
    for (const t of times) ids.push((await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: t })).body.groupId);
    await createDraft();
    await createDraft();

    const first = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z', limit: 2 });
    expect(first.body.posts.map((p: { groupId: string }) => p.groupId)).toEqual(ids.slice(0, 2));
    expect(first.body.drafts).toHaveLength(2);
    expect(first.body.truncated).toEqual({ posts: 1, nextFrom: '2026-11-05T15:00:00.000Z' });

    const next = await call('list_social_posts', { from: first.body.truncated.nextFrom, to: '2026-11-30T00:00:00Z', limit: 2 });
    expect(next.body.posts.map((p: { groupId: string }) => p.groupId)).toEqual([ids[2]]);
    expect(next.body.truncated).toBeUndefined();
  });

  test('state and lane filters', async () => {
    await createDraft();
    const queued = (await call('create_social_post', { integrationIds: ['tt-a'], content: 's', media: [IMG], publishAt: FUTURE })).body.groupId;
    await call('tag_social_account', { integrationId: 'ig-a', tags: ['lane:jenny'] });
    const jenny = (await call('create_social_post', { lane: 'jenny', content: 'j', media: [IMG], publishAt: LATER })).body.groupId;
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' };

    const onlyQueued = await call('list_social_posts', { ...range, state: ['queued'] });
    expect(onlyQueued.body.posts.map((p: { groupId: string }) => p.groupId)).toEqual([queued, jenny]);
    expect(onlyQueued.body.drafts).toEqual([]);

    const lane = await call('list_social_posts', { ...range, lane: 'Jenny' });
    expect(lane.body.posts.map((p: { groupId: string }) => p.groupId)).toEqual([jenny]);
    expect(lane.body.drafts).toEqual([]);

    const bad = await call('list_social_posts', { ...range, lane: 'not a lane!' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBe('invalid_lane');
  });

  test('rejects an inverted range', async () => {
    const { isError, body } = await call('list_social_posts', { from: FUTURE, to: '2026-11-01T00:00:00Z' });
    expect(isError).toBe(true);
    expect(body.error).toBe('invalid_range');
  });
});

describe('reschedule_social_post', () => {
  test('moves a draft without scheduling it', async () => {
    const groupId = await createDraft();
    const { isError, body } = await call('reschedule_social_post', { groupId, publishAt: LATER });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ groupId, updated: 1, publishAt: '2026-11-05T07:30:00.000Z' });
    expect(rowsOf(groupId)).toEqual([{ owner_id: 'alice', state: 'DRAFT', publish_date: Date.parse(LATER) / 1000 }]);
  });

  test('schedule=true promotes a draft to QUEUE', async () => {
    const groupId = await createDraft();
    const { body } = await call('reschedule_social_post', { groupId, publishAt: FUTURE, schedule: true });
    expect(body).toMatchObject({ updated: 1, state: 'scheduled' });
    expect(rowsOf(groupId)).toEqual([{ owner_id: 'alice', state: 'QUEUE', publish_date: FUTURE_S }]);
  });

  test('moves a queued group to a new time', async () => {
    const groupId = (await call('create_social_post', { integrationIds: ['tt-a', 'ig-a'], content: 'q', media: [IMG], publishAt: FUTURE })).body.groupId;
    const { body } = await call('reschedule_social_post', { groupId, publishAt: LATER });
    expect(body.updated).toBe(2);
    expect(rowsOf(groupId).every((r) => r.publish_date === Date.parse(LATER) / 1000 && r.state === 'QUEUE')).toBe(true);
  });

  test('surfaces the 409 case: a PROCESSING row blocks the move and nothing changes', async () => {
    const groupId = (await call('create_social_post', { integrationIds: ['tt-a', 'ig-a'], content: 'q', media: [IMG], publishAt: FUTURE })).body.groupId;
    db.run("UPDATE social_posts SET state = 'PROCESSING' WHERE group_id = ? AND provider = 'tiktok'", [groupId]);
    const { isError, body } = await call('reschedule_social_post', { groupId, publishAt: LATER });
    expect(isError).toBe(true);
    expect(body.error).toBe('processing');
    expect(body.message).toContain('publishing right now');
    expect(rowsOf(groupId).map((r) => [r.state, r.publish_date]).sort()).toEqual([['PROCESSING', FUTURE_S], ['QUEUE', FUTURE_S]]);
  });

  test('owner scoping: another owner cannot reschedule (not_found, rows untouched)', async () => {
    const groupId = await createDraft('alice');
    me = { userId: 'bob', email: null };
    const { isError, body } = await call('reschedule_social_post', { groupId, publishAt: FUTURE, schedule: true });
    expect(isError).toBe(true);
    expect(body.error).toBe('not_found');
    expect(rowsOf(groupId)).toEqual([{ owner_id: 'alice', state: 'DRAFT', publish_date: 0 }]);
  });

  test('three consecutive reschedules of a draft each match list_social_posts', async () => {
    const groupId = await createDraft();
    for (const at of ['2026-11-07T13:00:00Z', '2026-11-07T17:00:00Z', '2026-11-07T23:00:00Z']) {
      const { isError, body } = await call('reschedule_social_post', { groupId, publishAt: at });
      expect(isError).toBe(false);
      expect(body.publishAt).toBe(new Date(at).toISOString());
      const listed = await call('list_social_posts', { from: '2026-11-07T00:00:00Z', to: '2026-11-08T00:00:00Z' });
      expect(listed.body.drafts.find((g: { groupId: string }) => g.groupId === groupId).publishAt).toBe(body.publishAt);
    }
  });

  test('a write that reports success but is not stored fails loudly (SLA-1276)', async () => {
    const groupId = (await call('create_social_post', { integrationIds: ['tt-a'], content: 'q', media: [IMG], publishAt: FUTURE })).body.groupId;
    // Executor that swallows the reschedule UPDATE yet still answers `SELECT changes()` with a stale 1.
    setActiveClient({} as never, async (statements) => statements.map((st) => {
      if (st.sql.includes('UPDATE social_posts SET publish_date')) return [];
      if (st.sql.includes('changes()')) return [{ n: 1 }];
      return db.query(st.sql).all(...((st.params ?? []) as never[])) as unknown[];
    }));
    const { isError, body } = await call('reschedule_social_post', { groupId, publishAt: LATER });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'not_persisted', requested: '2026-11-05T07:30:00.000Z' });
    expect(body.stored).toEqual([new Date(FUTURE_S * 1000).toISOString()]);
  });

  test('rejects past times, and unknown group ids are not_found', async () => {
    const groupId = await createDraft();
    expect((await call('reschedule_social_post', { groupId, publishAt: '2026-01-01T00:00:00Z' })).body.error).toBe('time_in_past');
    expect((await call('reschedule_social_post', { groupId: 'nope', publishAt: FUTURE })).body.error).toBe('not_found');
  });
});

describe('delete_social_post', () => {
  test('deletes every row of the group', async () => {
    const groupId = await createDraft('alice', ['tt-a', 'ig-a']);
    const { isError, body } = await call('delete_social_post', { groupId });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ deleted: 2, remainingProcessing: 0 });
    expect(rowsOf(groupId)).toEqual([]);
  });

  test('PROCESSING rows stay and are reported; the rest are deleted', async () => {
    const groupId = (await call('create_social_post', { integrationIds: ['tt-a', 'ig-a'], content: 'q', media: [IMG], publishAt: FUTURE })).body.groupId;
    db.run("UPDATE social_posts SET state = 'PROCESSING' WHERE group_id = ? AND provider = 'tiktok'", [groupId]);
    const { isError, body } = await call('delete_social_post', { groupId });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'processing', deleted: 1, remainingProcessing: 1 });
    expect(rowsOf(groupId)).toEqual([{ owner_id: 'alice', state: 'PROCESSING', publish_date: FUTURE_S }]);
  });

  test('owner scoping: another owner cannot delete (not_found, rows survive)', async () => {
    const groupId = await createDraft('alice');
    me = { userId: 'bob', email: null };
    const { isError, body } = await call('delete_social_post', { groupId });
    expect(isError).toBe(true);
    expect(body.error).toBe('not_found');
    expect(rowsOf(groupId)).toHaveLength(1);
  });

  test('unknown group id is not_found', async () => {
    expect((await call('delete_social_post', { groupId: 'nope' })).body.error).toBe('not_found');
  });
});

describe('upload_social_media', () => {
  test('returns the stored public URL', async () => {
    const { isError, body } = await call('upload_social_media', { url: 'https://cdn.example.com/a.jpg' }, {
      uploadFromUrl: async () => ({ url: 'https://media.test/social/1-ab.jpg', type: 'image', key: 'social/1-ab.jpg', sizeBytes: 99 }),
    });
    expect(isError).toBe(false);
    expect(body).toEqual({ url: 'https://media.test/social/1-ab.jpg', type: 'image', sizeBytes: 99, sourceUrl: 'https://cdn.example.com/a.jpg' });
  });

  test('maps upload failures to structured errors', async () => {
    const { isError, body } = await call('upload_social_media', { url: 'https://cdn.example.com/a.gif' }, {
      uploadFromUrl: async () => { throw new UploadError('unsupported_type', 'Unsupported media type: image/gif', { type: 'image/gif' }); },
    });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'unsupported_type', type: 'image/gif' });
  });
});

describe('lanes block + create_social_post({ lane })', () => {
  const VID = { type: 'video', url: 'https://cdn.example.com/a.mp4' };

  async function setupJenny() {
    addIntegration('yt-a', 'alice', 'youtube');
    addIntegration('pi-a', 'alice', 'pinterest');
    await call('tag_social_account', { integrationId: 'ig-a', tags: ['lane:jenny', 'primary'] });
    await call('tag_social_account', { integrationId: 'yt-a', tags: ['lane:jenny'] });
    await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:alice', 'primary'] });
  }

  test('list_social_accounts returns one lanes entry per lane plus untagged', async () => {
    await setupJenny();
    const { body } = await call('list_social_accounts');
    expect(body.lanes.map((l: { lane: string }) => l.lane)).toEqual(['alice', 'jenny']);
    expect(body.lanes[1]).toEqual({
      lane: 'jenny',
      primary: { integrationId: 'ig-a', provider: 'instagram', handle: 'ig-a_handle' },
      members: [
        { integrationId: 'ig-a', provider: 'instagram', handle: 'ig-a_handle', role: 'primary', status: 'active' },
        { integrationId: 'yt-a', provider: 'youtube', handle: 'yt-a_handle', role: 'repost', status: 'active' },
      ],
      healthy: true,
    });
    expect(body.untagged).toEqual([{ integrationId: 'pi-a', provider: 'pinterest', handle: 'pi-a_handle', status: 'active' }]);
  });

  test('a lane whose primary needs a reconnect reports healthy:false', async () => {
    await setupJenny();
    db.run("UPDATE social_integrations SET refresh_needed = 1 WHERE id = 'ig-a'");
    const { body } = await call('list_social_accounts');
    const jenny = body.lanes.find((l: { lane: string }) => l.lane === 'jenny');
    expect(jenny.healthy).toBe(false);
    expect(jenny.members[0]).toMatchObject({ integrationId: 'ig-a', status: 'reconnect_needed' });
  });

  test('lane expands to every active member, primary first, and echoes lane + ids', async () => {
    await setupJenny();
    const { isError, body } = await call('create_social_post', { lane: 'Jenny', content: 'hi', media: [VID], publishAt: FUTURE });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ lane: 'jenny', integrationIds: ['ig-a', 'yt-a'], accounts: 2, state: 'scheduled' });
    const rows = db.query('SELECT integration_id, publish_date FROM social_posts WHERE group_id = ?').all(body.groupId) as Array<{ integration_id: string; publish_date: number }>;
    expect(rows.map((r) => r.integration_id).sort()).toEqual(['ig-a', 'yt-a']);
    expect(new Set(rows.map((r) => r.publish_date))).toEqual(new Set([FUTURE_S]));
  });

  test('inactive non-primary members are left out of the expansion', async () => {
    await setupJenny();
    db.run("UPDATE social_integrations SET disabled = 1 WHERE id = 'yt-a'");
    const { body } = await call('create_social_post', { lane: 'jenny', content: 'hi', media: [VID], publishAt: FUTURE });
    expect(body.integrationIds).toEqual(['ig-a']);
  });

  test('lane_not_found when nothing carries the tag (or the name is invalid)', async () => {
    await setupJenny();
    for (const lane of ['spoon', 'Bad Name!']) {
      const { isError, body } = await call('create_social_post', { lane, content: 'hi', media: [VID] });
      expect(isError).toBe(true);
      expect(body.error).toBe('lane_not_found');
    }
    expect(db.query('SELECT COUNT(*) AS n FROM social_posts').get()).toEqual({ n: 0 });
  });

  test('lane_unhealthy when the primary is reconnect_needed or disabled; nothing is created', async () => {
    await setupJenny();
    for (const col of ['refresh_needed', 'disabled']) {
      db.run(`UPDATE social_integrations SET ${col} = 1 WHERE id = 'ig-a'`);
      const { isError, body } = await call('create_social_post', { lane: 'jenny', content: 'hi', media: [VID], publishAt: FUTURE });
      expect(isError).toBe(true);
      expect(body).toMatchObject({ error: 'lane_unhealthy', lane: 'jenny', integrationId: 'ig-a' });
      db.run(`UPDATE social_integrations SET ${col} = 0 WHERE id = 'ig-a'`);
    }
    expect(db.query('SELECT COUNT(*) AS n FROM social_posts').get()).toEqual({ n: 0 });
  });

  test('exactly one of lane / integrationIds', async () => {
    await setupJenny();
    for (const args of [{}, { lane: 'jenny', integrationIds: ['ig-a'] }]) {
      const { isError, body } = await call('create_social_post', { ...args, content: 'hi', media: [VID] });
      expect(isError).toBe(true);
      expect(body.error).toBe('invalid_target');
    }
  });

  test('a Pinterest member without a board is skipped with its reason', async () => {
    await setupJenny();
    await call('tag_social_account', { integrationId: 'pi-a', tags: ['lane:jenny'] });
    const { body } = await call('create_social_post', { lane: 'jenny', content: 'hi', media: [VID], publishAt: FUTURE });
    expect(body.skipped.map((s: { provider: string }) => s.provider)).toEqual(['pinterest']);
    expect(body.accounts).toBe(2);
  });

  test('list_social_posts carries account.lane', async () => {
    await setupJenny();
    await call('create_social_post', { lane: 'jenny', content: 'hi', media: [VID], publishAt: FUTURE });
    const { body } = await call('list_social_posts', { from: '2026-11-01T00:00:00Z', to: '2026-11-10T00:00:00Z' });
    const lanes = body.posts[0].posts.map((p: { account: { lane: string | null } }) => p.account.lane);
    expect(lanes).toEqual(['jenny', 'jenny']);
  });
});

describe('lanes: tag_social_account + list_social_accounts', () => {
  test('list exposes tags / lane / primary (untagged → [] / null / false)', async () => {
    await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:jenny', 'primary'] });
    await call('tag_social_account', { integrationId: 'ig-a', tags: ['lane:jenny'] });
    addIntegration('th-a', 'alice', 'threads');
    const { body } = await call('list_social_accounts');
    const byId = Object.fromEntries(body.accounts.map((a: { id: string }) => [a.id, a]));
    expect(byId['tt-a']).toMatchObject({ tags: ['lane:jenny', 'primary'], lane: 'jenny', primary: true });
    expect(byId['ig-a']).toMatchObject({ tags: ['lane:jenny'], lane: 'jenny', primary: false });
    expect(byId['th-a']).toMatchObject({ tags: [], lane: null, primary: false });
  });

  test('replaces the tag list and [] clears it', async () => {
    await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:a'] });
    await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:b'] });
    expect((db.query('SELECT tags FROM social_integrations WHERE id = ?').get('tt-a') as { tags: string }).tags).toBe('["lane:b"]');
    const { body } = await call('tag_social_account', { integrationId: 'tt-a', tags: [] });
    expect(body).toMatchObject({ tags: [], lane: null, primary: false });
    expect((db.query('SELECT tags FROM social_integrations WHERE id = ?').get('tt-a') as { tags: string | null }).tags).toBeNull();
  });

  test('vocabulary: unknown tag, two lanes, bare primary', async () => {
    for (const [tags, error] of [[['funny'], 'invalid_tag'], [['lane:a', 'lane:b'], 'invalid_tag'], [['primary'], 'primary_needs_lane']] as const) {
      const { isError, body } = await call('tag_social_account', { integrationId: 'tt-a', tags: [...tags] });
      expect(isError).toBe(true);
      expect(body.error).toBe(error);
    }
  });

  test('one primary per lane across visible accounts', async () => {
    await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:jenny', 'primary'] });
    const clash = await call('tag_social_account', { integrationId: 'ig-a', tags: ['lane:jenny', 'primary'] });
    expect(clash.isError).toBe(true);
    expect(clash.body).toMatchObject({ error: 'lane_has_primary', primaryIntegrationId: 'tt-a' });
    const other = await call('tag_social_account', { integrationId: 'ig-a', tags: ['lane:alice', 'primary'] });
    expect(other.isError).toBe(false);
    const again = await call('tag_social_account', { integrationId: 'tt-a', tags: ['lane:jenny', 'primary'] });
    expect(again.isError).toBe(false);
  });

  test('a teammate who only shares in cannot tag; the workspace owner can', async () => {
    teams.alice = ['alice', 'bob'];
    const refused = await call('tag_social_account', { integrationId: 'tt-b', tags: ['lane:x'] });
    expect(refused.isError).toBe(true);
    expect(refused.body.error).toBe('not_owner');
    expect((db.query('SELECT tags FROM social_integrations WHERE id = ?').get('tt-b') as { tags: string | null }).tags).toBeNull();

    managed.alice = ['bob'];
    const ok = await call('tag_social_account', { integrationId: 'tt-b', tags: ['lane:x'] });
    expect(ok.isError).toBe(false);
    expect(ok.body.lane).toBe('x');
  });

  test('an account the caller cannot see is not_found, not a tag', async () => {
    const { isError, body } = await call('tag_social_account', { integrationId: 'tt-b', tags: ['lane:x'] });
    expect(isError).toBe(true);
    expect(body.error).toBe('not_found');
  });
});

describe('rotations: set_rotation + plan_rotation', () => {
  const ROT = { name: 'maxxing', lanes: ['jenny', 'alice', 'spoon'], anchorMonday: '2026-11-02' };

  async function tagPersonas() {
    for (const l of ['jenny', 'alice', 'spoon']) {
      addIntegration(`${l}-ig`, 'alice', 'instagram');
      addIntegration(`${l}-yt`, 'alice', 'youtube');
      await call('tag_social_account', { integrationId: `${l}-ig`, tags: [`lane:${l}`, 'primary'] });
      await call('tag_social_account', { integrationId: `${l}-yt`, tags: [`lane:${l}`] });
    }
  }

  test('set_rotation upserts by (owner, name) and validates', async () => {
    await tagPersonas();
    const first = await call('set_rotation', ROT);
    expect(first.body).toMatchObject({ created: true, warnings: [], rotation: { ...ROT, periodDays: 7, timezone: 'America/New_York' } });
    const second = await call('set_rotation', { ...ROT, lanes: ['spoon', 'jenny'] });
    expect(second.body.created).toBe(false);
    expect((db.query('SELECT COUNT(*) AS n FROM social_rotations').get() as { n: number }).n).toBe(1);

    for (const [over, error] of [
      [{ anchorMonday: '2026-11-03' }, 'anchor_not_monday'],
      [{ anchorMonday: '2026-02-30' }, 'invalid_anchor'],
      [{ lanes: [] }, 'invalid_lanes'],
      [{ lanes: ['a', 'A'] }, 'invalid_lanes'],
      [{ timezone: 'Mars/Base' }, 'invalid_timezone'],
    ] as const) {
      const r = await call('set_rotation', { ...ROT, ...over });
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe(error);
    }
  });

  test('set_rotation warns (does not fail) about lanes nobody is tagged into', async () => {
    await tagPersonas();
    const { isError, body } = await call('set_rotation', { ...ROT, lanes: ['jenny', 'ghost'] });
    expect(isError).toBe(false);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('ghost');
  });

  test('plan_rotation returns the week pattern, writes nothing, and keeps untagged accounts out', async () => {
    await tagPersonas();
    await call('set_rotation', ROT);
    const postsBefore = (db.query('SELECT COUNT(*) AS n FROM social_posts').get() as { n: number }).n;
    const { isError, body } = await call('plan_rotation', { rotation: 'maxxing', from: '2026-11-02', days: 8, slots: ['09:00', '13:00', '19:00'] });
    expect(isError).toBe(false);
    expect(body.problems).toEqual([]);
    expect(body.rotation).toMatchObject({ name: 'maxxing', lanes: ['jenny', 'alice', 'spoon'] });
    expect(body.rows).toHaveLength(8 * 3 * 2);
    expect(body.rows.slice(0, 2)).toEqual([
      { date: '2026-11-02', week: 0, video: 1, lane: 'jenny', integrationId: 'jenny-ig', provider: 'instagram', handle: 'jenny-ig_handle', role: 'primary', publishAt: '2026-11-02T14:00:00.000Z' },
      { date: '2026-11-02', week: 0, video: 1, lane: 'jenny', integrationId: 'jenny-yt', provider: 'youtube', handle: 'jenny-yt_handle', role: 'repost', publishAt: '2026-11-02T14:00:00.000Z' },
    ]);
    const nov9v2 = body.rows.find((r: { date: string; video: number; role: string }) => r.date === '2026-11-09' && r.video === 2 && r.role === 'primary');
    expect(nov9v2).toMatchObject({ lane: 'jenny', week: 1, publishAt: '2026-11-09T18:00:00.000Z' });
    expect(body.rows.some((r: { integrationId: string }) => ['tt-a', 'ig-a'].includes(r.integrationId))).toBe(false);
    expect((db.query('SELECT COUNT(*) AS n FROM social_posts').get() as { n: number }).n).toBe(postsBefore);
  });

  test('plan_rotation moves a video off an unhealthy primary and says so', async () => {
    await tagPersonas();
    await call('set_rotation', ROT);
    db.run("UPDATE social_integrations SET refresh_needed = 1 WHERE id = 'alice-ig'");
    const { body } = await call('plan_rotation', { rotation: 'maxxing', from: '2026-11-02', days: 1, slots: ['09:00', '13:00', '19:00'] });
    expect(body.problems).toContain('lane alice: primary unhealthy on 2026-11-02, video 2 moved to spoon');
    expect(body.rows.filter((r: { lane: string; integrationId: string }) => r.lane === 'spoon' && r.integrationId === 'spoon-ig')).toHaveLength(2);
  });

  test('plan_rotation errors: unknown rotation, bad date, bad slot', async () => {
    const missing = await call('plan_rotation', { rotation: 'nope', from: '2026-11-02', days: 1, slots: ['09:00'] });
    expect(missing.body.error).toBe('rotation_not_found');
    await tagPersonas();
    await call('set_rotation', ROT);
    expect((await call('plan_rotation', { rotation: 'maxxing', from: '11/02/2026', days: 1, slots: ['09:00'] })).body.error).toBe('invalid_date');
    expect((await call('plan_rotation', { rotation: 'maxxing', from: '2026-11-02', days: 1, slots: ['9am'] })).body.error).toBe('invalid_slots');
  });
});

describe('set_social_post_thumbnail', () => {
  const COVER = 'https://cdn.example.com/cover.jpg';
  const VIDEO = { type: 'video', url: 'https://cdn.example.com/c.mp4' };
  const RANGE = { from: '2026-11-01T00:00:00Z', to: '2026-12-30T00:00:00Z' };
  const cfg = { youtube: { clientId: 'cid', clientSecret: 'sec' } };
  const realFetch = globalThis.fetch;
  let requests: Array<{ url: string; method: string; auth: string | null; type: string | null; bytes: number }>;

  const withThumbnail = (over: Partial<SocialToolDeps> = {}) => ({
    setThumbnail: (owners: string[], target: { groupId?: string; postId?: string }, url: string) => setPostThumbnail(cfg, owners, target, url, NOW_MS / 1000),
    ...over,
  });

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === COVER) return new Response(new Uint8Array(1234), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      requests.push({
        url,
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('authorization'),
        type: new Headers(init?.headers).get('content-type'),
        bytes: (init?.body as ArrayBuffer | undefined)?.byteLength ?? 0,
      });
      return new Response('{"items":[{}]}', { status: 200 });
    }) as typeof fetch;
    addIntegration('yt-a', 'alice', 'youtube');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function publishedGroup(integrationIds: string[]) {
    const { body } = await call('create_social_post', { integrationIds, content: 'c', media: [VIDEO], publishAt: FUTURE });
    db.run("UPDATE social_posts SET state = 'PUBLISHED', release_id = 'VID123' WHERE group_id = ?", [body.groupId]);
    return body.groupId as string;
  }

  test('published YouTube post: thumbnails.set is called and list_social_posts echoes the thumbnail', async () => {
    const groupId = await publishedGroup(['yt-a']);
    const { isError, body } = await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(false);
    expect(body.results).toEqual([expect.objectContaining({ provider: 'youtube', status: 'updated' })]);
    expect(requests).toEqual([
      { url: 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=VID123&uploadType=media', method: 'POST', auth: 'Bearer SECRET-TOKEN', type: 'image/jpeg', bytes: 1234 },
    ]);
    const listed = await call('list_social_posts', RANGE);
    expect(listed.body.posts[0].media).toEqual([{ ...VIDEO, thumbnail: COVER }]);
  });

  test('a thumbnail set only on the YouTube row is echoed even when another row comes first', async () => {
    const groupId = await publishedGroup(['ig-a', 'yt-a']);
    const postId = (db.query("SELECT id FROM social_posts WHERE group_id = ? AND provider = 'youtube'").get(groupId) as { id: string }).id;
    const { isError, body } = await call('set_social_post_thumbnail', { postId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(false);
    expect(body.results).toHaveLength(1);
    const listed = await call('list_social_posts', RANGE);
    expect(listed.body.posts[0].media[0].thumbnail).toBe(COVER);
    const ig = db.query("SELECT media FROM social_posts WHERE group_id = ? AND provider = 'instagram'").get(groupId) as { media: string };
    expect(ig.media).not.toContain(COVER);
  });

  test('published Instagram post: clear "not supported" error, nothing stored or called', async () => {
    const groupId = await publishedGroup(['ig-a']);
    const { isError, body } = await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(true);
    expect(body.error).toBe('not_supported');
    expect(body.message).toContain('Not supported by Instagram');
    expect(requests).toEqual([]);
    expect((db.query('SELECT media FROM social_posts WHERE group_id = ?').get(groupId) as { media: string }).media).not.toContain(COVER);
  });

  test('mixed group: YouTube updates, Instagram reports unsupported, call still succeeds', async () => {
    const groupId = await publishedGroup(['ig-a', 'yt-a']);
    const { isError, body } = await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(false);
    expect(body.results.map((r: { provider: string; status: string }) => `${r.provider}:${r.status}`).sort()).toEqual(['instagram:unsupported', 'youtube:updated']);
  });

  test('queued group: thumbnail is stored on the video for publish time, no platform call', async () => {
    const { body: created } = await call('create_social_post', { integrationIds: ['yt-a', 'ig-a'], content: 'c', media: [VIDEO], publishAt: FUTURE });
    const { isError, body } = await call('set_social_post_thumbnail', { groupId: created.groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(false);
    expect(body.results.every((r: { status: string }) => r.status === 'saved')).toBe(true);
    expect(requests).toEqual([]);
    const listed = await call('list_social_posts', RANGE);
    expect(listed.body.posts[0].media).toEqual([{ ...VIDEO, thumbnail: COVER }]);
  });

  test('YouTube rejection surfaces as thumbnail_failed and stores nothing', async () => {
    const groupId = await publishedGroup(['yt-a']);
    globalThis.fetch = (async (input: string | URL | Request) =>
      String(input) === COVER
        ? new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'image/jpeg' } })
        : new Response('{"error":{"message":"The authenticated user cannot upload custom video thumbnails."}}', { status: 403 })) as typeof fetch;
    const { isError, body } = await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(true);
    expect(body.error).toBe('thumbnail_failed');
    expect(body.message).toContain('custom video thumbnails');
    expect((db.query('SELECT media FROM social_posts WHERE group_id = ?').get(groupId) as { media: string }).media).not.toContain(COVER);
  });

  test('a PROCESSING post is not touched', async () => {
    const groupId = await publishedGroup(['yt-a']);
    db.run("UPDATE social_posts SET state = 'PROCESSING' WHERE group_id = ?", [groupId]);
    const { isError, body } = await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail());
    expect(isError).toBe(true);
    expect(body.error).toBe('processing');
  });

  test('another owner\'s group is not found; missing target and private URLs are rejected', async () => {
    const groupId = await publishedGroup(['yt-a']);
    me = { userId: 'bob', email: null };
    expect((await call('set_social_post_thumbnail', { groupId, thumbnail: COVER }, withThumbnail())).body.error).toBe('not_found');
    me = { userId: 'alice', email: null };
    expect((await call('set_social_post_thumbnail', { thumbnail: COVER }, withThumbnail())).body.error).toBe('missing_target');
    expect((await call('set_social_post_thumbnail', { groupId, thumbnail: 'http://127.0.0.1/x.jpg' }, withThumbnail())).body.error).toBe('invalid_thumbnail');
  });
});

describe('search_instagram_audio', () => {
  const realFetch = globalThis.fetch;
  let urls: URL[];
  const search = (owners: string[], id: string, query: string | undefined, limit: number) =>
    searchInstagramAudio({ instagramFb: { clientId: 'FBID', clientSecret: 'FBSECRET' } }, owners, id, query, limit, NOW_MS / 1000);

  beforeEach(() => {
    urls = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(new URL(String(url)));
      return new Response(JSON.stringify({ audio: [{ audio_id: '42', title: 'Track', display_artist: 'Band', duration_in_ms: 61000 }] }), { status: 200 });
    }) as typeof fetch;
    addIntegration('igfb-a', 'alice', 'instagram_fb');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('is registered and returns id/title/artist/duration, trending without a query', async () => {
    const { isError, body } = await call('search_instagram_audio', { accountId: 'igfb-a' }, { searchAudio: search });
    expect(isError).toBe(false);
    expect(body).toEqual({ account: 'igfb-a_handle', trending: true, tracks: [{ id: '42', title: 'Track', artist: 'Band', durationMs: 61000 }] });
    expect(urls[0].pathname).toEndWith('/ig_audio');
    expect(urls[0].searchParams.get('user_id')).toBe('igfb-a');
    expect(urls[0].searchParams.has('search_query')).toBe(false);
  });

  test('passes the query through', async () => {
    const { body } = await call('search_instagram_audio', { accountId: 'igfb-a', query: 'lofi' }, { searchAudio: search });
    expect(body.trending).toBe(false);
    expect(urls[0].searchParams.get('search_query')).toBe('lofi');
  });

  test('Instagram Login accounts get audio_unsupported, no Meta call', async () => {
    const { isError, body } = await call('search_instagram_audio', { accountId: 'ig-a' }, { searchAudio: search });
    expect(isError).toBe(true);
    expect(body.error).toBe('audio_unsupported');
    expect(urls).toHaveLength(0);
  });

  test('other owners\' accounts, non-Instagram accounts and reconnect-needed accounts are refused', async () => {
    addIntegration('igfb-bob', 'bob', 'instagram_fb');
    addIntegration('igfb-dead', 'alice', 'instagram_fb', { refreshNeeded: 1 });
    expect((await call('search_instagram_audio', { accountId: 'igfb-bob' }, { searchAudio: search })).body.error).toBe('account_not_found');
    expect((await call('search_instagram_audio', { accountId: 'tt-a' }, { searchAudio: search })).body.error).toBe('account_not_found');
    expect((await call('search_instagram_audio', { accountId: 'igfb-dead' }, { searchAudio: search })).body.error).toBe('reconnect_required');
    expect(urls).toHaveLength(0);
  });

  test('create_social_post skips an Instagram Login account that asks for music, keeps the Facebook Login one', async () => {
    const settings = { 'ig-a': { audio_configuration: { audio_id: '42' } }, 'igfb-a': { audio_configuration: { audio_id: '42', audio_volume: 20 } } };
    const { body } = await call('create_social_post', {
      integrationIds: ['ig-a', 'igfb-a'], content: 'c', media: [{ type: 'video', url: 'https://cdn.example.com/c.mp4' }], publishAt: FUTURE, settings,
    });
    expect(body.accounts).toBe(1);
    expect(body.skipped).toEqual([expect.objectContaining({ provider: 'instagram' })]);
    expect(JSON.stringify(body.skipped)).toMatch(/Facebook Login/);
  });
});
