// Serialize every D1 statement on one isolate.
//
// NOT wired into src/cf/env.ts. Prisma's wasm engine fans `_count` includes
// out as concurrent adapter calls and waits for all of them before yielding
// to the JS event loop — a JS mutex around prepare()/raw() deadlocks it
// (reproduced live 2026-09-01 after wrapping the binding: /api/sources hung
// even with no other traffic, while single-query routes still responded).
//
// Isolate concurrency is handled by the request gate in worker.ts; intra-
// handler concurrency is avoided by sequential Prisma calls (no Promise.all
// of db.*, no `_count` includes). This helper stays for rawBatch/tests.

export const D1_QUERY_TIMEOUT_MS = 8_000;

const ORIGINALS = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface SerializeD1Options {
  timeoutMs?: number;
}

export function serializeD1(d1: D1Database, opts: SerializeD1Options = {}): D1Database {
  const timeoutMs = opts.timeoutMs ?? D1_QUERY_TIMEOUT_MS;
  let gate: Promise<unknown> = Promise.resolve();
  let wedged = false;

  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    if (wedged) {
      return Promise.reject(new Error('D1 binding wedged on this isolate after a timed-out query'));
    }
    const run = gate.then(fn, fn);
    const guarded = withTimeout(run, timeoutMs, `D1 query timed out after ${timeoutMs}ms`).catch((err: unknown) => {
      if (err instanceof Error && err.message.startsWith('D1 query timed out')) {
        wedged = true;
      }
      throw err;
    });
    // Advance the queue when the query settles OR times out — do not wait
    // forever on a hung binding (that was the handler-gate failure mode).
    gate = guarded.catch(() => {});
    return guarded;
  };

  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return wrapStatement(stmt.bind(...values));
      },
      first: <T = unknown>(colName?: string) => enqueue(() => stmt.first<T>(colName)),
      run: <T = unknown>() => enqueue(() => stmt.run<T>()),
      all: <T = unknown>() => enqueue(() => stmt.all<T>()),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) => enqueue(() => stmt.raw<T>(options)),
    };
    ORIGINALS.set(wrapped, stmt);
    return wrapped;
  };

  const unwrap = (stmt: D1PreparedStatement): D1PreparedStatement => ORIGINALS.get(stmt) ?? stmt;

  return {
    prepare(query: string) {
      return wrapStatement(d1.prepare(query));
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      return enqueue(() => d1.batch<T>(statements.map(unwrap)));
    },
    exec(query: string) {
      return enqueue(() => d1.exec(query));
    },
    withSession(constraintOrBookmark?: string) {
      const session = d1.withSession(constraintOrBookmark);
      // Sessions are a separate binding surface; wrap prepare the same way.
      const wrappedDb = serializeD1(session as unknown as D1Database, opts);
      return {
        prepare: (query: string) => wrappedDb.prepare(query),
        run: <T = unknown>(...statements: D1PreparedStatement[]) =>
          enqueue(() => session.run<T>(...statements.map(unwrap))),
      } satisfies D1DatabaseSession;
    },
  };
}
