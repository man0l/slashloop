// Workers runtime bindings + one-time store registration.
//
// The Worker entry (src/cf/worker.ts) calls ensureStore(env) before the first
// request / scheduled tick. That registers the SQLite PrismaClient (generated
// from prisma/schema.sqlite.prisma — the wasm/client engine build, which is
// the only variant that runs on workerd) with the D1 binding via
// @prisma/adapter-d1, plus the raw executor src/store.ts rawBatch() uses.

import { setActiveClient, type AppPrismaClient, type RawExecutor } from '../store.js';
import { setR2Bindings } from '../lib/storage-bindings.js';

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
      s.params && s.params.length > 0 ? d1.prepare(s.sql).bind(...s.params) : d1.prepare(s.sql),
    );
    const results = await d1.batch(prepared);
    return results.map((r) => (r.results ?? []) as unknown[]);
  };
}

const globalForCfStore = globalThis as unknown as { __slashloopCfStoreReady?: boolean };

/**
 * Idempotent per-isolate store setup. Binding objects are stable across
 * invocations on one isolate, so registering once is safe; a fresh isolate
 * simply runs this again on its first request.
 */
export async function ensureStore(env: Env): Promise<void> {
  copyEnvToProcessEnv(env);
  if (globalForCfStore.__slashloopCfStoreReady) return;

  const { PrismaClient } = await import('../generated/sqlite/wasm.js');
  const { PrismaD1 } = await import('@prisma/adapter-d1');
  // The adapter types the binding against its own bundled copy of
  // workers-types (which demands `dump()`); the runtime binding implements the
  // full interface — cast at the boundary, not in call code.
  //
  // Do NOT wrap this binding in serializeD1(), and do not gate fetch() on
  // D1: Prisma's wasm engine fans `_count` includes out as concurrent
  // adapter calls (a JS mutex deadlocks it), and a hung query behind a
  // request gate takes /health down with it. Intra-handler concurrency is
  // avoided by sequential Prisma calls (no Promise.all of db.*, no `_count`
  // includes).
  const adapter = new PrismaD1(env.DB_SHARD0 as unknown as ConstructorParameters<typeof PrismaD1>[0]);
  const client = new PrismaClient({ adapter });
  setActiveClient(client as unknown as AppPrismaClient, d1BindingRawExecutor(env.DB_SHARD0));
  // Media storage: bucket bindings (src/lib/storage.ts 'r2-binding' backend).
  setR2Bindings({ thumbs: env.R2_THUMBS, media: env.R2_MEDIA });
  globalForCfStore.__slashloopCfStoreReady = true;
}
