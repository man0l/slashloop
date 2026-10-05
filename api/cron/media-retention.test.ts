// SLA-471: local SQLite EXPLAIN + equivalence fixtures for retention selection.
//
// The retention sweep's exact expiry predicate is per-workspace
// (`julianday(col) < julianday('now') - days`), which cannot serve as an index
// range bound on its own — the listing selection measured `SCAN v`. The fix
// ANDs a coarse global-MIN upper bound (same-statement scalar subquery, so it
// sees the same snapshot) while the exact predicate still governs membership.
//
// These tests pin, on an in-memory replica:
//  1. the coarse bound MUST use the global MINIMUM retention — global-MAX
//     wrongly drops expired rows from short-retention workspaces (this test
//     fails if the source ever switches back to MAX);
//  2. with the MIN bound, membership is IDENTICAL to the exact predicate on
//     expired / unexpired / boundary / null / mixed-retention fixtures;
//  3. the listing selection goes from SCAN to a bounded SEARCH once a
//     scrapedAt index exists (that index is a follow-up migration with
//     recorded cost — see the evidence comment on SLA-471);
//  4. thumb/media selections gain an upper range bound on their existing
//     composite indexes, with identical membership.
//
// Proxies here are SQLite EXPLAIN details and coarse-eligible row counts —
// NOT D1 metered rows. D1 speaks the same SQLite dialect, so the plan shapes
// transfer; the billed-row counts do not.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

const SOURCE = new URL('./media-retention.ts', import.meta.url);

function sourceText(): string {
  return readFileSync(SOURCE, 'utf8');
}

// --- Source-shape guards: the properties the behavioural tests rely on ------

test('SELECT/UPDATE/cascade share one listing WHERE builder', () => {
  const text = sourceText();
  expect(text).toContain('function listingCutoff()');
  // findExpiredListings() and the SQLite cascade selection both use it.
  expect(text.match(/\$\{listingCutoff\(\)\}/g)?.length).toBeGreaterThanOrEqual(2);
});

test('the coarse bound uses the global MINIMUM retention, never the maximum', () => {
  const text = sourceText();
  const helper = text.slice(text.indexOf('function coarseUpperBound'), text.indexOf('type ExpiredRow'));
  expect(helper).toContain('SELECT MIN(');
  expect(helper).not.toContain('SELECT MAX(');
});

test('the coarse bound serializes the cutoff in Prisma canonical ISO form', () => {
  const text = sourceText();
  // Prisma SQLite DateTime values are `YYYY-MM-DDTHH:MM:SS.sssZ`; only the
  // T-separator + millis + Z shape keeps raw string comparison time-ordered.
  expect(text).toContain(`strftime('%Y-%m-%dT%H:%M:%fZ'`);
});

// --- Behavioural fixtures (bun:sqlite replica of Video/Source/Workspace) ----

function fixtureDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE "Workspace"(id TEXT PRIMARY KEY, "thumbRetentionDays" INTEGER NOT NULL, "mediaRetentionDays" INTEGER NOT NULL)`);
  db.run(`CREATE TABLE "Source"(id TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL)`);
  db.run(`CREATE TABLE "Video"(id TEXT PRIMARY KEY, "sourceId" TEXT NOT NULL,
    "scrapedAt" TEXT NOT NULL, "thumbStatus" TEXT NOT NULL DEFAULT 'none',
    "thumbKey" TEXT, "thumbStoredAt" TEXT,
    "mediaStatus" TEXT NOT NULL DEFAULT 'none', "mediaKey" TEXT, "mediaStoredAt" TEXT)`);
  db.run(`CREATE INDEX idx_thumb ON "Video"("thumbStatus", "thumbStoredAt")`);
  db.run(`CREATE INDEX idx_media ON "Video"("mediaStatus", "mediaStoredAt")`);
  db.run(`INSERT INTO "Workspace" VALUES ('w1',7,30),('w2',3,5),('w3',90,90)`);
  db.run(`INSERT INTO "Source" VALUES ('s1','w1'),('s2','w2'),('s3','w3')`);
  const ts = (days: number): string =>
    (db.query(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days') AS t`).get() as { t: string }).t;
  // Near-boundary ages with a ±60s margin: strftime has millisecond precision,
  // so exactly-at-retention would be a same-millisecond timing flake against
  // the `<` (not `<=`) predicate. Modifiers apply in order, so '-N days'
  // followed by '-60 seconds' is 60s OLDER than the edge (deterministically
  // expired yet far younger than the global MAX of 90d), while '+60 seconds'
  // is 60s younger (deterministically unexpired, pins the strict `<`).
  const tsNear = (days: number, extraSeconds: number): string =>
    (db.query(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days','${extraSeconds} seconds') AS t`).get() as { t: string }).t;
  const insert = db.prepare(`INSERT INTO "Video"(id,"sourceId","scrapedAt","thumbStatus","thumbKey","thumbStoredAt","mediaStatus","mediaKey","mediaStoredAt")
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // Mostly-unexpired bulk: ~90% younger than even the shortest retention.
  for (let i = 0; i < 1500; i++) {
    const src = ['s1', 's2', 's3'][i % 3];
    const age = i % 10 === 0 ? 100 : 1 + (i % 2);
    const t = ts(age);
    insert.run(`v${String(i).padStart(5, '0')}`, src, t, 'stored', `tk${i}`, t, 'stored', `mk${i}`, t);
  }
  // Near-boundary rows: just past a workspace retention edge (<, not <=, keeps
  // them expired) yet far younger than the global MAX — the shape the MAX
  // bound gets wrong. v_nb_w2m is just inside the media edge: unexpired.
  // scrapedAt uses each workspace's wider window (w2: 5d, w1: 30d).
  insert.run('v_b_w2t', 's2', tsNear(5, -60), 'stored', 'tk-b1', tsNear(3, -60), 'stored', 'mk-b1', tsNear(5, -60));
  insert.run('v_b_w1t', 's1', tsNear(30, -60), 'stored', 'tk-b2', tsNear(7, -60), 'stored', 'mk-b2', tsNear(30, -60));
  insert.run('v_nb_w2m', 's2', ts(1), 'stored', 'tk-nb', ts(1), 'stored', 'mk-nb', tsNear(5, 60));
  // Null / unstored rows must never match.
  insert.run('v_null', 's1', ts(100), 'stored', null, null, 'none', null, null);
  insert.run('v_nostat', 's1', ts(200), 'none', null, null, 'none', null, null);
  return db;
}

// Exact currently-shipped predicates (baseline) and the MIN-coarse candidates,
// with the same shapes as expiredColumns()/listingCutoff() in the source.
const THUMB_EXACT = `julianday(v."thumbStoredAt") < julianday('now') - w."thumbRetentionDays"`;
const MEDIA_EXACT = `julianday(v."mediaStoredAt") < julianday('now') - w."mediaRetentionDays"`;
const LIST_EXACT = `julianday(v."scrapedAt") < julianday('now') - MAX(w."thumbRetentionDays", w."mediaRetentionDays")`;
const THUMB_COARSE = `AND v."thumbStoredAt" < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (SELECT MIN(w2."thumbRetentionDays") FROM "Workspace" w2) || ' days')`;
const MEDIA_COARSE = `AND v."mediaStoredAt" < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (SELECT MIN(w2."mediaRetentionDays") FROM "Workspace" w2) || ' days')`;
const LIST_COARSE = `AND v."scrapedAt" < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (SELECT MIN(MAX(w2."thumbRetentionDays", w2."mediaRetentionDays")) FROM "Workspace" w2) || ' days')`;
// The rejected alternative from the issue hypothesis: global-MAX bound.
const THUMB_MAX_COARSE = `AND v."thumbStoredAt" < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (SELECT MAX(w2."thumbRetentionDays") FROM "Workspace" w2) || ' days')`;

function thumbQuery(extra: string): string {
  return `SELECT v."id" AS id, v."thumbKey" AS key FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId" JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE v."thumbStatus" = 'stored' AND v."thumbKey" IS NOT NULL AND v."thumbStoredAt" IS NOT NULL
    AND ${THUMB_EXACT} ${extra} ORDER BY v."thumbStoredAt" ASC LIMIT 1000`;
}
function mediaQuery(extra: string): string {
  return `SELECT v."id" AS id, v."mediaKey" AS key FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId" JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE v."mediaStatus" = 'stored' AND v."mediaKey" IS NOT NULL AND v."mediaStoredAt" IS NOT NULL
    AND ${MEDIA_EXACT} ${extra} ORDER BY v."mediaStoredAt" ASC LIMIT 1000`;
}
function listQuery(extra: string): string {
  return `SELECT v."id" AS id FROM "Video" v
    JOIN "Source" s ON s."id" = v."sourceId" JOIN "Workspace" w ON w."id" = s."workspaceId"
    WHERE ${LIST_EXACT} ${extra} ORDER BY v."scrapedAt" ASC LIMIT 1000`;
}

function ids(db: Database, sql: string): string[] {
  return (db.query(sql).all() as { id: string }[]).map((r) => r.id).sort();
}
function plan(db: Database, sql: string): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((r) => r.detail).join(' | ');
}

test('global-MAX coarse bound DROPS expired rows — the rejected hypothesis', () => {
  const db = fixtureDb();
  const base = ids(db, thumbQuery(''));
  const maxed = ids(db, thumbQuery(THUMB_MAX_COARSE));
  // Boundary rows from short-retention workspaces are exact-expired but
  // younger than the global max: the MAX bound silently misses them.
  expect(base).toContain('v_b_w1t');
  expect(base).toContain('v_b_w2t');
  expect(maxed).not.toContain('v_b_w1t');
  expect(maxed).not.toContain('v_b_w2t');
  expect(maxed.length).toBeLessThan(base.length);
});

test('MIN-coarse thumb/media membership is identical to exact on all fixtures', () => {
  const db = fixtureDb();
  expect(ids(db, thumbQuery(THUMB_COARSE))).toEqual(ids(db, thumbQuery('')));
  expect(ids(db, mediaQuery(MEDIA_COARSE))).toEqual(ids(db, mediaQuery('')));
  // Boundary rows (<, not <=) and null rows behave the same either way.
  const base = ids(db, thumbQuery(''));
  expect(base).toContain('v_b_w1t');
  expect(base).toContain('v_b_w2t');
  expect(base).not.toContain('v_null');
  expect(base).not.toContain('v_nostat');
  // Just-inside-the-edge media row is unexpired under exact and MIN alike.
  expect(ids(db, mediaQuery(''))).not.toContain('v_nb_w2m');
  expect(ids(db, mediaQuery(MEDIA_COARSE))).not.toContain('v_nb_w2m');
});

test('MIN-coarse listing membership is identical to exact', () => {
  const db = fixtureDb();
  expect(ids(db, listQuery(LIST_COARSE))).toEqual(ids(db, listQuery('')));
  // Near-boundary listing rows (past the wider window) are expired either way.
  expect(ids(db, listQuery(''))).toContain('v_b_w1t');
  expect(ids(db, listQuery(''))).toContain('v_b_w2t');
});

test('MIN-coarse narrows the index range on the existing thumb/media indexes', () => {
  const db = fixtureDb();
  const before = plan(db, thumbQuery(''));
  expect(before).toContain('SEARCH');
  expect(before).toContain('idx_thumb');
  const after = plan(db, thumbQuery(THUMB_COARSE));
  // Upper bound added alongside the existing lower bound: both sides ranged.
  expect(after).toContain('idx_thumb');
  expect(after).toMatch(/thumbStoredAt>\?.*thumbStoredAt<\?|thumbStoredAt<\?.*thumbStoredAt>\?/);
  // Proxy (NOT D1 metered rows): coarse-eligible entries vs all stored rows.
  const eligible = (db.query(
    `SELECT COUNT(*) AS n FROM "Video" WHERE "thumbStatus"='stored' ${THUMB_COARSE.replace('v.', '"Video".').replace('AND ', 'AND ')}`)
    .get() as { n: number }).n;
  const stored = (db.query(`SELECT COUNT(*) AS n FROM "Video" WHERE "thumbStatus"='stored'`).get() as { n: number }).n;
  expect(eligible).toBeLessThan(stored);
});

test('MIN-coarse turns the listing SCAN into a SEARCH once a scrapedAt index exists', () => {
  const db = fixtureDb();
  expect(plan(db, listQuery(''))).toContain('SCAN');
  db.run(`CREATE INDEX idx_scraped ON "Video"("scrapedAt")`);
  expect(plan(db, listQuery(''))).toContain('SCAN');
  const after = plan(db, listQuery(LIST_COARSE));
  expect(after).toContain('SEARCH');
  expect(after).toContain('scrapedAt<?');
});
