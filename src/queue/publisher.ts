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
// All persistence is injected so this module is unit-testable without a DB.
// lib/jobs.ts supplies the real D1 closures; the queue-api client supplies
// the real PG closure when a kind is cut over (no prod kind is PG yet).
// ---------------------------------------------------------------------------

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
}

export interface PublishedJobRef {
  /** D1 row id (legacy row or compatibility projection). */
  d1JobId: string;
  /** PG job id when the PG transport accepted the publish. */
  pgJobId: string | null;
  transport: PublishTransport;
  /** True when the PG dedupe key already existed — no new work created. */
  deduped: boolean;
}

/** D1 persistence supplied by lib/jobs.ts (or an in-memory fake in tests). */
export interface PublisherD1 {
  createOwnedJob(input: {
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
  /** Point the D1 projection at an accepted PG job (queueOwner='pg'). */
  markD1ProjectionPg(d1JobId: string, pgJobId: string): Promise<void>;
}

/** PG publish supplied by the queue-api client (or a fake in tests). */
export interface PublisherPg {
  publish(input: {
    kind: string;
    workspaceId: string;
    videoId: string | null;
    sourceId: string | null;
    dedupeKey: string;
    payload: unknown;
    opId: string | null;
    preAuthCredits: number | null;
    deadlineAt: Date | null;
    analysisId: string | null;
    d1JobId: string | null;
  }): Promise<{ pgJobId: string; deduped: boolean }>;
}

export interface PublisherDeps {
  d1: PublisherD1;
  /** Absent until a kind is cut over — PG transport then throws retryable. */
  pg?: PublisherPg;
  resolveTransport?: (kind: string) => Promise<QueueTransport>;
  /** Default false: PG failure throws retryable instead of fallback rows. */
  fallbackEnabled?: boolean;
  /** Stable D1 id pre-allocated for the fallback row (uuid in prod). */
  mintD1Id?: () => string;
}

export class QueuePublishError extends Error {
  readonly code: 'invalid_target' | 'pg_unavailable' | 'pg_failed';
  readonly retryable: boolean;
  constructor(code: QueuePublishError['code'], message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function toPayloadJson(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
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
    const dedupeKey =
      req.dedupeKey ?? (req.kind === 'discover' ? null : dedupeKeyFor(req.kind, req.videoId, req.sourceId));
    if (!this.deps.pg || !dedupeKey) {
      throw new QueuePublishError(
        'pg_unavailable',
        `PG transport selected for kind "${req.kind}" but no PG publisher is configured`,
        true,
      );
    }
    try {
      const accepted = await this.deps.pg.publish({
        kind: req.kind,
        workspaceId: req.workspaceId,
        videoId: req.videoId,
        sourceId: req.sourceId,
        dedupeKey,
        payload: req.payload,
        opId: req.opId,
        preAuthCredits: req.preAuthCredits,
        deadlineAt,
        analysisId: req.analysisId ?? null,
        d1JobId: null,
      });
      // D1 compatibility projection: same opId/credits, queueOwner='pg'.
      // UI readers keep working; legacy D1 claims ignore the row.
      const projection = await this.deps.d1.createOwnedJob({
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
      await this.deps.d1.markD1ProjectionPg(projection.id, accepted.pgJobId);
      return {
        d1JobId: projection.id,
        pgJobId: accepted.pgJobId,
        transport: 'pg',
        deduped: accepted.deduped,
      };
    } catch (err) {
      if (!this.deps.fallbackEnabled) {
        throw new QueuePublishError(
          'pg_failed',
          `PG publish failed for kind "${req.kind}": ${(err as Error).message}`,
          true,
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
      return { d1JobId: row.id, pgJobId: null, transport: 'fallback_d1', deduped: false };
    }
  }

  /**
   * One-way fallback reconciliation for a single fallback_d1 row.
   * Publishes to PG with dedupeKey = d1:<MediaJob.id> and the ORIGINAL opId;
   * on dedupe match adopts the existing PG job (no second billing operation).
   * After acceptance the D1 row becomes queueOwner='pg', status 'queued',
   * retaining the same D1 id (linked via PG d1_job_id by the caller).
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
    const accepted = await this.deps.pg.publish({
      kind: row.kind,
      workspaceId: row.workspaceId,
      videoId: row.videoId,
      sourceId: row.sourceId,
      dedupeKey: fallbackDedupeKey(row.id),
      payload: row.payloadJson,
      opId: row.opId,
      preAuthCredits: row.preAuthCredits,
      deadlineAt: row.deadlineAt,
      analysisId: row.analysisId ?? null,
      d1JobId: row.id,
    });
    await this.deps.d1.markD1ProjectionPg(row.id, accepted.pgJobId);
    return { d1JobId: row.id, pgJobId: accepted.pgJobId, transport: 'pg', deduped: accepted.deduped };
  }
}
