// ---------------------------------------------------------------------------
// QueuePublisher — single choke point around every enqueue call site
// (SLA-10 rev 4 Phase 2, SLA-16).
//
// Contract:
// - Business validation is unchanged: callers (lib/jobs.ts enqueue*Job)
//   validate exactly as today. The publisher only enforces the kind/target
//   invariant guard (validateJobTargets) and never loosens it.
// - One stable opId + pre-auth credit amount, minted by the caller BEFORE
//   transport selection, is passed through verbatim to whichever transport
//   wins. The publisher never mints a replacement billing identity.
// - Transport is resolved per kind via getQueueTransport (WorkerControl
//   queue.transport.<kind>, QUEUE_BACKEND default/emergency override).
// - D1 writes always carry the explicit queueOwner marker: 'd1' for
//   legacy-owned rows, 'pg' for the compatibility projection of a PG-owned
//   job, 'fallback_d1' for rows awaiting one-way reconciliation.
// - Fallback + reconciler are OFF by default. During the first producer
//   canary the publisher throws a retryable error on PG failure instead of
//   writing an unowned dual-queue row (plan §Producer fallback).
//
// The PG transport speaks the queue-api EnqueueBody shape (see producer.ts
// for the signed HTTP client, api.ts for the server side). All persistence
// is injected so this module is unit-testable without a DB.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import {
  dedupeKeyFor,
  fallbackDedupeKey,
  validateJobTargets,
} from './contract.js';
import { getQueueTransport, QUEUE_FALLBACK_STATUS, type QueueTransport } from './transport.js';

export type PublishTransport = QueueTransport | 'fallback_d1';

export interface PublishRequest {
  kind: string;
  workspaceId: string;
  videoId: string | null;
  sourceId: string | null;
  /** Verbatim payload (object or pre-serialized JSON). */
  payload: unknown;
  /** Stable billing identity minted by the caller — never re-minted here. */
  opId: string | null;
  preAuthCredits: number | null;
  deadlineAt?: Date | null;
  /** Caller-supplied dedupe key (fallback reconciliation passes d1:<id>). */
  dedupeKey?: string | null;
  analysisId?: string | null;
  /** Pre-allocated D1 projection id (wired by lib/jobs.ts; else minted). */
  d1Id?: string | null;
}

export interface PublishedJobRef {
  /** D1 row id (legacy row or compatibility projection). */
  d1JobId: string;
  /** PG job id when the PG transport accepted the publish. */
  pgJobId: string | null;
  transport: PublishTransport;
  /** True when the PG dedupe key already existed — no new work was created. */
  deduped: boolean;
}

/** D1 persistence supplied by lib/jobs.ts (or an in-memory fake in tests). */
export interface PublisherD1 {
  createOwnedJob(input: {
    /** Pre-allocated id for the PG projection link (else generated). */
    id?: string;
    kind: string;
    workspaceId: string;
    videoId: string | null;
    sourceId: string | null;
    payloadJson: string;
    opId: string | null;
    preAuthCredits: number | null;
    deadlineAt: Date | null;
    analysisId: string | null;
    queueOwner: 'd1' | 'pg' | 'fallback_d1';
    /** Defaults to 'queued'; fallback rows use 'queued_remote'. */
    status?: string;
  }): Promise<{ id: string }>;
  /**
   * Promote an existing D1 row to the PG projection (queueOwner='pg',
   * status='queued'). Used by fallback reconciliation. Fresh PG publishes
   * insert that projection directly and do not call this.
   */
  markD1ProjectionPg(d1JobId: string, pgJobId: string): Promise<void>;
}

/** PG publish — the queue-api EnqueueBody shape (producer.ts posts it). */
export interface PublisherPg {
  publish(
    input: {
      kind: string;
      workspaceId: string;
      videoId: string | null;
      sourceId: string | null;
      dedupeKey: string;
      deadlineAt: string | null;
      payload: Record<string, unknown>;
      credits: { opId: string; preAuthCredits: number } | null;
      d1JobId: string | null;
    },
    /** Per-call override; absent means the transport's default. */
    opts?: { rateLimitWaitBudgetMs?: number },
  ): Promise<{ pgJobId: string; deduped: boolean }>;
}

export interface PublisherDeps {
  d1: PublisherD1;
  /** Absent until a kind is cut over — PG transport then throws retryable. */
  pg?: PublisherPg;
  resolveTransport?: (kind: string) => Promise<QueueTransport>;
  /** Default false: PG failure throws retryable instead of fallback rows. */
  fallbackEnabled?: boolean;
  /** Runtime lookup (WorkerControl queue.fallback.enabled) when the boolean is unset. */
  resolveFallbackEnabled?: () => Promise<boolean>;
}

export class QueuePublishError extends Error {
  readonly code: 'invalid_target' | 'pg_unavailable' | 'pg_failed';
  readonly retryable: boolean;
  /**
   * The underlying transport code, verbatim (SLA-349). `pg_failed` alone
   * cannot tell a caller whether the publish was refused by the limiter or
   * actually failed — the two want opposite handling: wait, versus park and
   * retry later. `rate_limited` is the one callers branch on.
   */
  readonly producerCode: string | null;
  /** Seconds queue-api asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;
  constructor(
    code: QueuePublishError['code'],
    message: string,
    retryable: boolean,
    opts?: { producerCode?: string | null; retryAfterSeconds?: number | null; cause?: unknown },
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.producerCode = opts?.producerCode ?? null;
    this.retryAfterSeconds = opts?.retryAfterSeconds ?? null;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

function toPayloadJson(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
}

/** Coerce to the API's record shape (the server's Zod requires an object). */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  if (payload != null && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload || '{}');
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to {} — a corrupt payload must not 422 a paid job into
      // a retry loop; the worker reports the shape problem instead.
    }
  }
  return {};
}

/**
 * Derive the required PG dedupe key. `discover` has no natural target key:
 * bind it to the stable opId when present (same logical probe dedupes),
 * else a fresh run id (never collide two unrelated probes — the server
 * treats '' as one shared key, which would wrongly dedupe).
 */
export function deriveDedupeKey(req: {
  kind: string;
  videoId: string | null;
  sourceId: string | null;
  opId: string | null;
  dedupeKey?: string | null;
}): string {
  if (req.dedupeKey) return req.dedupeKey;
  if (req.kind === 'discover') {
    return req.opId ? `discover:op:${req.opId}` : `discover:run:${randomUUID()}`;
  }
  return dedupeKeyFor(req.kind, req.videoId, req.sourceId);
}

export class QueuePublisher {
  private readonly deps: PublisherDeps;
  constructor(deps: PublisherDeps) {
    this.deps = deps;
  }

  private resolveTransport(kind: string): Promise<QueueTransport> {
    return this.deps.resolveTransport
      ? this.deps.resolveTransport(kind)
      : getQueueTransport(kind);
  }

  async publish(req: PublishRequest): Promise<PublishedJobRef> {
    const targetError = validateJobTargets(req.kind, req.videoId, req.sourceId);
    if (targetError) throw new QueuePublishError('invalid_target', targetError, false);

    const transport = await this.resolveTransport(req.kind);
    const payloadJson = toPayloadJson(req.payload);
    const deadlineAt = req.deadlineAt ?? null;

    if (transport === 'd1') {
      const row = await this.deps.d1.createOwnedJob({
        id: req.d1Id ?? undefined,
        kind: req.kind,
        workspaceId: req.workspaceId,
        videoId: req.videoId,
        sourceId: req.sourceId,
        payloadJson,
        opId: req.opId,
        preAuthCredits: req.preAuthCredits,
        deadlineAt,
        analysisId: req.analysisId ?? null,
        queueOwner: 'd1',
        status: 'queued',
      });
      return { d1JobId: row.id, pgJobId: null, transport: 'd1', deduped: false };
    }

    // -- PG transport -------------------------------------------------------
    if (!this.deps.pg) {
      throw new QueuePublishError(
        'pg_unavailable',
        `PG transport selected for kind "${req.kind}" but no PG publisher is configured`,
        true,
      );
    }
    // Pre-allocate the D1 projection id BEFORE the POST so the PG row can
    // carry it as d1_job_id — the two rows share one id, 1:1, no second key.
    const d1Id = req.d1Id ?? randomUUID();
    try {
      const accepted = await this.deps.pg.publish({
        kind: req.kind,
        workspaceId: req.workspaceId,
        videoId: req.videoId,
        sourceId: req.sourceId,
        dedupeKey: deriveDedupeKey(req),
        deadlineAt: deadlineAt ? deadlineAt.toISOString() : null,
        payload: toPayloadRecord(req.payload),
        credits:
          req.opId != null ? { opId: req.opId, preAuthCredits: req.preAuthCredits ?? 0 } : null,
        d1JobId: d1Id,
      });
      if (accepted.deduped) {
        // Existing PG row (shared id). Do not insert a second D1 projection.
        return {
          d1JobId: accepted.pgJobId,
          pgJobId: accepted.pgJobId,
          transport: 'pg',
          deduped: true,
        };
      }
      // D1 compatibility projection: one INSERT, already queueOwner='pg' and
      // status='queued'. A follow-up UPDATE would rewrite the same columns
      // (markD1ProjectionPg stores no extra PG id — the rows share `id`).
      // That second write stays on the fallback reconciler, which promotes
      // an existing fallback_d1 / queued_remote row.
      const projection = await this.deps.d1.createOwnedJob({
        id: d1Id,
        kind: req.kind,
        workspaceId: req.workspaceId,
        videoId: req.videoId,
        sourceId: req.sourceId,
        payloadJson,
        opId: req.opId,
        preAuthCredits: req.preAuthCredits,
        deadlineAt,
        analysisId: req.analysisId ?? null,
        queueOwner: 'pg',
        status: 'queued',
      });
      return {
        d1JobId: projection.id,
        pgJobId: accepted.pgJobId,
        transport: 'pg',
        deduped: accepted.deduped,
      };
    } catch (err) {
      const fallbackOn = this.deps.fallbackEnabled
        ?? (this.deps.resolveFallbackEnabled ? await this.deps.resolveFallbackEnabled() : false);
      if (!fallbackOn) {
        // Carry the transport's own code through. A rate limit that reached
        // here exhausted its per-publish wait budget (producer.ts), and a
        // caller that has to choose between "come back later" and "this is
        // broken" cannot do that from `pg_failed` plus a message string.
        // producerCode wins over code: a PG transport that already wrapped its
        // failure keeps the transport code, whereas `code` would read as this
        // wrapper's own pg_failed.
        const src = err as { code?: unknown; producerCode?: unknown; retryAfterSeconds?: unknown };
        const producerCode =
          typeof src?.producerCode === 'string' ? src.producerCode
          : typeof src?.code === 'string' ? src.code
          : null;
        const retryAfterSeconds =
          typeof src?.retryAfterSeconds === 'number' && Number.isFinite(src.retryAfterSeconds)
            ? src.retryAfterSeconds
            : null;
        throw new QueuePublishError(
          'pg_failed',
          `PG publish failed for kind "${req.kind}": ${(err as Error).message}`,
          true,
          { producerCode, retryAfterSeconds, cause: err },
        );
      }
      // Fallback row: same opId/credits/payload, queueOwner='fallback_d1',
      // status queued_remote (non-claimable). Reconciler republishes with
      // dedupeKey d1:<MediaJob.id> — never a second billing operation.
      const row = await this.deps.d1.createOwnedJob({
        kind: req.kind,
        workspaceId: req.workspaceId,
        videoId: req.videoId,
        sourceId: req.sourceId,
        payloadJson,
        opId: req.opId,
        preAuthCredits: req.preAuthCredits,
        deadlineAt,
        analysisId: req.analysisId ?? null,
        queueOwner: 'fallback_d1',
        status: QUEUE_FALLBACK_STATUS,
      });
      // Parked, not published — and until this line the park was completely
      // silent. The row is invisible to every claimer (D1 claims skip
      // queueOwner != 'd1', PG has no row), so "scraper claimed zero while the
      // sweep kept queueing" was the whole operator-visible story. The
      // reconciler is the only way out, so say so here, once, with the cause.
      console.warn(
        `[queue] parked kind=${req.kind} d1=${row.id} as fallback_d1/${QUEUE_FALLBACK_STATUS}`
        + ` — PG publish failed (${(err as Error).message}); invisible to claims until reconcileFallbackJobs republishes it`,
      );
      return { d1JobId: row.id, pgJobId: null, transport: 'fallback_d1', deduped: false };
    }
  }

  /**
   * One-way fallback reconciliation for a single fallback_d1 row.
   * Publishes to PG with dedupeKey = d1:<MediaJob.id> and the ORIGINAL opId;
   * on dedupe match adopts the existing PG job (no second billing operation).
   * After acceptance the D1 row becomes queueOwner='pg', status 'queued',
   * retaining the same D1 id (linked via PG d1_job_id by the caller).
   *
   * rateLimitWaitBudgetMs 0 on purpose (SLA-349): a fresh publish waits out
   * `retry-after`, but the reconciler must NOT. It stops its sweep at the
   * first 429 by design (jobs.ts reconcileFallbackJobs) and runs again on the
   * WORKER_RECLAIM_INTERVAL_MS cadence, so the window is already being waited
   * out once — sleeping inside the sweep would only push the rest of the batch
   * a minute later for every row that is not rate limited at all.
   */
  async reconcileFallbackRow(row: {
    id: string;
    kind: string;
    workspaceId: string;
    videoId: string | null;
    sourceId: string | null;
    payloadJson: string;
    opId: string | null;
    preAuthCredits: number | null;
    deadlineAt: Date | null;
    analysisId?: string | null;
  }): Promise<PublishedJobRef> {
    if (!this.deps.pg) {
      throw new QueuePublishError('pg_unavailable', 'reconciliation needs a PG publisher', true);
    }
    const accepted = await this.deps.pg.publish(
      {
        kind: row.kind,
        workspaceId: row.workspaceId,
        videoId: row.videoId,
        sourceId: row.sourceId,
        dedupeKey: fallbackDedupeKey(row.id),
        deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString() : null,
        payload: toPayloadRecord(row.payloadJson),
        credits:
          row.opId != null ? { opId: row.opId, preAuthCredits: row.preAuthCredits ?? 0 } : null,
        d1JobId: row.id,
      },
      { rateLimitWaitBudgetMs: 0 },
    );
    await this.deps.d1.markD1ProjectionPg(row.id, accepted.pgJobId);
    return { d1JobId: row.id, pgJobId: accepted.pgJobId, transport: 'pg', deduped: accepted.deduped };
  }
}
