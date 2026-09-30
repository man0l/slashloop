// generate_script used to stay on the MCP request until the model returned,
// and the tool name does not match the gateway's write-verb list, so a retry
// of the resulting 502 ran the tool again and charged another 2 credits.
// Reserve one row per logical request, answer inside the inline budget, and
// replay that row instead of debiting again.

import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { hasWaitUntil, keepAlive } from '../cf/wait-until.js';
import { isUniqueViolation } from '../store.js';
import { ScriptDataSchema, type ScriptData, type ScriptFormat } from './schema.js';
import { generateScript, type ScriptResult } from './scripts.js';
import { BRIEF_INLINE_BUDGET_MS, raceBudget } from './brief-delivery.js';

export const SCRIPT_INLINE_BUDGET_MS = BRIEF_INLINE_BUDGET_MS;

/** A generating row older than the model timeout is safe to take over. */
const STALE_GENERATING_MS = 100_000;

export class ScriptGenerationError extends Error {
  constructor(message: string, readonly scriptId: string | null) {
    super(message);
    this.name = 'ScriptGenerationError';
  }
}

export function normalizeScriptDuration(durationSec?: number): number {
  return Math.min(60, Math.max(10, Math.round(durationSec ?? 20)));
}

/**
 * One id per workspace + analysis + format + app + duration. An identical
 * replay resolves to the same row and the same ledger ref.
 */
export function logicalScriptId(input: {
  workspaceId: string;
  analysisId: string;
  format: string;
  appDescription: string;
  durationSec: number;
}): string {
  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    analysisId: input.analysisId,
    format: input.format,
    appDescription: input.appDescription.trim().replace(/\s+/g, ' '),
    durationSec: input.durationSec,
  });
  const hex = createHash('sha256').update(body).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type StoredScript =
  | { status: 'ready'; script: ScriptData }
  | { status: 'generating'; since: string | null }
  | { status: 'failed'; error: string }
  | { status: 'unreadable' };

export function generatingScriptJson(since = new Date().toISOString()): string {
  return JSON.stringify({ status: 'generating', since });
}

export function failedScriptJson(error: string): string {
  return JSON.stringify({ status: 'failed', error });
}

export function readStoredScript(scriptJson: string): StoredScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scriptJson);
  } catch {
    return { status: 'unreadable' };
  }
  const ready = ScriptDataSchema.safeParse(parsed);
  if (ready.success) return { status: 'ready', script: ready.data };
  if (!parsed || typeof parsed !== 'object') return { status: 'unreadable' };
  const status = (parsed as { status?: unknown }).status;
  if (status === 'generating') {
    const since = (parsed as { since?: unknown }).since;
    return { status: 'generating', since: typeof since === 'string' ? since : null };
  }
  if (status === 'failed') {
    const error = (parsed as { error?: unknown }).error;
    return { status: 'failed', error: typeof error === 'string' && error ? error : 'Script generation failed' };
  }
  return { status: 'unreadable' };
}

export interface ScriptRefRow {
  id: string;
  analysisId: string;
  createdAt: Date | string;
  scriptJson: string;
}

export interface ScriptRef {
  scriptId: string;
  scriptStatus: StoredScript['status'];
}

function millis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Newest script per analysisId. */
export function indexLatestScripts(rows: ScriptRefRow[]): Map<string, ScriptRef> {
  const sorted = [...rows].sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  const out = new Map<string, ScriptRef>();
  for (const row of sorted) {
    if (out.has(row.analysisId)) continue;
    out.set(row.analysisId, { scriptId: row.id, scriptStatus: readStoredScript(row.scriptJson).status });
  }
  return out;
}

export interface ScriptListItem {
  id: string;
  analysisId: string;
  videoId: string | null;
  format: string;
  createdAt: string;
  status: StoredScript['status'];
  hook: string | null;
  error: string | null;
}

export function toScriptListItem(row: {
  id: string;
  analysisId: string;
  format: string;
  createdAt: Date;
  videoId: string | null;
  scriptJson: string;
}): ScriptListItem {
  const stored = readStoredScript(row.scriptJson);
  return {
    id: row.id,
    analysisId: row.analysisId,
    videoId: row.videoId,
    format: row.format,
    createdAt: row.createdAt.toISOString(),
    status: stored.status,
    hook: stored.status === 'ready' ? stored.script.hook : null,
    error: stored.status === 'failed' ? stored.error : null,
  };
}

export function scriptFailurePayload(args: {
  message: string;
  scriptId: string | null;
  creditsRemaining: number | null;
}) {
  return {
    error: 'Script generation failed',
    message: args.message,
    id: args.scriptId,
    scriptId: args.scriptId,
    status: 'failed' as const,
    creditsCharged: 0,
    creditsRemaining: args.creditsRemaining,
    note: args.scriptId
      ? 'The script id was reserved before this failure. get_script and list_scripts can still see the row. The charge was refunded.'
      : 'No script row was reserved.',
  };
}

export function scriptGeneratingPayload(args: {
  id: string;
  creditsCharged: number;
  creditsRemaining: number;
  replayed: boolean;
}) {
  return {
    message: args.replayed
      ? 'Script id already reserved. Generation is still running. This replay was not charged.'
      : 'Script id reserved. Generation is still running.',
    id: args.id,
    scriptId: args.id,
    status: 'generating' as const,
    script: null,
    creditsCharged: args.creditsCharged,
    creditsRemaining: args.creditsRemaining,
    replayed: args.replayed,
    recovery: {
      tool: 'get_script',
      args: { scriptId: args.id },
      listTool: 'list_scripts',
    },
    note: 'If this response is lost, list_scripts by analysisId returns this id. An identical generate_script replay uses the same id and does not charge again.',
  };
}

export type ScriptDelivery =
  | { delivery: 'ready'; result: ScriptResult; replayed: boolean }
  | { delivery: 'generating'; id: string; replayed: boolean };

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Script generation failed';
}

function generatingAgeMs(stored: StoredScript, createdAt: Date): number {
  if (stored.status === 'generating' && stored.since) {
    const since = new Date(stored.since).getTime();
    if (!Number.isNaN(since)) return Date.now() - since;
  }
  return Date.now() - createdAt.getTime();
}

async function markScriptFailed(id: string, error: unknown): Promise<void> {
  await db.script.update({
    where: { id },
    data: { scriptJson: failedScriptJson(errorText(error)) },
  }).catch(() => {});
}

/**
 * Reserve `opts.id` (the logical id), then generate. A live reservation is
 * returned as-is so a retry does not start a second model call.
 */
export async function deliverScript(opts: {
  id: string;
  analysisId: string;
  workspaceId: string;
  format: ScriptFormat;
  appDescription: string;
  durationSec?: number;
  budgetMs?: number;
  onLateFailure?: (scriptId: string, error: unknown) => Promise<void>;
}): Promise<ScriptDelivery> {
  const owned = await db.analysis.findFirst({
    where: { id: opts.analysisId, video: { source: { workspaceId: opts.workspaceId } } },
    select: { id: true },
  });
  if (!owned) throw new ScriptGenerationError(`Analysis not found: ${opts.analysisId}`, null);

  const existing = await db.script.findUnique({ where: { id: opts.id } });
  if (existing) {
    const stored = readStoredScript(existing.scriptJson);
    if (stored.status === 'ready') {
      return { delivery: 'ready', result: { id: existing.id, script: stored.script }, replayed: true };
    }
    if (stored.status === 'generating' && generatingAgeMs(stored, existing.createdAt) < STALE_GENERATING_MS) {
      return { delivery: 'generating', id: existing.id, replayed: true };
    }
    await db.script.update({
      where: { id: opts.id },
      data: { format: opts.format, scriptJson: generatingScriptJson() },
    });
  } else {
    try {
      await db.script.create({
        data: {
          id: opts.id,
          analysisId: opts.analysisId,
          format: opts.format,
          scriptJson: generatingScriptJson(),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { delivery: 'generating', id: opts.id, replayed: true };
    }
  }

  const work = generateScript(
    opts.analysisId,
    { format: opts.format, appDescription: opts.appDescription, durationSec: opts.durationSec },
    'gemini-3.5-flash',
    opts.id,
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const raced = await raceBudget(work, opts.budgetMs ?? SCRIPT_INLINE_BUDGET_MS);
  if (raced.kind === 'done') {
    if (!raced.value.ok) {
      await markScriptFailed(opts.id, raced.value.error);
      throw new ScriptGenerationError(errorText(raced.value.error), opts.id);
    }
    return { delivery: 'ready', result: raced.value.result, replayed: false };
  }

  if (hasWaitUntil()) {
    keepAlive(work.then(async (settled) => {
      if (settled.ok) return;
      try {
        await markScriptFailed(opts.id, settled.error);
        await opts.onLateFailure?.(opts.id, settled.error);
      } catch (err) {
        console.error(`generate_script late failure ${opts.id}: ${errorText(err)}`);
      }
    }));
    return { delivery: 'generating', id: opts.id, replayed: false };
  }

  const settled = await work;
  if (!settled.ok) {
    await markScriptFailed(opts.id, settled.error);
    throw new ScriptGenerationError(errorText(settled.error), opts.id);
  }
  return { delivery: 'ready', result: settled.result, replayed: false };
}
