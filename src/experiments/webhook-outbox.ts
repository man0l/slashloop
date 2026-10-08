// SLA-617: outbox queue operations. Rows are written by store.save() in the same
// batch as the terminal status change; this file claims, settles and prunes them.
import { batch, type Run } from './store.js';
import { deliver, isPaperclipConfigError, type DeliverDeps } from './webhook-delivery.js';

/** Delay before retry n (after the nth failed attempt). Sums to ~23.7h, then the row goes dead. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000, 36_000_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const CLAIM_LEASE_MS = 120_000;
const RETAIN_SETTLED_MS = 30 * 86_400_000;

export interface OutboxRow {
  id: string; experimentId: string; workspaceId: string; status: string; version: number;
  idempotencyKey: string; notifyJson: string; payloadJson: string; attempts: number;
}

/** Retry delay after `attempts` failed attempts, ±10% jitter; null when the budget is spent. */
export function retryDelayMs(attempts: number, rand: () => number = Math.random): number | null {
  const base = RETRY_DELAYS_MS[attempts - 1];
  return base === undefined ? null : Math.round(base * (0.9 + rand() * 0.2));
}

/** Leases up to `limit` due rows (nextAttemptAt pushed out by the lease) so a crashed worker's rows come back by themselves. */
export async function claimDue(now: Date, limit = 10, run: Run = batch): Promise<OutboxRow[]> {
  const due = ((await run([{ sql: `SELECT "id","experimentId","workspaceId","status","version","idempotencyKey","notifyJson","payloadJson","attempts" FROM "ExperimentWebhookOutbox" WHERE "state"='pending' AND "nextAttemptAt" <= ? ORDER BY "nextAttemptAt" ASC LIMIT ?`, params: [now, limit] }]))[0] ?? []) as OutboxRow[];
  if (!due.length) return [];
  const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
  const claimed = await run(due.map(r => ({
    sql: `UPDATE "ExperimentWebhookOutbox" SET "attempts"="attempts"+1,"nextAttemptAt"=? WHERE "id"=? AND "state"='pending' AND "attempts"=? AND "nextAttemptAt" <= ? RETURNING "id"`,
    params: [lease, r.id, r.attempts, now],
  })));
  return due.flatMap((r, i) => (claimed[i]?.length ? [{ ...r, attempts: r.attempts + 1 }] : []));
}

export async function markDelivered(id: string, now: Date, run: Run = batch): Promise<void> {
  await run([{ sql: `UPDATE "ExperimentWebhookOutbox" SET "state"='delivered',"deliveredAt"=?,"lastError"=NULL WHERE "id"=?`, params: [now, id] }]);
}
export async function markFailed(row: OutboxRow, error: string, permanent: boolean, now: Date, run: Run = batch): Promise<'retry' | 'dead'> {
  const delay = permanent ? null : retryDelayMs(row.attempts);
  if (delay === null) {
    await run([{ sql: `UPDATE "ExperimentWebhookOutbox" SET "state"='dead',"lastError"=? WHERE "id"=?`, params: [error, row.id] }]);
    return 'dead';
  }
  await run([{ sql: `UPDATE "ExperimentWebhookOutbox" SET "lastError"=?,"nextAttemptAt"=? WHERE "id"=?`, params: [error, new Date(now.getTime() + delay), row.id] }]);
  return 'retry';
}
/** Drops delivered and dead rows older than 30 days. */
export async function pruneSettled(now: Date, run: Run = batch): Promise<void> {
  await run([{ sql: `DELETE FROM "ExperimentWebhookOutbox" WHERE "state" <> 'pending' AND "createdAt" < ?`, params: [new Date(now.getTime() - RETAIN_SETTLED_MS)] }]);
}

export interface DeliverySweep { delivered: number; retried: number; dead: number }
/** One sweep: claim due events, deliver each, settle. Rows are independent; one failure never blocks the rest. */
export async function runWebhookDeliveries(
  deps: DeliverDeps & { run?: Run; limit?: number; clock?: () => Date } = {},
): Promise<DeliverySweep> {
  const run = deps.run ?? batch;
  const clock = deps.clock ?? (() => new Date());
  const sweep: DeliverySweep = { delivered: 0, retried: 0, dead: 0 };
  for (const row of await claimDue(clock(), deps.limit ?? 10, run)) {
    const result = await deliver(row, deps);
    if (result.ok) { await markDelivered(row.id, clock(), run); sweep.delivered++; continue; }
    if (isPaperclipConfigError(result.error)) console.error(`[webhook] CONFIG ERROR delivering ${row.idempotencyKey}: ${result.error}. ${result.permanent ? 'Retrying cannot fix this; the row will not be re-sent until it is requeued.' : 'Fix the key or env and recreate the worker; the row retries on its backoff schedule.'}`);
    const settled = await markFailed(row, result.error ?? 'delivery_failed', result.permanent, clock(), run);
    sweep[settled === 'dead' ? 'dead' : 'retried']++;
    if (settled === 'dead') console.warn(`[webhook] dead ${row.idempotencyKey} after ${row.attempts} attempt(s): ${result.error}`);
  }
  return sweep;
}
