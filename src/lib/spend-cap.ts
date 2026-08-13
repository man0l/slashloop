// ---------------------------------------------------------------------------
// Spend Cap — Apify testing guardrail.
//
// Hard cap on monthly Apify spend (default $5 = 500 cents during testing).
// Before every Apify call, call assertApifyCap(). It will throw a
// SpendCapExceededError if the call would push monthly spend over the cap.
// When breached, we:
//   1. Persist a UsageLog row with kind='cap_breach' for audit
//   2. Emit a stderr notification banner
//   3. Optionally fire an external hook (APIFY_CAP_NOTIFICATION_HOOK env)
//
// The cap is read from APIFY_SPEND_CAP_CENTS at module load time. Update
// .env and restart the MCP server to change it.
// ---------------------------------------------------------------------------

import { db } from '../db.js';

export class SpendCapExceededError extends Error {
  constructor(
    public readonly provider: string,
    public readonly currentSpendCents: number,
    public readonly capCents: number,
    public readonly attemptedAddCents: number,
  ) {
    super(
      `Apify spend cap exceeded: monthly spend is $${(currentSpendCents / 100).toFixed(2)} ` +
      `(cap: $${(capCents / 100).toFixed(2)}). Refusing to add $${(attemptedAddCents / 100).toFixed(2)} more. ` +
      `Operations are halted. Raise APIFY_SPEND_CAP_CENTS in .env to continue, or wait for the next calendar month.`
    );
    this.name = 'SpendCapExceededError';
  }
}

const DEFAULT_CAP_CENTS = 500; // $5

export function getApifyCapCents(): number {
  const raw = process.env.APIFY_SPEND_CAP_CENTS;
  if (!raw) return DEFAULT_CAP_CENTS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_CENTS;
}

function getNotificationHook(): string | undefined {
  return process.env.APIFY_CAP_NOTIFICATION_HOOK || undefined;
}

// ---------------------------------------------------------------------------
// Monthly Apify spend so far
// ---------------------------------------------------------------------------

export async function getMonthlyApifySpendCents(workspaceId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const logs = await db.usageLog.findMany({
    where: {
      workspaceId,
      kind: 'scrape',
      provider: 'apify',
      createdAt: { gte: startOfMonth },
    },
    select: { costCents: true },
  });
  return logs.reduce((sum, l) => sum + l.costCents, 0);
}

// ---------------------------------------------------------------------------
// Cap status snapshot — used by get_apify_spend_status MCP tool
// ---------------------------------------------------------------------------

export interface ApifyCapStatus {
  workspaceId: string;
  capCents: number;
  capDisplay: string;
  currentSpendCents: number;
  currentSpendDisplay: string;
  remainingCents: number;
  remainingDisplay: string;
  percentUsed: number;
  breached: boolean;
  warning: boolean; // true at 80%+
}

export async function getApifyCapStatus(workspaceId: string): Promise<ApifyCapStatus> {
  const capCents = getApifyCapCents();
  const currentSpendCents = await getMonthlyApifySpendCents(workspaceId);
  const remainingCents = Math.max(0, capCents - currentSpendCents);
  const percentUsed = capCents > 0 ? (currentSpendCents / capCents) * 100 : 0;

  return {
    workspaceId,
    capCents,
    capDisplay: `$${(capCents / 100).toFixed(2)}`,
    currentSpendCents,
    currentSpendDisplay: `$${(currentSpendCents / 100).toFixed(2)}`,
    remainingCents,
    remainingDisplay: `$${(remainingCents / 100).toFixed(2)}`,
    percentUsed: Math.round(percentUsed * 10) / 10,
    breached: currentSpendCents >= capCents,
    warning: percentUsed >= 80,
  };
}

// ---------------------------------------------------------------------------
// assertApifyCap — call before every Apify API invocation
// ---------------------------------------------------------------------------

export async function assertApifyCap(
  workspaceId: string,
  attemptedAddCents: number,
): Promise<void> {
  const status = await getApifyCapStatus(workspaceId);
  if (status.currentSpendCents + attemptedAddCents > status.capCents) {
    // 1. Persist a cap_breach audit row
    await db.usageLog.create({
      data: {
        workspaceId,
        kind: 'cap_breach',
        provider: 'apify',
        units: 1,
        costCents: attemptedAddCents,
      },
    }).catch(err => console.error('[spend-cap] Failed to log cap_breach:', err));

    // 2. Stderr notification banner
    const banner = [
      '',
      '╔══════════════════════════════════════════════════════════════════╗',
      '║  ⚠️  APIFY SPEND CAP EXCEEDED — OPERATIONS HALTED                 ║',
      '╠══════════════════════════════════════════════════════════════════╣',
      `║  Monthly spend:  ${status.currentSpendDisplay.padEnd(50)}║`,
      `║  Cap:            ${status.capDisplay.padEnd(50)}║`,
      `║  Attempted add:  $${(attemptedAddCents / 100).toFixed(2).padEnd(49)}║`,
      `║  Remaining:      ${status.remainingDisplay.padEnd(50)}║`,
      '║                                                                  ║',
      '║  To resume: raise APIFY_SPEND_CAP_CENTS in .env and restart.      ║',
      '╚══════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.error(banner);

    // 3. Optional external hook (URL = POST, command = exec)
    const hook = getNotificationHook();
    if (hook) {
      try {
        if (hook.startsWith('http://') || hook.startsWith('https://')) {
          await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'apify_spend_cap_exceeded',
              workspaceId,
              currentSpendCents: status.currentSpendCents,
              capCents: status.capCents,
              attemptedAddCents,
              timestamp: new Date().toISOString(),
            }),
          });
        } else {
          // Treat as shell command
          const { exec } = await import('node:child_process');
          exec(`${hook} "${workspaceId}" "${status.currentSpendCents}" "${status.capCents}"`, { timeout: 5000 });
        }
      } catch (err) {
        console.error('[spend-cap] Notification hook failed:', (err as Error).message);
      }
    }

    throw new SpendCapExceededError('apify', status.currentSpendCents, status.capCents, attemptedAddCents);
  }

  // Warning at 80%
  if (status.percentUsed >= 80) {
    console.warn(
      `[spend-cap] WARNING: Apify spend at ${status.percentUsed}% of cap ` +
      `(${status.currentSpendDisplay} / ${status.capDisplay})`
    );
  }
}

// ---------------------------------------------------------------------------
// recordApifySpend — call after every successful Apify API invocation
// ---------------------------------------------------------------------------

export async function recordApifySpend(
  workspaceId: string,
  costCents: number,
  refId: string | null = null,
  activity: ApifySpendActivity = 'source_scrape',
): Promise<void> {
  await db.usageLog.create({
    data: {
      workspaceId,
      kind: 'scrape',
      provider: 'apify',
      units: 1,
      costCents,
      refId: encodeApifyRefId(activity, refId),
    },
  });
}

// ---------------------------------------------------------------------------
// Spend attribution — what did this Apify money actually buy?
//
// Every Apify charge lands in UsageLog as kind='scrape', because every one of
// them is Apify money and must count against the same monthly cap. But two
// very different activities share that row: refreshing a SOURCE (the listing
// scrape) and downloading ONE VIDEO's MP4 for gemini-native analysis.
//
// Until this existed, both wrote refId=null, so a ledger showing $22.95 of
// "scraping" was really scrape + analysis downloads mixed together, and none
// of it could be traced back to the source or video that caused it. That made
// the refresh-policy savings unmeasurable: RefreshRun costs summed to roughly
// half the scrape ledger and the gap looked like leakage when most of it was
// analysis downloads doing exactly what they were asked to.
//
// No migration: the activity is encoded as a prefix on the existing refId
// column ("source_scrape:<sourceId>"). Rows written before this change have
// refId=null and report as 'legacy'.
// ---------------------------------------------------------------------------

/** What an Apify charge bought. */
export type ApifySpendActivity =
  /** A listing scrape for a source refresh (clockworks profile/hashtag/search). */
  | 'source_scrape'
  /** One video's MP4 pulled for gemini-native analysis. */
  | 'video_download';

const APIFY_SPEND_ACTIVITIES: ApifySpendActivity[] = ['source_scrape', 'video_download'];

export function encodeApifyRefId(
  activity: ApifySpendActivity,
  refId: string | null,
): string {
  return refId ? `${activity}:${refId}` : activity;
}

/**
 * Recover the activity from a stored refId. Rows predating the prefix
 * convention report 'legacy' — they are genuinely unattributable, and
 * pretending otherwise would silently misreport historical spend.
 */
export function decodeApifyRefId(
  refId: string | null | undefined,
): { activity: ApifySpendActivity | 'legacy'; ref: string | null } {
  if (!refId) return { activity: 'legacy', ref: null };
  for (const activity of APIFY_SPEND_ACTIVITIES) {
    if (refId === activity) return { activity, ref: null };
    if (refId.startsWith(`${activity}:`)) {
      return { activity, ref: refId.slice(activity.length + 1) };
    }
  }
  return { activity: 'legacy', ref: refId };
}

export interface ApifySpendBreakdown {
  totalCents: number;
  byActivity: Record<ApifySpendActivity | 'legacy', { cents: number; charges: number }>;
}

/**
 * Split a workspace's Apify spend by what it bought. Defaults to the current
 * calendar month so it lines up with the cap.
 */
export async function getApifySpendBreakdown(
  workspaceId: string,
  since?: Date,
): Promise<ApifySpendBreakdown> {
  const now = new Date();
  const from = since ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const logs = await db.usageLog.findMany({
    where: { workspaceId, kind: 'scrape', provider: 'apify', createdAt: { gte: from } },
    select: { costCents: true, refId: true },
  });

  const byActivity = {
    source_scrape: { cents: 0, charges: 0 },
    video_download: { cents: 0, charges: 0 },
    legacy: { cents: 0, charges: 0 },
  } as ApifySpendBreakdown['byActivity'];

  let totalCents = 0;
  for (const l of logs) {
    const { activity } = decodeApifyRefId(l.refId);
    byActivity[activity].cents += l.costCents;
    byActivity[activity].charges += 1;
    totalCents += l.costCents;
  }

  return { totalCents, byActivity };
}
