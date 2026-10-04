// ---------------------------------------------------------------------------
// Bounded retry for transient D1/Prisma driver failures in the rescore path.
//
// SLA-386. A burst of `DriverAdapterError: internal error` from the D1 HTTP
// adapter during rescoreStaleTooFresh silently degraded the sweep: the
// per-workspace balance read's `.catch(() => -1)` treated a transient blip the
// same as "out of credits", so an affordable workspace was skipped and fell
// back to the free (stale) recompute — and a top-level read failure aborted
// the whole sweep for the round. Only the adapter's own `console.error`
// surfaced, as `level=error`, with no app-level line to tell the two apart.
//
// Retry only the genuinely transient cases (a D1/edge hiccup, not a schema or
// constraint error), with exponential backoff + jitter, and only a few times.
// Nothing here changes what a permanent failure does — those still surface and
// degrade exactly as before; we just stop treating a momentary blip as a
// verdict.
// ---------------------------------------------------------------------------

/**
 * SQLite error kinds the D1 adapter produces for PERMANENT failures. These are
 * stable across attempts, so retrying cannot fix them — the rest (a generic
 * `kind: "sqlite"` / internal error, network/HTTP failures) are treated as
 * transient and retried.
 */
const PERMANENT_SQLITE_KINDS = new Set([
  'TableDoesNotExist',
  'ColumnNotFound',
  'NullConstraintViolation',
  'ForeignKeyConstraintViolation',
]);

/** Network/HTTP failure markers that are transient even outside the adapter. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True when a caught value is a D1/Prisma driver failure that a short backoff
 * is likely to clear — i.e. NOT a permanent schema/constraint error.
 *
 * Duck-typed on `name` + `cause.kind` so it works whether the value is a real
 * `DriverAdapterError` or a shallow look-alike in a test.
 */
export function isTransientD1Error(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; cause?: { kind?: unknown; code?: unknown; status?: unknown } } | null;
  if (!e) return false;
  if (e.name === 'DriverAdapterError') {
    const kind = e.cause?.kind;
    return typeof kind !== 'string' || !PERMANENT_SQLITE_KINDS.has(kind);
  }
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  const code = e.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // HTTP 429 / 5xx read as transient; 4xx (except 429) do not.
  const status = e.cause?.status;
  if (typeof status === 'number') return status === 429 || (status >= 500 && status < 600);
  return false;
}

export interface RetryTransientOptions {
  /** Total attempts (default 3). */
  attempts?: number;
  /** Base backoff in ms (default 250); doubles per retry. */
  baseMs?: number;
  /** Upper bound on a single backoff in ms (default 4000). */
  maxMs?: number;
  /** Fractional jitter on ±jitter of the backoff (default 0.2). */
  jitter?: number;
  /** Observer for each retry (not called after the final failure). */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Run `fn` and, on a TRANSIENT D1 error only, retry with exponential backoff +
 * jitter up to `attempts` times. A permanent failure (or the final attempt's
 * failure) is rethrown unchanged, so callers keep their existing degrade/catch
 * behaviour. `fn` receives the 1-based attempt number.
 */
export async function retryTransientD1<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryTransientOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 4_000;
  const jitter = opts.jitter ?? 0.2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isTransientD1Error(err) || attempt === attempts) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = backoff * (1 + (Math.random() * 2 - 1) * jitter);
      opts.onRetry?.(attempt, err);
      await sleep(Math.max(0, delay));
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
