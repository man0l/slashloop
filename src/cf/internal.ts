// POST /internal/raw-batch — atomic batch execution for the VPS worker.
//
// The D1 REST API has no batch (one statement per /raw call), so a Node/Bun
// runtime cannot execute a transaction against D1 directly. This endpoint is
// the bridge: the VPS rawBatch executor (src/store.ts) POSTs its statements
// here, and they run through the D1 BINDING's batch() — one transaction, all
// or nothing. This is what keeps credit refunds on the VPS atomic after the
// cutover (src/lib/credits.ts refund paths in failJob/reclaimStuckJobs).
//
// Auth: Bearer CRON_SECRET — the same shared secret the job-drain endpoints
// already use. Not in vercel.json (Vercel never served it); Worker-only.

import { rawBatch, type RawStatement } from '../store.js';
import { takeBatchUsage } from '../lib/d1-usage.js';
import { CircuitBreaker, CircuitOpenError } from '../lib/circuit-breaker.js';
import { guardDailyReads, recordDailyReads, secondsUntilUtcMidnight } from './d1-read-budget.js';
import { keepAlive } from './wait-until.js';

// Per-isolate circuit breaker: while D1 is timing out, refuse inbound
// raw-batch traffic fast (503) instead of holding every request against the
// binding for the full 15s timeout — the 2026-09-22 burst was the VPS
// containers hammering this endpoint through a ~40s Cloudflare-side slow
// window. Kept OUTSIDE timedD1 on purpose: that wrapper is stateless by
// design (a stateful gate deadlocked the Prisma wasm engine 2026-09-01).
// Only infra failures count — 4xx-shape and application errors never trip it.
// Module state here is per-isolate, which is exactly the blast radius wanted.
const batchBreaker = new CircuitBreaker({ name: 'raw-batch', threshold: 3, cooldownMs: 60_000 });

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Sanity caps — this endpoint executes raw SQL, so keep the blast radius small. */
const MAX_STATEMENTS = 50;
const MAX_SQL_LENGTH = 100_000;
const MAX_TOTAL_PARAMS = 500;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'unauthorized' });
  }

  let body: { statements?: Array<{ sql?: unknown; params?: unknown }> };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const statements = (body.statements ?? []).filter(
    (s): s is RawStatement =>
      typeof s?.sql === 'string' && s.sql.length > 0 && s.sql.length <= MAX_SQL_LENGTH,
  );
  if (statements.length === 0 || statements.length > MAX_STATEMENTS) {
    return json(400, { error: `statements must number 1..${MAX_STATEMENTS}` });
  }
  const totalParams = statements.reduce((n, s) => n + (s.params?.length ?? 0), 0);
  if (totalParams > MAX_TOTAL_PARAMS) {
    return json(400, { error: `too many bound parameters (${totalParams} > ${MAX_TOTAL_PARAMS})` });
  }

  // Volume ceiling, checked after auth and shape validation (so a malformed
  // caller cannot spend budget it never earned) but before any D1 work. On the
  // free tier an over-budget read fails with Cloudflare 7500 for EVERY database
  // on the account until midnight UTC — 2026-09-30 a runaway VPS loop spent the
  // cap this way and took unrelated reads down with it. 429 + Retry-After, not
  // 503: the account is healthy, today's read budget is spent, and the caller
  // should come back after the reset.
  const budget = await guardDailyReads();
  if (!budget.allowed) {
    return json(
      429,
      { success: false, error: 'd1_daily_read_limit', rowsReadToday: budget.used, rowLimit: budget.limit },
      { 'Retry-After': String(secondsUntilUtcMidnight()) },
    );
  }

  try {
    const results = await batchBreaker.execute(() => rawBatch(statements));
    // Binding-side meta for the VPS caller's write attribution (Phase 0).
    // Additive fields — older VPS images ignore them.
    const usage = takeBatchUsage();
    // NOT awaited: recording can flush to KV, and a batch's 200 must not wait
    // on a KV write. keepAlive pins it to the request's IoContext on the
    // Worker (src/cf/worker.ts installs the store around every fetch) so the
    // flush survives the response being returned and cannot hang if the client
    // disconnects. recordDailyReads counts its rows locally before its first
    // await, so the next request's guard already sees them.
    keepAlive(recordDailyReads(usage.reads));
    return json(200, { success: true, results, rowsRead: usage.reads, rowsWritten: usage.writes });
  } catch (err) {
    const e = err as Error;
    // A batch that threw may still have been metered by D1, so the ceiling has
    // to see those rows too — otherwise a caller that only ever errors never
    // approaches the limit and is never refused. takeBatchUsage() is per-isolate
    // best-effort and can hand back an interleaved batch's rows; for a ceiling
    // that direction of error is the safe one.
    keepAlive(recordDailyReads(takeBatchUsage().reads));
    if (e instanceof CircuitOpenError) {
      // D1 is known-down: fail fast without touching the binding. The VPS
      // side reads this as an HTTP-5xx infra failure and trips its own
      // breaker — the cascade is intentional (both tiers go quiet together).
      return json(503, { success: false, error: e.message });
    }
    // Logged (not just returned) because provider request logs only capture
    // `POST /internal/raw-batch` — without this line the D1 cause never
    // reaches indiestack. Counts only: statements/params can carry user data.
    console.error(
      `[internal/raw-batch] batch failed (${statements.length} statements, ${totalParams} params): ${e.message}${e.stack ? `\n${e.stack}` : ''}`.slice(0, 2000),
    );
    return json(500, { success: false, error: e.message });
  }
}

export async function GET(): Promise<Response> {
  return json(405, { error: 'method_not_allowed' });
}
