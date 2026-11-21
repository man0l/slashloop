// Bounded retry for READ-ONLY D1 REST (/raw) requests.
//
// 2026-11-21 logs: `DriverAdapterError: Request timed out: POST …/d1/database/…/raw`
// on three different containers. A timed-out request says nothing about
// whether D1 applied it, so only statements that cannot change state are
// retried; anything else (INSERT/UPDATE/DELETE/DDL, unparseable bodies, a
// batch containing any write) surfaces on the first failure exactly as before.

const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 250;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** SELECT / EXPLAIN / a WITH CTE with no write keyword anywhere / PRAGMA without `=`. */
export function isReadOnlySql(sql: unknown): boolean {
  if (typeof sql !== 'string') return false;
  const s = sql.trimStart().toLowerCase();
  if (/^(select|explain)\b/.test(s)) return true;
  if (/^with\b/.test(s)) return !/\b(insert|update|delete|replace)\b/.test(s);
  if (/^pragma\b/.test(s)) return !s.includes('=');
  return false;
}

/** True when a /raw request body (JSON string) carries only read-only statements. */
export function isReadOnlyD1Body(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    const stmts = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { batch?: unknown })?.batch)
        ? (parsed as { batch: unknown[] }).batch
        : [parsed];
    return stmts.length > 0 && stmts.every((st) => isReadOnlySql((st as { sql?: unknown })?.sql));
  } catch {
    return false;
  }
}

export interface D1RetryOptions {
  maxRetries?: number;
  /** Tests override; production sleeps with exponential backoff + full jitter. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

/**
 * Run `send`, retrying transient failures (thrown errors, 429/5xx) up to
 * `maxRetries` times with jittered backoff. Callers decide retry-eligibility
 * (read-only) BEFORE calling; this helper only bounds and paces.
 */
export async function retryD1Request(
  send: () => Promise<Response>,
  opts: D1RetryOptions = {},
): Promise<Response> {
  const {
    maxRetries = MAX_RETRIES,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    random = Math.random,
    log = (m) => console.warn(m),
  } = opts;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: string | undefined;
    try {
      res = await send();
      if (!RETRYABLE_STATUS.has(res.status)) return res;
      failure = `HTTP ${res.status}`;
    } catch (err) {
      failure = (err as Error)?.message ?? String(err);
      if (attempt >= maxRetries) throw err;
    }
    if (attempt >= maxRetries) return res as Response;
    const delay = Math.round(random() * BASE_BACKOFF_MS * 2 ** attempt);
    log(`[d1] read request failed (${failure}); retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
    await sleep(delay);
  }
}
