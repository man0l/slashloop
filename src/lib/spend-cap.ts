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
): Promise<void> {
  await db.usageLog.create({
    data: {
      workspaceId,
      kind: 'scrape',
      provider: 'apify',
      units: 1,
      costCents,
      refId,
    },
  });
}
