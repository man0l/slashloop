// ---------------------------------------------------------------------------
// Proxy traffic budget.
//
// The residential proxy is sold by the GIGABYTE, not by the request. That
// inverts every instinct the Apify path built: there, a cheap retry was a
// re-read of a stored dataset; here, the cheapest call is the one whose
// RESPONSE BODY is smallest, and a retry is pure loss. So bandwidth is
// metered the way Apify spend is metered — pre-authorised before the call,
// recorded after it, capped monthly, and refused (never silently exceeded)
// when the cap is hit.
//
// Accounting unit is the KILOBYTE, stored in UsageLog.units, because an Int
// column holding raw bytes overflows at ~2GB — which is *below* a normal
// monthly plan. costCents is derived from PROXY_COST_CENTS_PER_GB so proxy
// traffic shows up in the same COGS reporting as everything else.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../../db.js';

export const PROXY_PROVIDER = 'proxy';

export const BYTES_PER_GB = 1024 * 1024 * 1024;
const DEFAULT_CAP_GB = 1;
const DEFAULT_COST_CENTS_PER_GB = 300; // $3/GB — typical rotating-residential rate

export class TrafficCapExceededError extends Error {
  constructor(
    public readonly usedBytes: number,
    public readonly capBytes: number,
    public readonly attemptedBytes: number,
  ) {
    super(
      `Proxy traffic cap exceeded: ${fmtBytes(usedBytes)} of ${fmtBytes(capBytes)} used this month. `
      + `Refusing an estimated ${fmtBytes(attemptedBytes)} more. `
      + `Raise PROXY_TRAFFIC_CAP_GB in .env, or wait for the next calendar month.`,
    );
    this.name = 'TrafficCapExceededError';
  }
}

export function fmtBytes(n: number): string {
  if (n >= BYTES_PER_GB) return `${(n / BYTES_PER_GB).toFixed(3)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Monthly traffic ceiling in bytes. PROXY_TRAFFIC_CAP_GB, default 1GB. */
export function trafficCapBytes(): number {
  return Math.round(envNumber('PROXY_TRAFFIC_CAP_GB', DEFAULT_CAP_GB) * BYTES_PER_GB);
}

/** Modelled cost of N bytes, in cents (>=1 whenever any bytes moved). */
export function bytesToCents(bytes: number): number {
  const perGb = envNumber('PROXY_COST_CENTS_PER_GB', DEFAULT_COST_CENTS_PER_GB);
  const cents = (Math.max(0, bytes) / BYTES_PER_GB) * perGb;
  return bytes > 0 ? Math.max(1, Math.ceil(cents)) : 0;
}

// --- In-process meter -------------------------------------------------------
// The DB ledger is the source of truth across processes, but a single scrape
// makes many requests and must not round-trip Postgres per request. Requests
// accumulate here; the adapter flushes once per scrape.
//
// The meter is SCOPED, not a single process-wide counter. With the VPS
// worker draining several jobs concurrently, a global diff would attribute
// one scrape's bytes to whichever job happened to be running. Each network
// job runs inside withMeterScope(); meterBytes() lands in the innermost
// scope. The global counter remains for callers that still diff a whole run
// (tests, the browser signer).

let processBytes = 0;

const meterScope = new AsyncLocalStorage<{ bytes: number }>();

/** Run fn with a private byte counter; everything it meters lands in the scope. */
export function withMeterScope<T>(fn: () => Promise<T>): Promise<T> {
  return meterScope.run({ bytes: 0 }, fn);
}

/** Bytes metered inside the current scope (0 outside any scope). */
export function scopeBytesUsed(): number {
  return meterScope.getStore()?.bytes ?? 0;
}

export function meterBytes(n: number): void {
  if (Number.isFinite(n) && n > 0) {
    const scope = meterScope.getStore();
    if (scope) scope.bytes += n;
    else processBytes += n;
  }
}

export function processBytesUsed(): number {
  return processBytes;
}

/** Test seam. */
export function resetProcessMeter(): void {
  processBytes = 0;
}

// --- Monthly ledger ---------------------------------------------------------

export async function monthlyProxyBytes(workspaceId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db.usageLog.findMany({
    where: {
      workspaceId,
      kind: 'scrape',
      provider: PROXY_PROVIDER,
      createdAt: { gte: startOfMonth },
    },
    select: { units: true },
  });
  return rows.reduce((sum, r) => sum + r.units, 0) * 1024;
}

export interface TrafficStatus {
  workspaceId: string;
  capBytes: number;
  usedBytes: number;
  remainingBytes: number;
  percentUsed: number;
  breached: boolean;
  warning: boolean;
  display: string;
}

export async function trafficStatus(workspaceId: string): Promise<TrafficStatus> {
  const capBytes = trafficCapBytes();
  const usedBytes = await monthlyProxyBytes(workspaceId);
  const percentUsed = capBytes > 0 ? Math.round((usedBytes / capBytes) * 100) : 0;
  return {
    workspaceId,
    capBytes,
    usedBytes,
    remainingBytes: Math.max(0, capBytes - usedBytes),
    percentUsed,
    breached: usedBytes >= capBytes,
    warning: percentUsed >= 80,
    display: `${fmtBytes(usedBytes)} / ${fmtBytes(capBytes)} (${percentUsed}%)`,
  };
}

/**
 * Refuse the call if it would push the workspace past its monthly cap.
 *
 * Pre-authorised on an ESTIMATE, like the Apify cap: a cap that is only
 * checked after the bytes are already down the wire is not a cap.
 */
/** Pure cap check — the rule `assertTrafficCap` applies after reading the ledger. */
export function wouldExceedCap(usedBytes: number, capBytes: number, estimatedBytes: number): boolean {
  return usedBytes + Math.max(0, estimatedBytes) > capBytes;
}

export async function assertTrafficCap(workspaceId: string, estimatedBytes: number): Promise<void> {
  const capBytes = trafficCapBytes();
  const used = await monthlyProxyBytes(workspaceId);
  if (wouldExceedCap(used, capBytes, estimatedBytes)) {
    console.error(
      `[proxy:cap] workspace ${workspaceId} at ${fmtBytes(used)} of ${fmtBytes(capBytes)} — refusing `
      + `an estimated ${fmtBytes(estimatedBytes)}`,
    );
    throw new TrafficCapExceededError(used, capBytes, estimatedBytes);
  }
}

/**
 * Record what actually moved. Rounded UP to whole KB so a burst of sub-KB
 * requests can never be billed as free.
 */
export async function recordTrafficBytes(
  workspaceId: string,
  bytes: number,
  refId: string | null,
): Promise<number> {
  const kb = Math.ceil(Math.max(0, bytes) / 1024);
  const costCents = bytesToCents(bytes);
  if (kb === 0) return 0;
  await db.usageLog.create({
    data: { workspaceId, kind: 'scrape', provider: PROXY_PROVIDER, units: kb, costCents, refId },
  });
  return costCents;
}
