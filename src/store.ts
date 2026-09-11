// Shard-aware data-layer facade — the one seam between the app and its database.
//
// Two runtimes talk to two engines:
//   • Worker (Cloudflare)  → PrismaClient({ adapter: new PrismaD1(env.DB_SHARD0) })
//                            generated from prisma/schema.sqlite.prisma, registered
//                            by src/cf/worker.ts on first request/scheduled tick.
//   • Node/Bun (VPS worker, scripts, copy tool) → the classic Postgres client,
//                            registered lazily by initStorePostgres().
//
// `db` stays the single import every module already uses (src/db.ts re-exports
// it). It is a Proxy so no module-level construction happens before the
// runtime has had a chance to register the right client — on Workers there is
// no constructor-time env to read.
//
// Why not plain `@prisma/client` everywhere: Prisma bakes the provider into
// the generated client, so the Postgres and SQLite clients are two separate
// generated packages with two separate error-class identities and different
// raw-result shapes. This module is where those differences are absorbed
// (see isUniqueViolation, rawBatch, coerceRowDates).
//
// Sharding: D1 caps a database at 10GB (hard). The router below runs one
// shard today; the shard directory (KV, binding SHARD_DIRECTORY) is the seam
// for adding more — an ops task (create DB, copy rows by ownerId, update the
// directory), not a code rewrite.

import { keepAlive } from './cf/wait-until.js';

/** Which SQL dialect the raw queries must speak. Set DB_DIALECT=sqlite on Workers. */
export type Dialect = 'postgres' | 'sqlite';

export function dbDialect(): Dialect {
  return (process.env.DB_DIALECT ?? 'postgres') === 'sqlite' ? 'sqlite' : 'postgres';
}

/**
 * The Postgres DATABASE_URL with an optional connection_limit override.
 * (Moved from src/db.ts, which re-exports it — the VPS worker multitasks on
 * the shared pgbouncer pool and needs >1 connection; see the comment there.)
 */
export function effectiveDatabaseUrl(): string {
  const limit = process.env.DB_CONNECTION_LIMIT;
  const url = process.env.DATABASE_URL;
  if (!url || !limit) return url ?? '';
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return url;
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('connection_limit', String(n));
  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

// Typed as the Postgres client for the whole app's benefit; the SQLite client
// (src/generated/sqlite) is structurally identical at the model-delegate level.
// The two generated packages' $extends types are NOT mutually assignable, so
// registration casts through unknown — the one place where that lie lives.
export type AppPrismaClient = import('@prisma/client').PrismaClient;

export type RawStatement = { sql: string; params?: unknown[] };
/** Execute statements ATOMICALLY (one transaction); returns each statement's rows. */
export type RawExecutor = (statements: RawStatement[]) => Promise<unknown[][]>;

const globalForStore = globalThis as unknown as {
  __slashloopStore?: { client: AppPrismaClient; raw?: RawExecutor };
};

export function setActiveClient(client: AppPrismaClient, raw?: RawExecutor): void {
  globalForStore.__slashloopStore = { client, raw };
}

// ---------------------------------------------------------------------------
// Process-wide DB turn — NOT wired into `db`.
//
// Isolating every db.* call behind one isolate-wide mutex made a single
// user's tab (workspaces + sources + gallery + N video details + hovers)
// queue and 503 at 25s. D1 handles concurrent reads; Prisma's actual
// constraint is intra-query adapter fan-out (`_count` includes, Promise.all
// of db.* in one handler). Callers stay sequential inside a request.
// timedD1() still times out a stuck binding call. withDbTurn remains for
// tests; do not put it back on the `db` proxy.
// ---------------------------------------------------------------------------

/**
 * Worker HTTP (D1 binding, no D1_API_TOKEN): fail waiters in 3s so a hung
 * holder cannot freeze the tab for 25s (DevTools: 503s at 25.01s).
 * Contabo/Node talks D1 over HTTP and keeps the 25s window so a slow claim
 * is not a false busy.
 */
function defaultTurnTimeoutMs(): number {
  const override = Number(process.env.DB_TURN_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  const workerBinding = (process.env.DB_DIALECT ?? '') === 'sqlite' && !process.env.D1_API_TOKEN;
  return workerBinding ? 3_000 : 25_000;
}

/** Max wait for the process-wide DB turn before failing fast. */
export const DB_TURN_TIMEOUT_MS = defaultTurnTimeoutMs();

/** Hold durations at/above this are logged with the acquisition stack. */
export const SLOW_DB_TURN_MS = 10_000;

export class DbBusyError extends Error {
  constructor(waitedMs: number = DB_TURN_TIMEOUT_MS) {
    super(`Database is busy serving another request (no turn in ${waitedMs}ms)`);
    this.name = 'DbBusyError';
  }
}

interface TurnTicket {
  /** False once timed out (deserted) — pumpTurn skips these. */
  live: boolean;
  /** Resolve the waiter when the turn is granted. Cleared on grant/timeout. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set by withDbTurn before the ticket can be granted. */
  grant: (() => void) | undefined;
}

let turnQueue: TurnTicket[] = [];
let turnHeld = false;
/** When the current holder was granted. 0 if the turn is free. */
let holderGrantedAt = 0;
/** True when the current holder's work was pinned with ctx.waitUntil. */
let holderPinned = false;

/**
 * Unpinned holder (client abort cancelled its IoContext) is force-released
 * once a waiter has seen it held this long. On the Worker this matches the
 * 3s waiter timeout so the first 503 also unsticks the isolate. Contabo
 * stays at 20s so a slow D1 HTTP claim is not overlapped.
 */
export const DB_TURN_ABANDON_MS = (() => {
  const override = Number(process.env.DB_TURN_ABANDON_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return DB_TURN_TIMEOUT_MS <= 3_000 ? DB_TURN_TIMEOUT_MS : 20_000;
})();

/** @internal — test seam. */
export function resetDbTurnForTests(): void {
  turnQueue = [];
  turnHeld = false;
  holderGrantedAt = 0;
  holderPinned = false;
}

/** Grant the turn to the first live waiter, if the turn is free. */
function pumpTurn(): void {
  if (turnHeld) return;
  while (turnQueue.length > 0 && !turnQueue[0]!.live) turnQueue.shift();
  const next = turnQueue.shift();
  if (!next) return;
  turnHeld = true;
  next.grant?.();
}

export interface DbTurnOptions {
  /** Override for tests (default DB_TURN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Override for tests (default SLOW_DB_TURN_MS). */
  slowMs?: number;
  /** Override for tests (default DB_TURN_ABANDON_MS). */
  abandonMs?: number;
  /** Slow-holder sink (default console.error). */
  onSlow?: (message: string) => void;
}

/** @internal — exported for unit tests; all app code goes through the `db` proxy. */
export function withDbTurn<T>(fn: () => Promise<T>, opts: DbTurnOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DB_TURN_TIMEOUT_MS;
  const slowMs = opts.slowMs ?? SLOW_DB_TURN_MS;
  const abandonMs = opts.abandonMs ?? DB_TURN_ABANDON_MS;
  const onSlow = opts.onSlow ?? ((msg: string) => console.error(msg));
  // Captured eagerly so a slow holder logs WHERE it was acquired, not just
  // how long it ran. ~microseconds per call — negligible next to a D1
  // round trip, and only formatted into output on the slow path.
  const acquiredStack = new Error('db-turn acquisition').stack ?? '';
  const requestedAt = Date.now();

  return new Promise<T>((resolve, reject) => {
    let granted = false;
    let slowLogged = false;

    // Finish one turn: log slow holders, free the turn, and pump the queue.
    const finish = (failed: boolean, value: T): void => {
      if (!granted) return;
      granted = false;
      if (ticket.timer !== undefined) {
        clearTimeout(ticket.timer);
        ticket.timer = undefined;
      }
      const heldMs = Date.now() - grantedAt;
      if (heldMs >= slowMs && !slowLogged) {
        slowLogged = true;
        const frames = acquiredStack
          .split('\n')
          .slice(2, 5)
          .map((l) => l.trim())
          .join(' <- ');
        onSlow(
          `[db-turn-slow] holder ran ${heldMs}ms (waited ${grantedAt - requestedAt}ms): ${frames}`,
        );
      }
      turnHeld = false;
      holderGrantedAt = 0;
      holderPinned = false;
      pumpTurn();
      if (failed) reject(value);
      else resolve(value);
    };

    const grantedAt = Date.now();

    const ticket: TurnTicket = {
      live: true,
      timer: undefined,
      grant: undefined,
    };

    const timer = setTimeout(() => {
      if (!ticket.live) return;
      // Desert: leave the chain intact for everyone else. Do NOT grant —
      // granting here would overlap the still-running holder (the old
      // release-on-timeout bug that wedged isolates under slow D1).
      ticket.live = false;
      const idx = turnQueue.indexOf(ticket);
      if (idx >= 0) turnQueue.splice(idx, 1);
      // Unpinned holder whose IoContext was aborted never calls finish().
      // Force-release so this isolate is not wedged until eviction. Pinned
      // holders (waitUntil) are left alone — they will finish.
      if (
        turnHeld
        && !holderPinned
        && holderGrantedAt > 0
        && Date.now() - holderGrantedAt >= abandonMs
      ) {
        turnHeld = false;
        holderGrantedAt = 0;
        pumpTurn();
      }
      reject(new DbBusyError(timeoutMs));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    ticket.timer = timer;

    // The turn is granted when this waiter reaches the front of the queue
    // while the turn is free. grant() runs fn and finishes the turn when fn
    // settles — never overlapping another fn (serialization is the whole
    // point of the turn; a timed-out waiter may NOT barge in front of a
    // still-running holder).
    ticket.grant = () => {
      if (granted) return;
      granted = true;
      if (ticket.timer !== undefined) {
        clearTimeout(ticket.timer);
        ticket.timer = undefined;
      }
      holderGrantedAt = Date.now();
      const work = Promise.resolve()
        .then(fn)
        .then(
          (value) => finish(false, value),
          (err: unknown) => finish(true, err as unknown as T),
        );
      // Client abort of the holder must not cancel fn — otherwise turnHeld
      // stays true forever and every later request 503s. No-op on Node.
      holderPinned = keepAlive(work);
    };

    turnQueue.push(ticket);
    pumpTurn();
  });
}


function activeStore(): { client: AppPrismaClient; raw?: RawExecutor } {
  const store = globalForStore.__slashloopStore;
  if (!store) {
    throw new Error(
      'Database client not initialized — on Node/Bun call initStorePostgres() first; '
      + 'on Workers the runtime registers it before the first request.',
    );
  }
  return store;
}

/**
 * The shared Prisma entry point. Proxy → the active client, bound. Tagged
 * templates (`db.$queryRaw\`...\``) work because the tagged callee is just a
 * function; `this` must be the client, hence the bind.
 *
 * Concurrent requests share this client on purpose: a page load is many
 * fetches (workspaces, sources, gallery, video cards). Serializing them
 * behind one isolate mutex was the 25s 503 storm.
 */
export const db = new Proxy({} as AppPrismaClient, {
  get(_target, prop) {
    const { client } = activeStore();
    const value = Reflect.get(client as object, prop, client);
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(client);
    }
    return value;
  },
});

import { createRequire } from 'node:module';

/**
 * Node/Bun bootstrap — constructs the Postgres client exactly as src/db.ts
 * always did. Synchronous (createRequire, not import()) because scripts and
 * the VPS worker query `db` immediately after importing src/db.ts; a dynamic
 * import would race the first query. `@prisma/client` stays out of the
 * Workers bundle: it is marked external in wrangler.jsonc and this function
 * is never called there (DB_DIALECT=sqlite, no DATABASE_URL).
 */
export function initStorePostgres(): AppPrismaClient {
  if (globalForStore.__slashloopStore) return globalForStore.__slashloopStore.client;
  const nodeRequire = createRequire(import.meta.url);
  const { PrismaClient } = nodeRequire('@prisma/client') as typeof import('@prisma/client');
  const client = new PrismaClient({
    datasources: { db: { url: effectiveDatabaseUrl() } },
    log: process.env.PRISMA_LOG === '1' ? ['error', 'warn'] : ['error'],
  });
  setActiveClient(client);
  return client;
}

// ---------------------------------------------------------------------------
// Atomic multi-statement execution (the D1 transaction substitute)
// ---------------------------------------------------------------------------

/**
 * Run statements in ONE atomic batch and return each statement's result rows.
 *
 * D1 has no interactive transactions (`db.$transaction(async …)` is
 * unsupported by the adapter), but `D1Database.batch()` is atomic. On the
 * Postgres side there is no batch — callers keep their interactive
 * `$transaction` there (every rawBatch call site is dialect-branched).
 */
export async function rawBatch(statements: RawStatement[]): Promise<unknown[][]> {
  const { raw } = activeStore();
  if (!raw) throw new Error('rawBatch: no raw executor registered (Postgres runtimes use $transaction instead)');
  return raw(statements);
}

// ---------------------------------------------------------------------------
// Node/Bun over the D1 HTTP API (VPS worker after cutover)
// ---------------------------------------------------------------------------

export interface D1HttpParams {
  accountId: string;
  databaseId: string;
  /** API token with D1 write permission (account-scoped). */
  token: string;
}

/**
 * Bind JS values the way the official adapter does before sending them over
 * the REST API (mirrors @prisma/adapter-d1 mapArg for the scalar types
 * rawBatch call sites use).
 */
/** D1 bind / REST params: Dates and booleans are not legal bind types. */
export function d1BindParam(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().replace('Z', '+00:00');
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

function d1HttpParam(value: unknown): unknown {
  return d1BindParam(value);
}

/**
 * rawBatch executor over the D1 REST API.
 *
 * The REST /raw endpoint accepts exactly ONE statement per call — there is no
 * HTTP batch, so atomicity cannot live on this side. Two modes:
 *   • WORKER_URL + CRON_SECRET set (production VPS): the batch is POSTed to
 *     the Worker's /internal/raw-batch endpoint, which executes it through the
 *     D1 binding's atomic `batch()`. Money paths stay transactional.
 *   • No WORKER_URL (local dev): statements run sequentially WITHOUT atomicity,
 *     with a loud warning — never acceptable for production traffic.
 *
 * NOTE: /raw returns rows POSITIONALLY ({columns, rows}), unlike the binding's
 * object rows — zip them back.
 */
function d1HttpRawExecutor(params: D1HttpParams): RawExecutor {
  const d1Url = `https://api.cloudflare.com/client/v4/accounts/${params.accountId}/d1/database/${params.databaseId}/raw`;

  async function single(sql: string, sqlParams: unknown[]): Promise<Array<Record<string, unknown>>> {
    // Bounded: a stalled D1 REST call would otherwise hang the VPS worker's
    // current operation until the job timeout. 25s fails fast under D1's 30s
    // per-query ceiling (these calls normally resolve in milliseconds).
    const res = await fetch(d1Url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: sqlParams }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = res.ok
      ? (await res.json()) as { success?: boolean; errors?: Array<{ message?: string }>; result?: Array<{ results?: { columns?: string[]; rows?: unknown[][] } }> }
      : { success: false as const, errors: [{ message: `HTTP ${res.status}` }] };
    if (body.success === false) {
      throw new Error(`D1 HTTP statement failed: ${body.errors?.map((e) => e.message ?? String(e)).join('; ') ?? 'unknown error'}`);
    }
    const { columns = [], rows = [] } = body.result?.[0]?.results ?? {};
    return rows.map((vals) => Object.fromEntries(columns.map((c, i) => [c, vals[i]])));
  }

  return async (statements) => {
    // WORKER_INTERNAL_URL is the deployed Worker's public origin (set on the
    // VPS post-cutover) — NOT WORKER_URL, which is a truthy "VPS is active"
    // flag elsewhere in the codebase, not a fetchable address.
    const workerBase = process.env.WORKER_INTERNAL_URL?.replace(/\/$/, '');
    if (workerBase && process.env.CRON_SECRET) {
      // Atomic path — the Worker holds the binding and its batch() is one
      // transaction. Dates were already serialized by d1HttpParam at the
      // boundary below, so JSON survives the round trip losslessly.
      // Bounded at 25s to fail fast under D1's 30s per-query ceiling — don't
      // hold dbTurn + worker slot another 30s after D1 already killed it.
      const res = await fetch(`${workerBase}/internal/raw-batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statements: statements.map((s) => ({ sql: s.sql, params: (s.params ?? []).map(d1HttpParam) })),
        }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = res.ok
        ? (await res.json()) as { success?: boolean; error?: string; results?: Array<Array<Record<string, unknown>>> }
        : { success: false as const, error: `HTTP ${res.status}` };
      if (body.success === false) throw new Error(`D1 batch via worker failed: ${body.error ?? res.status}`);
      return body.results ?? [];
    }

    if (statements.length > 1) {
      console.warn(
        `[store] D1 HTTP: executing ${statements.length} statements WITHOUT atomicity — `
        + 'set WORKER_URL + CRON_SECRET so batches run transactionally on the Worker.',
      );
    }
    const results: Array<Array<Record<string, unknown>>> = [];
    for (const s of statements) {
      results.push(await single(s.sql, (s.params ?? []).map(d1HttpParam)));
    }
    return results;
  };
}

/**
 * Node/Bun bootstrap for the post-cutover VPS worker: the SQLite client
 * (library-engine build of the same generated package the Worker uses) over
 * the official D1 HTTP adapter — no tunnel, no shim. Synchronous on purpose,
 * like initStorePostgres (importers query immediately).
 */
export function initStoreD1Http(params: D1HttpParams): AppPrismaClient {
  if (globalForStore.__slashloopStore) return globalForStore.__slashloopStore.client;
  const nodeRequire = createRequire(import.meta.url);
  const { PrismaClient } = nodeRequire('./generated/sqlite/index.js') as typeof import('./generated/sqlite/index.js');
  const { PrismaD1 } = nodeRequire('@prisma/adapter-d1') as typeof import('@prisma/adapter-d1');
  const client = new PrismaClient({
    adapter: new PrismaD1({
      CLOUDFLARE_ACCOUNT_ID: params.accountId,
      CLOUDFLARE_DATABASE_ID: params.databaseId,
      CLOUDFLARE_D1_TOKEN: params.token,
    }),
  });
  // Cast through unknown: the sqlite client's $extends type is not assignable
  // to the pg client's (see AppPrismaClient note above).
  setActiveClient(client as unknown as AppPrismaClient, d1HttpRawExecutor(params));
  return client as unknown as AppPrismaClient;
}

// ---------------------------------------------------------------------------
// Runtime-compat helpers
// ---------------------------------------------------------------------------

/**
 * P2002 (unique violation) without `instanceof Prisma.PrismaClientKnownRequestError`:
 * the Postgres and SQLite generated clients ship two DISTINCT error classes,
 * so a hardcoded instanceof silently misses on whichever client it wasn't
 * written against. Duck-type on the stable shape instead.
 */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown };
  return e?.code === 'P2002' && typeof e.name === 'string' && e.name.includes('PrismaClient');
}

/**
 * Raw SQL returns what SQLite stores: DATETIME columns come back as strings,
 * while the Postgres engine hydrates them to Date objects. Raw-row consumers
 * (claimNextJob et al.) get the same shapes on both runtimes by running the
 * known date columns through this.
 */
export function coerceRowDates<T extends Record<string, unknown>>(
  row: T,
  dateKeys: readonly (keyof T & string)[],
): T {
  for (const key of dateKeys) {
    const v = row[key];
    if (typeof v === 'string') row[key] = new Date(v) as T[keyof T & string];
    else if (typeof v === 'number') row[key] = new Date(v) as T[keyof T & string];
  }
  return row;
}

/**
 * D1 hard-caps bound parameters per query at 100. Prisma expands `in: [...]`
 * into one parameter per item, so any unbounded IN-list breaks on D1 even
 * though Postgres happily took thousands. Chunk at 90 for headroom.
 */
export const D1_PARAM_CHUNK = 90;

export async function chunked<T>(items: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += D1_PARAM_CHUNK) {
    await fn(items.slice(i, i + D1_PARAM_CHUNK));
  }
}
