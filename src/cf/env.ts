// Workers runtime bindings + one-time store registration.
//
// The Worker entry (src/cf/worker.ts) calls ensureStore(env) before the first
// request / scheduled tick. That registers the SQLite PrismaClient (generated
// from prisma/schema.sqlite.prisma — the wasm/client engine build, which is
// the only variant that runs on workerd) with the D1 binding via
// @prisma/adapter-d1, plus the raw executor src/store.ts rawBatch() uses.
//
// Prisma + the adapter are static imports so their module graph is evaluated
// at isolate startup, not inside a request IoContext. A client abort during
// a request-scoped `await import()` would freeze the ESM cache forever
// (same hang as better-auth#10315). Construction still happens in
// ensureStore because it needs the request-scoped D1 binding.

import { PrismaClient } from '../generated/sqlite/wasm.js';
import { PrismaD1 } from '@prisma/adapter-d1';
import { d1BindParam, setActiveClient, type AppPrismaClient, type RawExecutor } from '../store.js';
import { setR2Bindings } from '../lib/storage-bindings.js';
import { timedD1 } from './serialize-d1.js';
import { setShardDirectory } from './kv.js';
import { keepAlive } from './wait-until.js';

export interface Env {
  /** D1 database "slashloop" — the single shard (see src/store.ts). */
  DB_SHARD0: D1Database;
  /** Same buckets src/lib/storage.ts uses over the S3 API from Node runtimes. */
  R2_THUMBS: R2Bucket;
  R2_MEDIA: R2Bucket;
  /** Shard directory: maps ownerId → shard id. Unused while SHARD_COUNT=1. */
  SHARD_DIRECTORY: KVNamespace;
  /** All vars/secrets also arrive as strings here (see copyEnvToProcessEnv). */
  [key: string]: unknown;
}

/**
 * The app reads config through process.env (Vercel/VPS heritage). Workers
 * deliver vars/secrets on `env`; copy the string-valued ones over once per
 * isolate so nothing downstream needs to know the difference. Bindings are
 * objects and are deliberately skipped.
 */
export function copyEnvToProcessEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[key] = value;
  }
}

/**
 * Atomic multi-statement execution on the D1 binding: D1Database.batch runs
 * all statements as one transaction and rolls back on the first failure.
 * Results arrive per statement as object rows (column-name keyed), matching
 * what the Postgres engine returns from raw queries.
 */
export function d1BindingRawExecutor(d1: D1Database): RawExecutor {
  return async (statements) => {
    const prepared = statements.map((s) =>
      s.params && s.params.length > 0
        ? d1.prepare(s.sql).bind(...s.params.map(d1BindParam))
        : d1.prepare(s.sql),
    );
    const results = await d1.batch(prepared);
    return results.map((r) => (r.results ?? []) as unknown[]);
  };
}

const globalForCfStore = globalThis as unknown as { __slashloopCfStoreReady?: boolean };

/** In-flight init. Cached only while pending/settled-ok; cleared on failure so the next request retries. */
let initPromise: Promise<void> | undefined;

type WaitUntilCtx = { waitUntil(promise: Promise<unknown>): void };

/**
 * Idempotent per-isolate store setup. Binding objects are stable across
 * invocations on one isolate, so registering once is safe; a fresh isolate
 * simply runs this again on its first request.
 *
 * The init promise is pinned with waitUntil before any await: if the first
 * request is client-aborted mid-$connect, workerd must still settle the
 * engine start or every later db.* on this isolate hangs on Prisma's
 * cached `_connectionPromise`.
 */
export async function ensureStore(env: Env, ctx?: WaitUntilCtx): Promise<void> {
  copyEnvToProcessEnv(env);
  if (globalForCfStore.__slashloopCfStoreReady) return;

  if (!initPromise) {
    initPromise = initStore(env);
  }
  // Pin synchronously, before awaiting — abort between create and waitUntil
  // is the race that freezes a request-bound promise in the isolate cache.
  ctx?.waitUntil(initPromise.then(() => {}, () => {}));
  keepAlive(initPromise);
  await initPromise;
}

async function initStore(env: Env): Promise<void> {
  try {
    // The adapter types the binding against its own bundled copy of
    // workers-types (which demands `dump()`); the runtime binding implements the
    // full interface — cast at the boundary, not in call code.
    //
    // Do NOT wrap this binding in serializeD1(): Prisma's wasm engine fans
    // `_count` includes out as concurrent adapter calls (a JS mutex deadlocks
    // it). Intra-handler concurrency is avoided by sequential Prisma calls
    // (no Promise.all of db.*, no `_count` includes).
    //
    // timedD1() is timeout-only (no queue, no shared state): it changes no
    // ordering, so it cannot deadlock — a stuck call just logs its SQL and
    // rejects instead of spinning the request forever.
    const timed = timedD1(env.DB_SHARD0);
    const adapter = new PrismaD1(timed as unknown as ConstructorParameters<typeof PrismaD1>[0]);
    const client = new PrismaClient({ adapter });
    // Eager engine start so `_connectionPromise` is created under waitUntil,
    // not lazily on the first query of a request that may abort.
    await client.$connect();
    setActiveClient(client as unknown as AppPrismaClient, d1BindingRawExecutor(timed));
    setR2Bindings({ thumbs: env.R2_THUMBS, media: env.R2_MEDIA });
    setShardDirectory(env.SHARD_DIRECTORY);
    globalForCfStore.__slashloopCfStoreReady = true;
  } catch (err) {
    initPromise = undefined;
    throw err;
  }
}
