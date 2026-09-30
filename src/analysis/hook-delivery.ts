// generate_hook_variations used to stay on the MCP request until the model
// returned. The tool name is not on the gateway write-verb list, so a retry
// of the resulting 502 ran the tool again and charged another 2 credits
// (sometimes more). Reserve one batch row per logical request, answer inside
// the inline budget, and replay that row instead of debiting again.

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { hasWaitUntil, keepAlive } from '../cf/wait-until.js';
import { isUniqueViolation } from '../store.js';
import { BRIEF_INLINE_BUDGET_MS, raceBudget } from './brief-delivery.js';
import {
  loadSourceHooks,
  requestHookVariations,
  type HookVariation,
  type SourceHook,
} from './hooks.js';

export const HOOK_INLINE_BUDGET_MS = BRIEF_INLINE_BUDGET_MS;

/** Hidden from list_hooks unless the caller asks for this type. */
export const HOOK_BATCH_TYPE = 'batch';

/** A generating row older than the model timeout is safe to take over. */
const STALE_GENERATING_MS = 100_000;

const savedVariationSchema = z.object({
  id: z.string(),
  text: z.string(),
  sourceIndex: z.number(),
  type: z.string(),
  mechanism: z.string(),
});

export interface SavedHookVariation {
  id: string;
  text: string;
  sourceIndex: number;
  type: string;
  mechanism: string;
}

export class HookGenerationError extends Error {
  constructor(message: string, readonly batchId: string | null) {
    super(message);
    this.name = 'HookGenerationError';
  }
}

export function normalizeProductDescription(productDescription: string): string {
  return productDescription.trim().replace(/\s+/g, ' ');
}

function uuidFromHash(body: string): string {
  const hex = createHash('sha256').update(body).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * One id per workspace + source hooks + product. An identical replay
 * resolves to the same row and the same ledger ref. Hook order does not
 * mint a new id.
 */
export function logicalHookBatchId(input: {
  workspaceId: string;
  hookIds: string[];
  productDescription: string;
}): string {
  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    hookIds: [...new Set(input.hookIds)].sort(),
    productDescription: normalizeProductDescription(input.productDescription),
  });
  return uuidFromHash(body);
}

export function logicalGeneratedHookId(batchId: string, index: number): string {
  return uuidFromHash(`${batchId}:${index}`);
}

export type StoredHookBatch =
  | { status: 'ready'; variations: SavedHookVariation[] }
  | { status: 'generating'; since: string | null }
  | { status: 'failed'; error: string }
  | { status: 'unreadable' };

export function generatingBatchJson(sourceHookIds: string[], since = new Date().toISOString()): string {
  return JSON.stringify({ batch: true, status: 'generating', since, sourceHookIds });
}

export function failedBatchJson(error: string, sourceHookIds: string[] = []): string {
  return JSON.stringify({ batch: true, status: 'failed', error, sourceHookIds });
}

export function readyBatchJson(variations: SavedHookVariation[], sourceHookIds: string[]): string {
  return JSON.stringify({ batch: true, status: 'ready', variations, sourceHookIds });
}

/** Quoted id as it appears inside batch JSON. Stays under D1's 50-byte LIKE cap. */
export function hookIdContainsToken(hookId: string): string {
  return `"${hookId}"`;
}

export function sourceHookIdsFromBatch(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const ids = (parsed as { sourceHookIds?: unknown }).sourceHookIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function readStoredHookBatch(text: string): StoredHookBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { batch?: unknown }).batch !== true) {
    return { status: 'unreadable' };
  }
  const status = (parsed as { status?: unknown }).status;
  if (status === 'generating') {
    const since = (parsed as { since?: unknown }).since;
    return { status: 'generating', since: typeof since === 'string' ? since : null };
  }
  if (status === 'failed') {
    const error = (parsed as { error?: unknown }).error;
    return { status: 'failed', error: typeof error === 'string' && error ? error : 'Hook generation failed' };
  }
  if (status === 'ready') {
    const variations = (parsed as { variations?: unknown }).variations;
    const ready = z.array(savedVariationSchema).safeParse(variations);
    if (ready.success && ready.data.length > 0) return { status: 'ready', variations: ready.data };
  }
  return { status: 'unreadable' };
}

export function hookFailurePayload(args: {
  message: string;
  batchId: string | null;
  creditsRemaining: number | null;
}) {
  return {
    error: 'Hook generation failed',
    message: args.message,
    id: args.batchId,
    batchId: args.batchId,
    status: 'failed' as const,
    creditsCharged: 0,
    creditsRemaining: args.creditsRemaining,
    note: args.batchId
      ? 'The batch id was reserved before this failure. list_hook_variations by a source hookId returns this id. An identical generate_hook_variations replay uses that id and does not charge again. The charge was refunded.'
      : 'No batch row was reserved.',
  };
}

export function hookGeneratingPayload(args: {
  id: string;
  sourceHookId: string;
  creditsCharged: number;
  creditsRemaining: number;
  replayed: boolean;
}) {
  return {
    message: args.replayed
      ? 'Hook batch id already reserved. Generation is still running. This replay was not charged.'
      : 'Hook batch id reserved. Generation is still running.',
    id: args.id,
    batchId: args.id,
    status: 'generating' as const,
    variations: null,
    creditsCharged: args.creditsCharged,
    creditsRemaining: args.creditsRemaining,
    replayed: args.replayed,
    recovery: {
      tool: 'list_hook_variations',
      args: { hookId: args.sourceHookId },
    },
    note: 'If this response is lost, list_hook_variations by a source hookId returns this id. An identical generate_hook_variations replay uses this id and does not charge again.',
  };
}

export interface HookVariationListItem {
  id: string;
  batchId: string;
  status: StoredHookBatch['status'];
  sourceHookIds: string[];
  createdAt: string;
  videoId: string;
  variations: SavedHookVariation[] | null;
  error: string | null;
}

export function toHookVariationListItem(row: {
  id: string;
  text: string;
  createdAt: Date;
  videoId: string;
}): HookVariationListItem {
  const stored = readStoredHookBatch(row.text);
  return {
    id: row.id,
    batchId: row.id,
    status: stored.status,
    sourceHookIds: sourceHookIdsFromBatch(row.text),
    createdAt: row.createdAt.toISOString(),
    videoId: row.videoId,
    variations: stored.status === 'ready' ? stored.variations : null,
    error: stored.status === 'failed' ? stored.error : null,
  };
}

export type HookDelivery =
  | { delivery: 'ready'; id: string; variations: SavedHookVariation[]; replayed: boolean }
  | { delivery: 'generating'; id: string; replayed: boolean };

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Hook generation failed';
}

function generatingAgeMs(stored: StoredHookBatch, createdAt: Date): number {
  if (stored.status === 'generating' && stored.since) {
    const since = new Date(stored.since).getTime();
    if (!Number.isNaN(since)) return Date.now() - since;
  }
  return Date.now() - createdAt.getTime();
}

async function markBatchFailed(id: string, error: unknown, sourceHookIds: string[]): Promise<void> {
  await db.hook.update({
    where: { id },
    data: { text: failedBatchJson(errorText(error), sourceHookIds) },
  }).catch(() => {});
}

async function persistGeneratedHooks(
  batchId: string,
  hooks: SourceHook[],
  variations: HookVariation[],
  sourceHookIds: string[],
): Promise<SavedHookVariation[]> {
  const saved: SavedHookVariation[] = [];
  for (let index = 0; index < variations.length; index++) {
    const variation = variations[index]!;
    const source = hooks[variation.sourceIndex];
    if (!source) continue;
    const id = logicalGeneratedHookId(batchId, index);
    const hookType = variation.type || source.hookType;
    await db.hook.upsert({
      where: { id },
      create: {
        id,
        videoId: source.videoId,
        analysisId: source.analysisId,
        text: variation.text,
        hookType,
        placement: source.placement,
        origin: 'generated',
        nicheTag: source.nicheTag,
      },
      update: {
        text: variation.text,
        hookType,
      },
    });
    saved.push({
      id,
      text: variation.text,
      sourceIndex: variation.sourceIndex,
      type: hookType,
      mechanism: variation.mechanism,
    });
  }
  if (saved.length === 0) throw new Error('Failed to parse hook variations');
  await db.hook.update({
    where: { id: batchId },
    data: { text: readyBatchJson(saved, sourceHookIds) },
  });
  return saved;
}

/**
 * Reserve `opts.id` (the logical batch id), then generate. A live
 * reservation is returned as-is so a retry does not start a second model call.
 */
export async function deliverHookVariations(opts: {
  id: string;
  workspaceId: string;
  hookIds: string[];
  productDescription: string;
  model?: string;
  budgetMs?: number;
  onLateFailure?: (batchId: string, error: unknown) => Promise<void>;
}): Promise<HookDelivery> {
  const orderedIds = [...new Set(opts.hookIds)].sort();
  const loaded = await loadSourceHooks(orderedIds);
  const byId = new Map(loaded.map((hook) => [hook.id, hook]));
  const hooks = orderedIds
    .map((id) => byId.get(id))
    .filter((hook): hook is SourceHook => !!hook && hook.workspaceId === opts.workspaceId);
  if (hooks.length !== orderedIds.length) {
    throw new HookGenerationError('Hook not found', null);
  }
  const anchor = hooks[0]!;

  const existing = await db.hook.findUnique({ where: { id: opts.id } });
  if (existing) {
    if (existing.hookType !== HOOK_BATCH_TYPE) {
      throw new HookGenerationError('Hook batch id collided with a vault hook', null);
    }
    const stored = readStoredHookBatch(existing.text);
    if (stored.status === 'ready') {
      return { delivery: 'ready', id: existing.id, variations: stored.variations, replayed: true };
    }
    if (stored.status === 'generating' && generatingAgeMs(stored, existing.createdAt) < STALE_GENERATING_MS) {
      return { delivery: 'generating', id: existing.id, replayed: true };
    }
    await db.hook.update({
      where: { id: opts.id },
      data: { text: generatingBatchJson(orderedIds) },
    });
  } else {
    try {
      await db.hook.create({
        data: {
          id: opts.id,
          videoId: anchor.videoId,
          analysisId: anchor.analysisId,
          text: generatingBatchJson(orderedIds),
          hookType: HOOK_BATCH_TYPE,
          placement: 'batch',
          origin: 'generated',
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { delivery: 'generating', id: opts.id, replayed: true };
    }
  }

  const work = (async () => {
    try {
      const variations = await requestHookVariations(
        hooks,
        opts.productDescription,
        opts.model ?? 'gemini-3.5-flash',
      );
      const saved = await persistGeneratedHooks(opts.id, hooks, variations, orderedIds);
      return { ok: true as const, saved };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();

  const raced = await raceBudget(work, opts.budgetMs ?? HOOK_INLINE_BUDGET_MS);
  if (raced.kind === 'done') {
    if (!raced.value.ok) {
      await markBatchFailed(opts.id, raced.value.error, orderedIds);
      throw new HookGenerationError(errorText(raced.value.error), opts.id);
    }
    return { delivery: 'ready', id: opts.id, variations: raced.value.saved, replayed: false };
  }

  if (hasWaitUntil()) {
    keepAlive(work.then(async (settled) => {
      if (settled.ok) return;
      try {
        await markBatchFailed(opts.id, settled.error, orderedIds);
        await opts.onLateFailure?.(opts.id, settled.error);
      } catch (err) {
        console.error(`generate_hook_variations late failure ${opts.id}: ${errorText(err)}`);
      }
    }));
    return { delivery: 'generating', id: opts.id, replayed: false };
  }

  const settled = await work;
  if (!settled.ok) {
    await markBatchFailed(opts.id, settled.error, orderedIds);
    throw new HookGenerationError(errorText(settled.error), opts.id);
  }
  return { delivery: 'ready', id: opts.id, variations: settled.saved, replayed: false };
}
