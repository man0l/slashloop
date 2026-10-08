// ---------------------------------------------------------------------------
// Provider-aware scraper spend status.
//
// The cap that governs a scrape follows the ACTIVE provider (scrapeCapKind):
// Apify is capped in cents (APIFY_SPEND_CAP_CENTS), the residential proxy in
// gigabytes (PROXY_TRAFFIC_CAP_GB). Past spend is NOT gated on the active
// provider — UsageLog rows with provider='apify' stay reportable after the
// cutover, so the history never disappears from the status tool.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { fmtBytes, PROXY_PROVIDER, trafficStatus } from './scrapers/bandwidth.js';
import { scrapeCapKind } from './scrapers/index.js';
import { getApifyCapStatus, getApifySpendBreakdown } from './spend-cap.js';

export interface ScraperCapStatus {
  workspaceId: string;
  /** Which ledger governs scrapes right now. */
  capKind: 'apify' | 'proxy';
  /** What the numbers below are measured in. */
  unit: 'cents' | 'bytes';
  capDisplay: string;
  usedDisplay: string;
  remainingDisplay: string;
  percentUsed: number;
  breached: boolean;
  warning: boolean;
  /** Ready-to-show one-liner, naming the env var that raises the active cap. */
  message: string;
}

export async function getScraperCapStatus(workspaceId: string): Promise<ScraperCapStatus> {
  const capKind = scrapeCapKind('tiktok');
  if (capKind === 'proxy') {
    const t = await trafficStatus(workspaceId);
    return {
      workspaceId,
      capKind,
      unit: 'bytes',
      capDisplay: fmtBytes(t.capBytes),
      usedDisplay: fmtBytes(t.usedBytes),
      remainingDisplay: fmtBytes(t.remainingBytes),
      percentUsed: t.percentUsed,
      breached: t.breached,
      warning: t.warning,
      message: t.breached
        ? 'CAP BREACHED — scrapes will refuse new proxy traffic. Raise PROXY_TRAFFIC_CAP_GB to continue, or wait for the next calendar month.'
        : t.warning
          ? `Approaching cap (${t.percentUsed}% used). ${fmtBytes(t.remainingBytes)} remaining.`
          : `OK — ${fmtBytes(t.remainingBytes)} remaining of ${fmtBytes(t.capBytes)} proxy traffic cap.`,
    };
  }
  const s = await getApifyCapStatus(workspaceId);
  return {
    workspaceId,
    capKind,
    unit: 'cents',
    capDisplay: s.capDisplay,
    usedDisplay: s.currentSpendDisplay,
    remainingDisplay: s.remainingDisplay,
    percentUsed: s.percentUsed,
    breached: s.breached,
    warning: s.warning,
    message: s.breached
      ? 'CAP BREACHED — refresh_source will refuse new Apify calls. Raise APIFY_SPEND_CAP_CENTS to continue.'
      : s.warning
        ? `Approaching cap (${s.percentUsed}% used). ${s.remainingDisplay} remaining.`
        : `OK — ${s.remainingDisplay} remaining of ${s.capDisplay} cap.`,
  };
}

export interface ProxySpendTotals {
  totalCents: number;
  /** Whole kilobytes, as stored in UsageLog.units. */
  totalKb: number;
  charges: number;
}

/** Proxy traffic recorded since `since` (default: start of this month). */
export async function getProxySpendTotals(workspaceId: string, since?: Date): Promise<ProxySpendTotals> {
  const now = new Date();
  const from = since ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const agg = await db.usageLog.aggregate({
    _sum: { costCents: true, units: true },
    _count: { _all: true },
    where: { workspaceId, kind: 'scrape', provider: PROXY_PROVIDER, createdAt: { gte: from } },
  });
  return {
    totalCents: agg._sum.costCents ?? 0,
    totalKb: agg._sum.units ?? 0,
    charges: agg._count?._all ?? 0,
  };
}

/**
 * Spend for BOTH providers over the same window. Historical provider='apify'
 * rows are always included, whichever provider is active now.
 */
export async function getScraperSpendBreakdown(workspaceId: string, since?: Date) {
  const [apify, proxy] = await Promise.all([
    getApifySpendBreakdown(workspaceId, since),
    getProxySpendTotals(workspaceId, since),
  ]);
  return { apify, proxy };
}
