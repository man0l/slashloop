// One-shot Supabase → Cloudflare D1 data migration.
//
//   bun src/scripts/migrate-supabase-to-d1.ts --plan     # per-table counts, both sides
//   bun src/scripts/migrate-supabase-to-d1.ts --copy     # copy (run under a traffic freeze)
//   bun src/scripts/migrate-supabase-to-d1.ts --verify   # counts + date-format checks
//
// Reads Supabase through the Postgres Prisma client (DATABASE_URL) and writes
// D1 over the REST API (D1_ACCOUNT_ID / D1_DATABASE_ID / D1_API_TOKEN) with
// INSERT OR IGNORE batches — idempotent, so an interrupted run is re-run safe.
//
// Trim policy (as approved):
//   • FULL:   User (derived from auth.users), Workspace, Source, Board,
//             SwipeEntry, Idea, HookTest, HookVersion, CreditLedger,
//             SuggestionDismissal, Baseline, ScrapeAlertState
//   • VIDEOS: Video rows with scrapedAt ≥ cutoff OR referenced by a kept
//             SwipeEntry/Idea/HookTest; Analyses reachable from those videos
//             (or from kept Idea/Brief/Script rows) pull their videos back in
//             (3 fixpoint passes). Score/Analysis/Hook follow the kept set.
//   • TRIM:   UsageLog/RefreshRun/AutoAnalyzeRun ≤ cutoff; finished MediaJob
//             and StripeEvent ≤ cutoff; queued/running MediaJobs always move.
//   • SKIP:   CanonicalScrapeLock (ephemeral TTL locks).
//
// FK order is encoded in COPY_ORDER (parents first). Column lists come from
// the D1 schema itself (PRAGMA table_info) — the copy never guesses them.

const args = new Set(process.argv.slice(2));
const PLAN = args.has('--plan');
const COPY = args.has('--copy');
const VERIFY = args.has('--verify');
if (!PLAN && !COPY && !VERIFY) {
  console.error('pass --plan, --copy or --verify (see header)');
  process.exit(1);
}

const CUTOFF_DAYS = Number(process.env.MIGRATION_CUTOFF_DAYS ?? 90);
const CUTOFF = new Date(Date.now() - CUTOFF_DAYS * 86_400_000);
const pgId = (s: string) => `"${s}"`;

// --- Supabase side -----------------------------------------------------------

const { initStorePostgres, effectiveDatabaseUrl } = await import('../store.js');
if (!effectiveDatabaseUrl()) {
  console.error('DATABASE_URL is not set — cannot read Supabase');
  process.exit(1);
}
const pg = await initStorePostgres();
const pgAny = pg as unknown as Record<string, {
  findMany: (args?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  count: (args?: Record<string, unknown>) => Promise<number>;
}>;

async function pgColumnValues(table: string, column: string, distinct = true): Promise<string[]> {
  const rows = await pg.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${distinct ? 'DISTINCT' : ''} ${pgId(column)} AS v FROM ${pgId(table)} WHERE ${pgId(column)} IS NOT NULL`,
  );
  return rows.map((r) => String(r.v));
}

// --- D1 side (REST) ----------------------------------------------------------

const D1_ACCOUNT_ID = process.env.D1_ACCOUNT_ID ?? '';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID ?? '';
const D1_API_TOKEN = process.env.D1_API_TOKEN ?? '';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}`;

/**
 * /raw returns each statement result as {columns, rows[[]]} (positional), so
 * zip them back into objects. Defensively tolerates object-row arrays.
 */
function toObjects(r: { columns?: string[]; rows?: unknown[] } | Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  const cols = r.columns ?? [];
  return ((r.rows ?? []) as unknown[][]).map((vals) => Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
}

/**
 * The REST /raw endpoint accepts exactly ONE statement object — array bodies
 * are rejected with HTTP 400, and a multi-statement SQL string silently
 * executes only its first statement. So: one HTTP call per statement.
 */
async function d1Statement(sql: string, params: unknown[] = []): Promise<{ columns?: string[]; rows?: unknown[]; changes?: number }> {
  const res = await fetch(`${D1_URL}/raw`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${D1_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json = res.ok
    ? (await res.json()) as {
        success?: boolean;
        errors?: Array<{ message?: string }>;
        result?: Array<{ results?: { columns?: string[]; rows?: unknown[] }; meta?: { changes?: number } }>;
      }
    : { success: false, errors: [{ message: `HTTP ${res.status}: ${await res.text().catch(() => '').slice(0, 200)}` }] };
  if (json.success === false) {
    throw new Error(`D1 error (${sql.slice(0, 80)}…): ${json.errors?.map((e) => e.message ?? String(e)).join('; ')}`);
  }
  const [r] = json.result ?? [];
  return { ...(r?.results ?? {}), changes: r?.meta?.changes };
}

async function d1Query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await d1Statement(sql, params);
  return toObjects(r) as T[];
}

/** PRAGMA is rejected over the REST API — read the column names from an empty SELECT. */
async function d1Columns(table: string): Promise<string[]> {
  const r = await d1Statement(`SELECT * FROM ${pgId(table)} LIMIT 0`);
  const cols = r.columns;
  if (!cols || cols.length === 0) throw new Error(`D1 table "${table}" has no columns — run wrangler d1 migrations first`);
  return cols;
}

// --- writing ------------------------------------------------------------------

/** D1 hard-caps 98 bound params per statement; stay under with headroom. */
const MAX_PARAMS = 90;
/** Concurrent single-statement writes in flight (REST has no batch). */
const WRITE_CONCURRENCY = 4;

function serialize(row: Record<string, unknown>): unknown[] {
  return Object.values(row).map((v) => {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString().replace('Z', '+00:00');
    return v;
  });
}

async function writeRows(table: string, columns: string[], rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const colsSql = columns.map(pgId).join(', ');
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const chunk = rows.slice(i, i + rowsPerStmt);
    statements.push({
      sql: `INSERT OR IGNORE INTO ${pgId(table)} (${colsSql}) VALUES ${chunk.map(() => placeholders).join(', ')}`,
      params: chunk.flatMap(serialize),
    });
  }

  // Small fixed pool — one statement per call, a few in flight.
  let written = 0;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= statements.length) return;
      const r = await d1Statement(statements[i]!.sql, statements[i]!.params);
      written += r.changes ?? 0;
    }
  }
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, statements.length) }, worker));
  return written;
}

/** Stream a selection from Postgres by PK cursor, writing as we go. */
async function copySelection(
  table: string,
  columns: string[],
  where: Record<string, unknown> | undefined,
  pk: string = 'id',
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await pgAny[table].findMany({
      ...(where ? { where } : {}),
      select: Object.fromEntries(columns.map((c) => [c, true])),
      orderBy: { [pk]: 'asc' },
      ...(cursor ? { cursor: { [pk]: cursor }, skip: 1 } : {}),
      take: 500,
    }) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    cursor = page[page.length - 1]![pk] as string;
    await writeRows(table, columns, page);
    total += page.length;
    process.stdout.write(`  ${table}: ${total}\r`);
  }
  process.stdout.write(`  ${table}: ${total}${total > 0 ? '   ' : ''}\n`);
  return total;
}

// --- kept-set computation ------------------------------------------------------

async function idChunks(values: string[], size = 5000): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function computeKeptSets(): Promise<{ videoIds: Set<string>; analysisIds: Set<string> }> {
  console.log('computing kept video/analysis sets …');
  // Videos fresh enough, or anchored by a kept SwipeEntry/Idea/HookTest.
  const fresh = (await pgAny.video.findMany({ where: { scrapedAt: { gte: CUTOFF } }, select: { id: true } })).map((r) => r.id as string);
  const anchored = [
    ...(await pgAny.swipeEntry.findMany({ select: { videoId: true } })).map((r) => r.videoId as string),
    ...(await pgAny.idea.findMany({ select: { videoId: true } })).map((r) => r.videoId as string),
    ...(await pgAny.hookTest.findMany({ select: { videoId: true } })).map((r) => r.videoId as string),
  ].filter((v): v is string => Boolean(v));

  // Analyses reachable from kept ideas/briefs/scripts (their ids must survive).
  const reachableAnalysisIds = [
    // (null checks in JS — Prisma 6 rejects null comparisons in filters)
    ...(await pgAny.idea.findMany({ select: { analysisId: true } })).map((r) => r.analysisId as string | null),
    ...(await pgAny.brief.findMany({ select: { analysisId: true } })).map((r) => r.analysisId as string | null),
    ...(await pgAny.script.findMany({ select: { analysisId: true } })).map((r) => r.analysisId as string | null),
  ].filter((v): v is string => Boolean(v));

  const videoIds = new Set<string>([...fresh, ...anchored]);
  const analysisIds = new Set<string>(reachableAnalysisIds);

  // Fixpoint: analyses of kept videos are kept; those analyses' videos are kept.
  for (let pass = 0; pass < 3; pass++) {
    let grew = false;
    for (const chunk of await idChunks([...videoIds])) {
      const rows = await pgAny.analysis.findMany({ where: { videoId: { in: chunk } }, select: { id: true, videoId: true } });
      for (const r of rows) {
        if (!analysisIds.has(r.id as string)) { analysisIds.add(r.id as string); grew = true; }
      }
    }
    for (const chunk of await idChunks([...analysisIds])) {
      const rows = await pgAny.analysis.findMany({ where: { id: { in: chunk } }, select: { videoId: true } });
      for (const r of rows) {
        const v = r.videoId as string | null;
        if (v && !videoIds.has(v)) { videoIds.add(v); grew = true; }
      }
    }
    if (!grew) break;
    console.log(`  fixpoint pass ${pass + 1}: videos=${videoIds.size} analyses=${analysisIds.size}`);
  }
  console.log(`kept sets: videos=${videoIds.size}, analyses=${analysisIds.size} (cutoff ${CUTOFF.toISOString().slice(0, 10)})`);
  return { videoIds, analysisIds };
}

// --- plan / copy / verify -------------------------------------------------------

const COPY_ORDER = [
  'User', 'Workspace', 'Source', 'Video', 'Score', 'Analysis', 'Hook', 'Board',
  'SwipeEntry', 'Idea', 'HookTest', 'HookVersion', 'Brief', 'Script',
  'CreditLedger', 'SuggestionDismissal', 'StripeEvent', 'Baseline',
  'UsageLog', 'RefreshRun', 'AutoAnalyzeRun', 'MediaJob', 'ScrapeAlertState',
] as const;

const d1Schema = new Map<string, string[]>();
for (const t of COPY_ORDER) d1Schema.set(t, await d1Columns(t));

function whereFor(table: string, kept: { videoIds: Set<string>; analysisIds: Set<string> }): Record<string, unknown> | undefined {
  switch (table) {
    case 'Video':
      return { OR: [{ scrapedAt: { gte: CUTOFF } }, { id: { in: [...kept.videoIds] } }] };
    case 'Score':
    case 'Hook':
      return { videoId: { in: [...kept.videoIds] } };
    case 'Analysis':
      return { OR: [{ videoId: { in: [...kept.videoIds] } }, { id: { in: [...kept.analysisIds] } }] };
    case 'UsageLog':
      return { createdAt: { gte: CUTOFF } };
    case 'RefreshRun':
    case 'AutoAnalyzeRun':
      return { ranAt: { gte: CUTOFF } };
    case 'MediaJob':
      return { OR: [{ status: { in: ['queued', 'running'] } }, { AND: [{ status: { in: ['done', 'failed'] } }, { createdAt: { gte: CUTOFF } }] }] };
    case 'StripeEvent':
      return { processedAt: { gte: CUTOFF } };
    default:
      return undefined; // full copy
  }
}

/** Tables whose PK is not `id` (Score is keyed by videoId). */
const PRIMARY_KEYS: Partial<Record<string, string>> = { Score: 'videoId' };

if (PLAN || COPY) {
  console.log(`cutoff: ${CUTOFF.toISOString()} (${CUTOFF_DAYS}d)`);
  const kept = await computeKeptSets();
  for (const table of COPY_ORDER) {
    const where = whereFor(table, kept);
    // User has no Postgres table — it is derived from auth.users at copy time.
    const pgCount = table === 'User' ? 0 : await pgAny[table].count(where ? { where } : undefined);
    const d1Count = await d1Query(`SELECT COUNT(*) AS n FROM ${pgId(table)}`);
    const existing = Number((d1Count[0] ?? {}).n ?? 0);
    console.log(`${table.padEnd(20)} pg=${String(pgCount).padStart(7)}  d1(existing)=${String(existing).padStart(7)}`);
    if (COPY) {
      // User rows are derived from auth.users AFTER the loop (no pg table).
      if (table !== 'User') await copySelection(table, d1Schema.get(table)!, where, PRIMARY_KEYS[table]);
    }
  }
}

if (COPY) {
  // User rows: derived from auth.users over the direct connection — same
  // access pattern as src/lib/digest.ts ownerEmail().
  const owners = await pgColumnValues('Workspace', 'ownerId');
  const users: Array<Record<string, unknown>> = [];
  for (const ownerId of owners) {
    const rows = await pg.$queryRawUnsafe<Array<{ email: string | null }>>(
      `SELECT email FROM auth.users WHERE id = $1::uuid LIMIT 1`, ownerId,
    ).catch(() => [] as Array<{ email: string | null }>);
    users.push({
      id: ownerId,
      email: rows[0]?.email ?? 'unknown@migration.local',
      createdAt: new Date(0),
      updatedAt: new Date(),
    });
  }
  const n = await writeRows('User', d1Schema.get('User')!, users);
  console.log(`User rows written: ${n} (owners: ${owners.length})`);
}

if (VERIFY) {
  console.log('verifying …');
  const kept = await computeKeptSets();
  let failures = 0;
  for (const table of COPY_ORDER) {
    // User is derived (auth.users), not copied — skip source comparison.
    const pgCount = table === 'User' ? -1 : await pgAny[table].count(whereFor(table, kept) ? { where: whereFor(table, kept) } : undefined);
    const d1Count = Number((await d1Query(`SELECT COUNT(*) AS n FROM ${pgId(table)}`))[0]?.n ?? 0);
    const ok = pgCount === -1 ? true : pgCount === d1Count;
    console.log(`${table.padEnd(20)} pg=${String(pgCount).padStart(7)}  d1=${String(d1Count).padStart(7)}  ${ok ? 'ok' : 'MISMATCH'}`);
    if (!ok) failures++;
  }
  // Date storage format check — media-retention's julianday() cutoffs depend
  // on dates being ISO text (SQLite-parsable), not epoch integers.
  const sample = await d1Query<{ scrapedAt: unknown; t: string }>(
    `SELECT "scrapedAt" AS "scrapedAt", typeof("scrapedAt") AS t FROM "Video" WHERE "scrapedAt" IS NOT NULL LIMIT 1`,
  );
  console.log(`date format sample:`, sample[0] ?? '(no Video rows)');
  if (sample[0] && sample[0].t !== 'text') {
    console.error('FAIL: Video.scrapedAt is not TEXT — julianday() retention cutoffs would misbehave');
    failures++;
  }
  const workspace = await d1Query(`SELECT id, name, "planCredits", "packCredits" FROM "Workspace" LIMIT 3`);
  console.log('workspace sample:', workspace);
  console.log(failures === 0 ? '\nVERIFY: ok' : `\nVERIFY: ${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
console.log('done.');
