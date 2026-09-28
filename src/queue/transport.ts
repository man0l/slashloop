// ---------------------------------------------------------------------------
// Per-kind queue transport controls (SLA-10 rev 4 Phase 2, SLA-16).
//
// Runtime ownership is per kind through the WorkerControl table:
//
//   queue.transport.<kind> = d1 | pg
//
// Rules (plan §Feature flags and single-owner transition):
// - Missing or invalid control inherits QUEUE_BACKEND (default 'd1').
// - QUEUE_BACKEND is only the static default / emergency override: setting
//   QUEUE_BACKEND=d1 forces D1 for every kind regardless of per-kind rows,
//   which is the emergency producer rollback path.
// - Existing jobs.<kind>.enabled remains the kill switch; transport controls
//   do not replace it (see filterKindsByControl in lib/worker-control.ts).
// - Only one transport owns a kind at a time; a kind may move to PG only
//   after the PG worker image is deployed and can consume it.
//
// Reads are cached briefly (CONTROL_CACHE_MS) and fail open to the default,
// so a control-plane outage can never stop the queue — same posture as
// controlEnabled in lib/worker-control.ts.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { CONTROL_CACHE_MS } from '../lib/worker-control.js';
import { QUEUE_KINDS, type QueueJobKind } from './contract.js';

/** Transports that may own a kind. */
export const QUEUE_TRANSPORTS = ['d1', 'pg'] as const;
export type QueueTransport = (typeof QUEUE_TRANSPORTS)[number];

/** D1 queueOwner marker values (plan §D1 ownership marker). */
export const QUEUE_OWNERS = ['d1', 'pg', 'fallback_d1'] as const;
export type QueueOwner = (typeof QUEUE_OWNERS)[number];

/** Fallback rows use this status: non-claimable by D1 and PG workers. */
export const QUEUE_FALLBACK_STATUS = 'queued_remote';

/** WorkerControl key: '1' enables D1 fallback on PG publish failure. Default off. */
export const QUEUE_FALLBACK_CONTROL_KEY = 'queue.fallback.enabled';

const fallbackCache: { value: boolean | null; at: number } = { value: null, at: 0 };

/**
 * Fallback is off unless QUEUE_FALLBACK_ENABLED=1 or WorkerControl
 * queue.fallback.enabled=1. Explicit env 0 wins (emergency disable).
 */
export async function getQueueFallbackEnabled(opts?: {
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = opts?.env ?? process.env;
  const raw = (env.QUEUE_FALLBACK_ENABLED ?? '').trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  const now = opts?.now ?? Date.now();
  if (fallbackCache.value !== null && now - fallbackCache.at < CONTROL_CACHE_MS) {
    return fallbackCache.value;
  }
  try {
    const row = await db.workerControl.findUnique({ where: { key: QUEUE_FALLBACK_CONTROL_KEY } });
    const value = (row?.value ?? '').trim() === '1';
    fallbackCache.value = value;
    fallbackCache.at = now;
    return value;
  } catch {
    return fallbackCache.value ?? false;
  }
}

export function resetFallbackCacheForTests(): void {
  fallbackCache.value = null;
  fallbackCache.at = 0;
}

/** WorkerControl key for one kind's transport. */
export function queueTransportKey(kind: string): string {
  return `queue.transport.${kind}`;
}

/** Static default / emergency override. Anything but 'pg' means D1. */
export function defaultQueueTransport(env = process.env): QueueTransport {
  return (env.QUEUE_BACKEND ?? '').trim().toLowerCase() === 'pg' ? 'pg' : 'd1';
}

/** True when the emergency override forces every kind back to D1. */
export function isEmergencyD1Override(env = process.env): boolean {
  return (env.QUEUE_BACKEND ?? '').trim().toLowerCase() === 'd1' && (env.QUEUE_BACKEND ?? '') !== '';
}

const transportCache = new Map<string, { value: QueueTransport | null; at: number }>();

async function readTransportControl(kind: string, now: number): Promise<QueueTransport | null> {
  const key = queueTransportKey(kind);
  const hit = transportCache.get(key);
  if (hit && now - hit.at < CONTROL_CACHE_MS) return hit.value;
  try {
    const row = await db.workerControl.findUnique({ where: { key } });
    const v = (row?.value ?? '').trim().toLowerCase();
    const value: QueueTransport | null = v === 'd1' || v === 'pg' ? v : null;
    transportCache.set(key, { value, at: now });
    return value;
  } catch {
    return hit?.value ?? null;
  }
}

/**
 * Resolve which transport owns a kind right now.
 * Unknown kinds resolve to the default (callers still validate kinds).
 */
export async function getQueueTransport(
  kind: string,
  opts?: { now?: number; env?: NodeJS.ProcessEnv },
): Promise<QueueTransport> {
  const env = opts?.env ?? process.env;
  if (isEmergencyD1Override(env)) {
    // Emergency rollback: QUEUE_BACKEND=d1 forces D1 for every kind
    // regardless of per-kind rows. Unset QUEUE_BACKEND is NOT an override —
    // defaultQueueTransport already resolves that to 'd1' below.
    return 'd1';
  }
  const now = opts?.now ?? Date.now();
  const control = await readTransportControl(kind, now);
  if (control) return control;
  return defaultQueueTransport(env);
}

/** True when PG owns this kind (producer publishes to queue-api, PG workers claim). */
export async function isPgTransport(
  kind: string,
  opts?: { now?: number; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  return (await getQueueTransport(kind, opts)) === 'pg';
}

/** True when the kind is a known queue kind (same vocabulary as QUEUE_KINDS). */
export function isKnownQueueKind(kind: string): kind is QueueJobKind {
  return (QUEUE_KINDS as readonly string[]).includes(kind);
}

/** Split a kind list into D1-owned vs PG-owned. Order preserved. */
export async function partitionKindsByTransport(
  kinds: readonly string[],
  opts?: { now?: number; env?: NodeJS.ProcessEnv },
): Promise<{ d1: string[]; pg: string[] }> {
  const d1: string[] = [];
  const pg: string[] = [];
  for (const kind of kinds) {
    if (await isPgTransport(kind, opts)) pg.push(kind);
    else d1.push(kind);
  }
  return { d1, pg };
}

/** Test seam — clear the transport read cache. */
export function resetTransportCacheForTests(): void {
  transportCache.clear();
  resetFallbackCacheForTests();
}
