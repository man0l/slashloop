import { db } from '../../db.js';
import { PROXY_PROVIDER, fmtBytes } from './bandwidth.js';
import { formatProxyCheap, proxyCheapBandwidth } from './proxy-cheap.js';

export const PROXY_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

let lastReconcileAt = 0;

/** Test seam. */
export function resetProxyReconcile(): void {
  lastReconcileAt = 0;
}

/** Ledger total for the calendar month across every workspace, in bytes. */
async function ledgerMonthBytes(now: Date): Promise<number> {
  const agg = await db.usageLog.aggregate({
    _sum: { units: true },
    where: {
      kind: 'scrape',
      provider: PROXY_PROVIDER,
      createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
    },
  });
  return (agg._sum.units ?? 0) * 1024;
}

/**
 * One line per day putting our UsageLog total next to the vendor's billed GB, so
 * drift between the two is visible. The vendor counter moves in 10 MB steps and
 * covers the whole plan (not one calendar month), so compare trends, not digits.
 * Throttled in-process; returns the line, or null when skipped or failed.
 */
export async function logProxyReconcile(
  now: Date = new Date(),
  log: (line: string) => void = console.log,
  deps: { ledger: (now: Date) => Promise<number>; vendor: typeof proxyCheapBandwidth } = {
    ledger: ledgerMonthBytes,
    vendor: proxyCheapBandwidth,
  },
): Promise<string | null> {
  if (now.getTime() - lastReconcileAt < PROXY_RECONCILE_INTERVAL_MS) return null;
  lastReconcileAt = now.getTime();
  try {
    const [ledger, vendor] = await Promise.all([deps.ledger(now), deps.vendor()]);
    const line = `[proxy:reconcile] ledger month ${fmtBytes(ledger)} | ${formatProxyCheap(vendor)}`;
    log(line);
    return line;
  } catch (err) {
    lastReconcileAt = now.getTime() - (PROXY_RECONCILE_INTERVAL_MS - RETRY_AFTER_FAILURE_MS);
    console.warn(`[proxy:reconcile] failed: ${(err as Error).message}`);
    return null;
  }
}
