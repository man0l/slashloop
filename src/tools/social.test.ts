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
  for (const f of ['0005_social_scheduler.sql', '0025_social_lanes.sql']) {
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
  test('all nine tools are listed', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    registerSocialTools(server, deps());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['list_social_accounts', 'upload_social_media', 'create_social_post', 'list_social_posts', 'reschedule_social_post', 'delete_social_post', 'tag_social_account', 'set_rotation', 'plan_rotation']) {
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
