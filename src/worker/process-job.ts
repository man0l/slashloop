// ---------------------------------------------------------------------------
// processClaimedJob — the per-job processing switch, shared by every worker.
//
// This is the queue-drain logic that used to live inline inside
// api/jobs/analyze.ts (the Vercel HTTP worker). Extracted so a long-running
// VPS/Bun worker (src/worker/index.ts) can call the exact same code with NO
// time budget, while the Vercel worker keeps its 45s-invocation reserve. The
// retry/refund policy stays in exactly one place here.
//
// Contract: the caller has already CLAIMED the job (status running, attempts+1).
// This function either completes it, fails it (requeue or terminal), or — for
// a refresh job that can't fit the caller's remaining budget, or whose
// canonical query is already being scraped by another container — returns
// `{ ok: false, requeued: true }` so the caller can stop claiming.
//
// A refresh job may take OTHER queued refresh jobs with it: peers tracking the
// same canonical query share one Apify run and are completed/failed here too.
// ---------------------------------------------------------------------------

import { analyzeVideoWithDownload } from '../analysis/index.js';
import {
  claimNextJob, completeJob, failJob, yieldJob, enqueueAnalyzeJob,
  parseRefreshJobPayload, isSoloRefreshPayload,
  type MediaJobRow, type AnalyzeJobPayload, type FetchJobPayload, type ThumbJobPayload,
} from '../lib/jobs.js';
import { ingestThumbnails, type ThumbIngestTarget } from '../lib/media.js';
import { CREDIT_COSTS, refundCredits } from '../lib/credits.js';
import { tagJobFailure } from '../lib/gemini-errors.js';
import { failureLines } from '../lib/refresh-notes.js';
import { db } from '../db.js';

export interface JobProcessOptions {
  /**
   * If set, a refresh job is only started when it can finish before this
   * wall-clock deadline (ms epoch). The Vercel worker passes its invocation
   * deadline; the VPS loop omits it, so refresh always runs there.
   */
  deadlineMs?: number;
  /** Minimum budget a refresh job needs before it is worth starting. */
  refreshRequiresMs?: number;
}

export interface JobProcessResult {
  ok: boolean;
  error?: string;
  /** True when the job was left queued because the caller ran out of budget. */
  requeued?: boolean;
}

const DEFAULT_REFRESH_REQUIRES_MS = 30_000;

/**
 * Budget reserved per extra batch member for fan-out (persist + score +
 * thumbnail ingest for that source). A time-boxed caller (Vercel, 45s reserve)
 * uses it to decide how many peers it can honestly serve; taking ten peers
 * with 30s left is how a batch gets killed halfway and leaves paid-for work
 * stuck in `running`.
 */
const REFRESH_FANOUT_MS_PER_PEER = 4_000;

export async function processClaimedJob(
  job: MediaJobRow,
  opts?: JobProcessOptions,
): Promise<JobProcessResult> {
  // rescore jobs: recompute scores for every source holding a creator's videos.
  // Split out of runRefresh because it was the step that kept dying — it ran
  // with ~11s of budget left after a 48s scrape. No Apify, no credits, so a
  // retry is free.
  if (job.kind === 'rescore') {
    try {
      const { creatorHandle } = JSON.parse(job.payloadJson || '{}') as { creatorHandle?: string };
      const { batchScoreVideos } = await import('../scoring.js');

      if (creatorHandle) {
        // Creator-scoped: every source holding their videos.
        const rows = await db.video.findMany({
          where: { creatorHandle, source: { workspaceId: job.workspaceId } },
          select: { sourceId: true },
          distinct: ['sourceId'],
        });
        for (const r of rows) await batchScoreVideos(r.sourceId);
      } else {
        // Source-scoped: one source only. This is how a whole-workspace rescore
        // is split — one job per source — so no single invocation has to score
        // every video in the workspace. Doing that inline timed out at ~450
        // videos and applied only partially.
        if (!job.sourceId) throw new Error('rescore job has neither creatorHandle nor sourceId');
        await batchScoreVideos(job.sourceId);
      }
      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);
      console.warn(`[worker] rescore job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // refresh jobs: scrape + persist + score a whole SOURCE, for this job and
  // for every peer job that wants the same canonical query. Credits are
  // pre-authorised at enqueue and settled per workspace inside
  // runBatchedRefresh; refunds are issued HERE, and only when the job has
  // terminally failed, so a requeued attempt stays paid for (G4).
  if (job.kind === 'refresh') {
    if (!job.sourceId) {
      await failJob(job.id, 'refresh job has no sourceId');
      return { ok: false, error: 'no sourceId' };
    }
    // Do not start a scrape that cannot finish. Unlike analyze, this call is
    // opaque and uninterruptible: begun with too little budget it is killed
    // mid-flight, which is the exact half-completion this queue exists to
    // prevent. Leave it queued for the next drain instead.
    const requires = opts?.refreshRequiresMs ?? DEFAULT_REFRESH_REQUIRES_MS;
    if (opts?.deadlineMs && Date.now() + requires > opts.deadlineMs) {
      // Same reasoning as the lease yield below: the job was never started, so
      // it must not spend an attempt. A busy Vercel drain could otherwise
      // terminally fail a refresh it simply never had room for.
      await yieldJob(job.id, 'insufficient budget remaining; requeued for next drain');
      return { ok: false, error: 'insufficient budget remaining; requeued for next drain', requeued: true };
    }

    // Creator-override / baseline top-up jobs (too_fresh follow-up) scrape a
    // different query than the source row. They cannot join a tenant batch —
    // that would re-scrape the hashtag. runRefresh routes these to the solo
    // path; the refresh worker still owns the scrape so proxy/Apify matches
    // every other refresh.
    const refreshPayload = parseRefreshJobPayload(job.payloadJson);
    if (isSoloRefreshPayload(refreshPayload)) {
      const { runRefresh } = await import('../lib/refresh.js');
      try {
        const result = await runRefresh({
          workspaceId: job.workspaceId,
          sourceId: job.sourceId,
          limitOverride: refreshPayload.limitOverride,
          sourceTypeOverride: refreshPayload.sourceTypeOverride,
          queryOverride: refreshPayload.queryOverride,
          opId: job.opId ?? undefined,
          preAuthCredits: job.preAuthCredits ?? undefined,
          deferRefund: true,
        });
        if (!result.ok) {
          const message = failureLines(result.errors).join('; ') || result.refusal || 'refresh refused';
          const { terminal } = await failJob(job.id, message);
          if (terminal && result.pendingRefundCredits && job.opId) {
            await refundCredits(
              job.workspaceId, result.pendingRefundCredits, 'refresh_source',
              `${job.opId}:fail`, 'call_failed',
            ).catch(e => console.warn(`[worker] refund failed for ${job.id}: ${(e as Error).message}`));
          }
          console.warn(`[worker] refresh job ${job.id} refused (terminal=${terminal}): ${message}`);
          return { ok: false, error: message };
        }
        await completeJob(job.id, null);
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message;
        const landed = job.startedAt
          ? await db.video.findFirst({
              where: { sourceId: job.sourceId!, scrapedAt: { gt: job.startedAt } },
              select: { id: true },
            })
          : null;
        if (landed) {
          await completeJob(job.id, null);
          console.warn(`[worker] refresh job ${job.id} errored after its videos landed — completing, not retrying`);
          return { ok: true };
        }
        const { terminal } = await failJob(job.id, message);
        console.warn(`[worker] refresh job ${job.id} failed (terminal=${terminal}): ${message}`);
        return { ok: false, error: message };
      }
    }

    // Phase A multi-tenant batching: claim other queued refreshes of the SAME
    // canonical (platform, sourceType, normalized query) so N workspaces
    // tracking @foo share one Apify run. Credits still settle per workspace
    // inside runBatchedRefresh. See docs/apify-multi-tenant-batching-plan.md.
    const {
      claimRefreshPeersForCanonical, refreshBatchingEnabled, refreshBatchPeerCap,
      acquireCanonicalLock, releaseCanonicalLock,
      readScrapeReceipt, recordScrapeReceipt,
    } = await import('../lib/jobs.js');
    const { normalizeQuery, canonicalKey } = await import('../lib/canonical-query.js');
    const { runBatchedRefresh } = await import('../lib/refresh.js');

    const leaderSource = await db.source.findFirst({
      where: { id: job.sourceId },
      select: { platform: true, sourceType: true, query: true },
    });
    const key = leaderSource
      ? canonicalKey(leaderSource.platform, leaderSource.sourceType, leaderSource.query)
      : null;

    // One Apify run per canonical query across ALL worker containers. Without
    // this, two `WORKER_KINDS=refresh` containers can lead batches for the same
    // query simultaneously — two scrapes, which is the spend batching exists to
    // remove. The loser requeues; by the time it retries, the winner's results
    // are in the DB and its own refresh is either already applied (it was a
    // peer) or now an incremental no-op.
    const lockOwner = `${process.env.HOSTNAME ?? 'worker'}:${job.id}`;
    if (key && !(await acquireCanonicalLock(key, lockOwner))) {
      // yieldJob, not failJob: attempts increment at claim, so failing here
      // would spend one of three lives on another container's contention
      // without this job having attempted anything.
      await yieldJob(job.id, `another worker is scraping ${key}; requeued without spending an attempt`);
      return { ok: false, error: 'canonical scrape already in progress', requeued: true };
    }

    let batchJobs: MediaJobRow[] = [job];
    try {
      // Fan-out (persist + score + thumbs per source) costs budget too, so a
      // time-boxed caller takes fewer peers than an unbounded VPS worker.
      const configuredCap = refreshBatchingEnabled() ? refreshBatchPeerCap() : 0;
      const peerCap = opts?.deadlineMs
        ? Math.max(0, Math.min(
            configuredCap,
            Math.floor((opts.deadlineMs - Date.now() - requires) / REFRESH_FANOUT_MS_PER_PEER),
          ))
        : configuredCap;

      const peers = leaderSource && peerCap > 0
        ? await claimRefreshPeersForCanonical({
            excludeJobId: job.id,
            platform: leaderSource.platform,
            sourceType: leaderSource.sourceType,
            queryNorm: normalizeQuery(leaderSource.sourceType, leaderSource.query),
            limit: peerCap,
          })
        : [];

      batchJobs = [job, ...peers];

      const parseLimit = (payloadJson: string | null | undefined) =>
        parseRefreshJobPayload(payloadJson).limitOverride;

      // Did a previous attempt at THIS job already pay for a scrape? If so,
      // re-read that dataset instead of buying it again. This is the retry
      // path that was quietly costing ~27% of the Apify bill.
      const receipt = key ? readScrapeReceipt(job.payloadJson, key) : undefined;
      if (receipt) {
        console.log(
          `[worker] resuming dataset ${receipt.datasetId} for ${key} `
          + `(attempt ${job.attempts}) — no new Apify run`,
        );
      }

      const results = await runBatchedRefresh(
        batchJobs.map((j) => ({
          workspaceId: j.workspaceId,
          sourceId: j.sourceId!,
          jobId: j.id,
          // Stable across every retry of this job (minted once at enqueue) —
          // see the opId doc comment in src/lib/refresh.ts.
          opId: j.opId ?? undefined,
          preAuthCredits: j.preAuthCredits ?? undefined,
          limitOverride: parseLimit(j.payloadJson),
        })),
        {
          // The queue owns retries, so the queue owns the refund: a pre-auth
          // is only returned once the job gives up for good (G4).
          deferRefund: true,
          resumeDatasetId: receipt?.datasetId,
          // Fires as soon as Apify has been paid, before any persisting, so a
          // worker killed during fan-out still leaves a resumable receipt on
          // every member of the batch.
          onScrapePaid: async ({ datasetId, canonicalKey }) => {
            await recordScrapeReceipt(
              batchJobs.map(j => j.id),
              { datasetId, canonicalKey, at: Date.now() },
            );
          },
        },
      );

      // sourceId is unique globally — safe map key for pairing results back.
      const resultBySource = new Map<string, (typeof results)[number]>();
      for (const r of results) resultBySource.set(r.sourceId, r);

      // Telemetry that survives log aggregation: one line per batch with the
      // numbers §10's savings ratio is computed from.
      const leaderResultForLog = resultBySource.get(job.sourceId);
      console.log(
        `[worker] refresh batch canonical=${key ?? 'unknown'} size=${batchJobs.length} `
        + `apifyCents=${leaderResultForLog?.costCents ?? 0} `
        + `items=${leaderResultForLog?.itemsPulled ?? 0} `
        + `subscribers=${results.map(r => `${r.sourceId.slice(0, 8)}:${r.newVideos}new/${r.creditsCharged}cr`).join(',')}`,
      );

      let leaderResult: JobProcessResult = { ok: true };
      for (const j of batchJobs) {
        const result = resultBySource.get(j.sourceId!);
        // Per-subscriber settlement. One member failing (no credits, bad
        // source, persist error) must not fail members whose videos were
        // already written and billed — retrying those would re-apply a scrape
        // that already landed.
        if (!result || !result.ok) {
          const message = result
            ? (failureLines(result.errors).join('; ') || result.refusal || 'refresh refused')
            : 'no result from batch';
          const { terminal } = await failJob(j.id, message);
          if (terminal && result?.pendingRefundCredits && j.opId) {
            await refundCredits(
              j.workspaceId, result.pendingRefundCredits, 'refresh_source',
              `${j.opId}:fail`, 'call_failed',
            ).catch(e => console.warn(`[worker] refund failed for ${j.id}: ${(e as Error).message}`));
          }
          console.warn(`[worker] refresh job ${j.id} refused (terminal=${terminal}): ${message}`);
          if (j.id === job.id) leaderResult = { ok: false, error: message };
          continue;
        }
        await completeJob(j.id, null);
      }
      return leaderResult;
    } catch (err) {
      // Only jobs with nothing persisted may be requeued. A member whose videos
      // already landed is completed instead — Video.scrapedAt is the same
      // evidence reclaimStuckJobs uses to refuse a re-scrape.
      const message = (err as Error).message;
      for (const j of batchJobs) {
        const landed = j.startedAt
          ? await db.video.findFirst({
              where: { sourceId: j.sourceId!, scrapedAt: { gt: j.startedAt } },
              select: { id: true },
            })
          : null;
        if (landed) {
          await completeJob(j.id, null);
          console.warn(`[worker] refresh job ${j.id} errored after its videos landed — completing, not retrying`);
          continue;
        }
        const { terminal } = await failJob(j.id, message);
        console.warn(`[worker] refresh job ${j.id} failed (terminal=${terminal}): ${message}`);
      }
      return { ok: false, error: message };
    } finally {
      if (key) await releaseCanonicalLock(key, lockOwner);
    }
  }

  // Everything below is video-scoped. videoId is nullable on the row now that
  // source-scoped kinds share the table, so narrow it once here rather than
  // asserting at each use.
  const videoId = job.videoId;
  if (!videoId) {
    await failJob(job.id, `${job.kind} job has no videoId`);
    return { ok: false, error: 'no videoId' };
  }

  // fetch jobs: download + store the MP4 only, no Gemini. Cost is Apify spend
  // (asserted inside downloadTikTokVideo), not AI credits, so these rows carry
  // no opId and reclaimStuckJobs never tries to refund them — unless the fetch
  // was enqueued as part of an analysis pipeline, in which case the payload
  // carries an opId for credit refund on failure, and an enqueueAnalysis block
  // to chain an analyze job after successful store.
  if (job.kind === 'fetch') {
    try {
      const v = await db.video.findUnique({ where: { id: videoId }, select: { url: true, platform: true } });
      if (!v || v.platform !== 'tiktok' || !v.url) throw new Error('no downloadable TikTok URL');
      const { downloadAndStoreVideo } = await import('../lib/media.js');
      // Throws (and marks the video mediaStatus='failed') on any failure with
      // the REAL Apify reason — that message becomes this job's lastError,
      // which the gallery's ⛔ fetch-error surface maps to a specific issue
      // (spend cap, actor, CDN, deleted video...).
      await downloadAndStoreVideo(job.workspaceId, videoId, v.url);

      // If this fetch was a precursor to analysis, enqueue the analyze job now
      // that the video is stored. The analyze job will use the stored MP4 (URL
      // mode for openrouter-video, or Phase 2.1 cache) instead of downloading
      // from Apify again.
      const fPayload = JSON.parse(job.payloadJson || '{}') as FetchJobPayload;
      if (fPayload.enqueueAnalysis && job.opId) {
        // The fetch job's payload came from the API, so the backend string is
        // only trusted if it matches a real analyzer — narrow before handing
        // it to enqueueAnalyzeJob, whose payload type is the closed union.
        const fb = fPayload.enqueueAnalysis.forceBackend;
        await enqueueAnalyzeJob({
          workspaceId: job.workspaceId,
          videoId,
          payload: { forceBackend: fb === 'gemini-native' || fb === 'gemini-text' || fb === 'openrouter-video' ? fb : undefined },
          opId: job.opId,
        });
      }

      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);

      // If the fetch had a pending analysis, refund the pre-debited credits
      // since the analysis will never run. Only refund on terminal failure
      // (attempts exhausted) — a retry may still succeed.
      if (terminal) {
        const fPayload = JSON.parse(job.payloadJson || '{}') as FetchJobPayload;
        if (fPayload.opId) {
          await refundCredits(
            job.workspaceId,
            CREDIT_COSTS.analyzeVideo,
            'analyze_video',
            `${fPayload.opId}:fetch_fail`,
            'fetch_failed',
          ).catch(e => console.warn(`[worker] refund failed for fetch ${job.id}: ${(e as Error).message}`));
        }
      }

      console.warn(`[worker] fetch job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // thumb jobs: fetch + store ONE cover image that a refresh deferred past
  // THUMB_INGEST_MAX_PER_RUN. No Apify, no AI — a single image fetch — so no
  // opId/preAuthCredits and nothing to refund. Idempotent: a row already
  // 'stored' (e.g. a backfill re-run) completes as a no-op.
  if (job.kind === 'thumb') {
    try {
      if (!videoId) throw new Error('thumb job has no videoId');
      const video = await db.video.findUnique({
        where: { id: videoId },
        select: { id: true, platform: true, thumbnailUrl: true, thumbKey: true, thumbStatus: true },
      });
      // Deleted by the retention/listing sweep between enqueue and drain —
      // nothing to ingest, and not a retryable error.
      if (!video) { await completeJob(job.id, null); return { ok: true }; }
      if (video.thumbStatus === 'stored' && video.thumbKey) {
        await completeJob(job.id, null);
        return { ok: true };
      }
      const payload = JSON.parse(job.payloadJson || '{}') as ThumbJobPayload;
      const target: ThumbIngestTarget = {
        videoId: video.id,
        platform: video.platform,
        // Prefer the URL captured at enqueue; fall back to the stored CDN URL.
        thumbnailUrl: payload.thumbnailUrl || video.thumbnailUrl,
        coverDownloadUrl: payload.coverDownloadUrl ?? undefined,
      };
      const ingest = await ingestThumbnails(job.workspaceId, [target]);
      if (ingest.failed > 0) throw new Error('thumbnail fetch/store failed');
      // stored>0 = done. skipped (storage disabled, or a non-tiktok row) is a
      // no-op rather than a failure — retrying won't help, and a backfill will
      // pick the row up once storage is back on.
      await completeJob(job.id, null);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      const { terminal } = await failJob(job.id, message);
      console.warn(`[worker] thumb job ${job.id} failed (terminal=${terminal}): ${message}`);
      return { ok: false, error: message };
    }
  }

  // analyze jobs (the default kind): the full AI analysis pipeline.
  let payload: AnalyzeJobPayload = {};
  try {
    payload = JSON.parse(job.payloadJson) as AnalyzeJobPayload;
  } catch {
    // A malformed payload is not worth failing the job over — the defaults are
    // what an un-parameterised analyze_video call would have used.
  }

  try {
    const result = await analyzeVideoWithDownload(videoId, {
      forceBackend: payload.forceBackend,
    });
    await completeJob(job.id, result.id ?? null);
    return { ok: true };
  } catch (err) {
    // Tag the failure with its category ([gemini_quota] etc.) so the detail
    // endpoint can tell the gallery "Gemini is out of credits" from "this
    // video can't be analyzed" — see src/lib/gemini-errors.ts.
    const message = tagJobFailure(err);
    const { terminal } = await failJob(job.id, message);

    // The caller was debited at enqueue time, so the refund is owed here — but
    // only once the job has actually given up. A requeued job may still
    // succeed, and refunding then re-charging would corrupt the ledger.
    if (terminal && job.opId) {
      await refundCredits(
        job.workspaceId,
        CREDIT_COSTS.analyzeVideo,
        'analyze_video',
        `${job.opId}:fail`,
        'call_failed',
      ).catch(e => console.warn(`[worker] refund failed for ${job.id}: ${(e as Error).message}`));
    }

    console.warn(`[worker] analyze job ${job.id} failed (terminal=${terminal}): ${message}`);
    return { ok: false, error: message };
  }
}