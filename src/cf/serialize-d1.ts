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

/** Timeout for the timeout-only wrapper below (diagnostic, not a gate). */
export const D1_CALL_TIMEOUT_MS = 15_000;

const ORIGINALS = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
/** Query text per wrapped statement, so batch timeouts can name their SQL. */
const QUERY_TEXT = new WeakMap<D1PreparedStatement, string>();

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

// ---------------------------------------------------------------------------
// Timeout-only wrapper (diagnostic + fail-fast).
//
// Unlike serializeD1 above, this holds NO shared state: no queue, no gate,
// no wedge flag. Each binding call simply races the real thing against a
// timeout, logging the stuck query text and rejecting so the request fails
// fast (500 + retryable error downstream) instead of spinning forever.
//
// Why this is safe where the mutex was not: the Sept-1 deadlock needed the
// gate — the wasm engine issues overlapping adapter calls within one logical
// query and the mutex reordered/starved them. A pure timeout changes no
// ordering; a healthy query never notices it, and a wedged one becomes a
// log line with the exact SQL instead of a silent hang.
//
// Both the PrismaD1 adapter binding and the raw-batch executor go through
// the wrapped object, so every D1 call on the Worker is covered.
// ---------------------------------------------------------------------------

export interface TimedD1Options {
  timeoutMs?: number;
}

function snippet(query: string): string {
  const oneLine = query.replace(/\s+/g, ' ').trim();
  return oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
}

export function timedD1(d1: D1Database, opts: TimedD1Options = {}): D1Database {
  const timeoutMs = opts.timeoutMs ?? D1_CALL_TIMEOUT_MS;

  const guard = <T,>(kind: string, query: string, promise: Promise<T>): Promise<T> =>
    withTimeout(promise, timeoutMs, `D1 ${kind} timed out after ${timeoutMs}ms: ${snippet(query)}`).catch(
      (err: unknown) => {
        if (err instanceof Error && err.message.startsWith('D1 ') && err.message.includes('timed out')) {
          console.error(`[d1-timeout] ${kind} stuck: ${snippet(query)}`);
        }
        throw err;
      },
    );

  const wrapStatement = (stmt: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return wrapStatement(stmt.bind(...values), query);
      },
      first: <T = unknown>(colName?: string) => guard('first', query, stmt.first<T>(colName)),
      run: <T = unknown>() => guard('run', query, stmt.run<T>()),
      all: <T = unknown>() => guard('all', query, stmt.all<T>()),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) => guard('raw', query, stmt.raw<T>(options)),
    };
    ORIGINALS.set(wrapped, stmt);
    QUERY_TEXT.set(wrapped, query);
    return wrapped;
  };

  const unwrap = (stmt: D1PreparedStatement): D1PreparedStatement => ORIGINALS.get(stmt) ?? stmt;

  return {
    prepare(query: string) {
      return wrapStatement(d1.prepare(query), query);
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      const first = statements.length ? (QUERY_TEXT.get(statements[0]!) ?? '(batched statements)') : '(empty batch)';
      const label = statements.length === 1 ? 'batch[1]' : `batch[${statements.length}]`;
      return guard(label, first, d1.batch<T>(statements.map(unwrap)));
    },
    exec(query: string) {
      return guard('exec', query, d1.exec(query));
    },
    withSession(constraintOrBookmark?: string) {
      const session = d1.withSession(constraintOrBookmark);
      const wrappedDb = timedD1(session as unknown as D1Database, opts);
      return {
        prepare: (query: string) => wrappedDb.prepare(query),
        run: <T = unknown>(...statements: D1PreparedStatement[]) =>
          guard('session.run', '(batched statements)', session.run<T>(...statements.map(unwrap))),
      } satisfies D1DatabaseSession;
    },
  };
}
