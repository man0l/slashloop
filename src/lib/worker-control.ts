// ---------------------------------------------------------------------------
// Worker kill switches — a key/value control plane in the DB both runtimes
// read, so a runaway loop is parked in seconds without a redeploy.
//
// Keys: jobs.<kind>.enabled, experiments.enabled, stale_rescrape.enabled.
// Value "0" disables, anything else (including a missing row) enables — a
// fresh DB must never park everything. Reads are cached per key for
// CONTROL_CACHE_MS so the claim loop doesn't pay a query per round.
//
// Fail-open everywhere: a read error returns the default (enabled), so a
// control-plane outage can never stop the queue.
// ---------------------------------------------------------------------------

import { db } from '../db.js';

/** How long a control value is cached (one worker loop round is 10–60s). */
export const CONTROL_CACHE_MS = 60_000;

const cache = new Map<string, { enabled: boolean; at: number }>();

/** Read one switch. Default is enabled — pass false to default a new gate off. */
export async function controlEnabled(key: string, def = true, now = Date.now()): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CONTROL_CACHE_MS) return hit.enabled;
  try {
    const row = await db.workerControl.findUnique({ where: { key } });
    const enabled = !row || row.value !== '0';
    cache.set(key, { enabled, at: now });
    return enabled;
  } catch {
    return def;
  }
}

/** Flip one switch (ops use). Upsert so it works before any row exists. */
export async function setControl(key: string, enabled: boolean): Promise<void> {
  await db.workerControl.upsert({
    where: { key },
    create: { key, value: enabled ? '1' : '0' },
    update: { value: enabled ? '1' : '0' },
  });
  cache.set(key, { enabled, at: Date.now() });
}

/** Keep only claimable kinds. One query per cache window — safe in the hot loop. */
export async function filterKindsByControl(kinds: string[], now = Date.now()): Promise<string[]> {
  const keys = kinds.map((k) => `jobs.${k}.enabled`);
  const missing = keys.filter((key) => {
    const hit = cache.get(key);
    return !hit || now - hit.at >= CONTROL_CACHE_MS;
  });
  if (missing.length > 0) {
    try {
      const rows = await db.workerControl.findMany({ where: { key: { in: missing } } });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      for (const key of missing) {
        cache.set(key, { enabled: byKey.get(key) !== '0', at: now });
      }
    } catch {
      // Fail-open: uncached keys default to enabled below.
    }
  }
  return kinds.filter((k) => cache.get(`jobs.${k}.enabled`)?.enabled ?? true);
}

/** Test seam — clear the read cache. */
export function resetControlCacheForTests(): void {
  cache.clear();
}
