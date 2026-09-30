// create_brief used to stay on the MCP request until Gemini returned (up to 90s).
// The edge answered `error code: 502` after the debit, and the caller cached
// that empty body. A replay then returns result: null, so the brief id is gone.
// Reserve a row first, return inside BRIEF_INLINE_BUDGET_MS, and let a slow
// model call finish after the response.

import { BriefDataSchema, type BriefData } from './schema.js';

/**
 * Stay under the edge and the tool gateway. The gateway aborts a remote
 * tool call at 10s by default and surfaces the dropped response as
 * `error code: 502`, which it then caches for write tools. Reserve the row
 * first and answer inside this budget; the model call may finish after.
 */
export const BRIEF_INLINE_BUDGET_MS = 6_000;

export type StoredBrief =
  | { status: 'ready'; brief: BriefData }
  | { status: 'generating' }
  | { status: 'failed'; error: string }
  | { status: 'unreadable' };

export function generatingBriefJson(): string {
  return JSON.stringify({ status: 'generating' });
}

export function failedBriefJson(error: string): string {
  return JSON.stringify({ status: 'failed', error });
}

/** Existing rows are BriefData JSON with no status field. Sentinels are not. */
export function readStoredBrief(briefJson: string): StoredBrief {
  let parsed: unknown;
  try {
    parsed = JSON.parse(briefJson);
  } catch {
    return { status: 'unreadable' };
  }
  const ready = BriefDataSchema.safeParse(parsed);
  if (ready.success) return { status: 'ready', brief: ready.data };
  if (!parsed || typeof parsed !== 'object') return { status: 'unreadable' };
  const status = (parsed as { status?: unknown }).status;
  if (status === 'generating') return { status: 'generating' };
  if (status === 'failed') {
    const error = (parsed as { error?: unknown }).error;
    return { status: 'failed', error: typeof error === 'string' && error ? error : 'Brief generation failed' };
  }
  return { status: 'unreadable' };
}

export function raceBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<{ kind: 'done'; value: T } | { kind: 'budget' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ kind: 'budget' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'budget' }), budgetMs);
  });
  return Promise.race([
    work.then((value) => ({ kind: 'done' as const, value })),
    budget,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface BriefRefRow {
  id: string;
  analysisId: string;
  createdAt: Date | string;
  briefJson: string;
}

export interface BriefRef {
  briefId: string;
  briefStatus: StoredBrief['status'];
}

function millis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Newest row per analysisId. A later generating row wins over an older ready one. */
export function indexLatestBriefs(rows: BriefRefRow[]): Map<string, BriefRef> {
  const sorted = [...rows].sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  const out = new Map<string, BriefRef>();
  for (const row of sorted) {
    if (out.has(row.analysisId)) continue;
    out.set(row.analysisId, { briefId: row.id, briefStatus: readStoredBrief(row.briefJson).status });
  }
  return out;
}

export interface BriefListItem {
  id: string;
  analysisId: string;
  ideaId: string | null;
  videoId: string | null;
  createdAt: string;
  status: StoredBrief['status'];
  concept: string | null;
  error: string | null;
}

export function toBriefListItem(row: {
  id: string;
  analysisId: string;
  ideaId: string | null;
  createdAt: Date;
  videoId: string | null;
  briefJson: string;
}): BriefListItem {
  const stored = readStoredBrief(row.briefJson);
  return {
    id: row.id,
    analysisId: row.analysisId,
    ideaId: row.ideaId,
    videoId: row.videoId,
    createdAt: row.createdAt.toISOString(),
    status: stored.status,
    concept: stored.status === 'ready' ? stored.brief.concept : null,
    error: stored.status === 'failed' ? stored.error : null,
  };
}

/** Error body for create_brief. `id` is set whenever a row was reserved. */
export function briefFailurePayload(args: {
  message: string;
  briefId: string | null;
  creditsRemaining: number | null;
}) {
  return {
    error: 'Brief generation failed',
    message: args.message,
    id: args.briefId,
    briefId: args.briefId,
    status: 'failed' as const,
    creditsCharged: 0,
    creditsRemaining: args.creditsRemaining,
    note: args.briefId
      ? 'The brief id was reserved before this failure. get_brief and list_briefs can still see the row. The charge was refunded.'
      : 'No brief row was reserved.',
  };
}

export function briefGeneratingPayload(args: {
  id: string;
  creditsCharged: number;
  creditsRemaining: number;
}) {
  return {
    message: 'Brief id reserved. Generation is still running.',
    id: args.id,
    briefId: args.id,
    status: 'generating' as const,
    brief: null,
    creditsCharged: args.creditsCharged,
    creditsRemaining: args.creditsRemaining,
    recovery: {
      tool: 'get_brief',
      args: { briefId: args.id },
      listTool: 'list_briefs',
    },
    note: 'If this response is lost, list_briefs by analysisId returns this id. A later failure refunds the charge and get_brief reports status "failed".',
  };
}
