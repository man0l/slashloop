// ---------------------------------------------------------------------------
// Source management — data layer shared by the MCP tools (src/tools/sources.ts,
// conversational, wraps these in withNextSteps()) and the REST API
// (api/sources/*.ts, wraps these in plain JSON). Extracted so neither surface
// duplicates the ~500-line refresh_source flow (credits, Apify, async job
// queuing) — this file owns the logic, callers own response shaping.
//
// Every function takes an already-resolved, already-ownership-checked
// Workspace rather than calling requireWorkspace() itself, so it works the
// same whether the caller is an MCP tool (AsyncLocalStorage-scoped) or a
// plain REST handler (JWT-scoped, no ALS context).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { Source, Workspace } from '@prisma/client';
import { db } from '../db.js';
import { scrapeCapKind, scrapeSource, trafficStatus } from './scrapers/index.js';
import { getApifyCapStatus, SpendCapExceededError } from './spend-cap.js';
import { TrafficCapExceededError } from './scrapers/bandwidth.js';
import { batchScoreVideos } from '../scoring.js';
import { infoNote } from './refresh-notes.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits } from './credits.js';
import { ingestThumbnails, ingestSlideshows, slideshowTargetFromNormalized, type ThumbIngestTarget, type SlideshowIngestTarget } from './media.js';
import { enqueueRefreshJob, enqueueRescoreJob, outstandingJobForSource, dispatchWorker } from './jobs.js';
import { dismissSuggestion } from './suggestions.js';
import { resolveRefreshPlan } from './refresh-policy.js';

/**
 * Largest refresh still run inline, in videos. Zero = always queue.
 *
 * This was 10, on the reasoning that a 10-video scrape "fits". It does not.
 * Two separate 10-video creator refreshes both timed the MCP client out at
 * 180s, and both had their cross-source rescore killed after the scrape had
 * already been billed — the precise half-completion the queue exists to stop.
 *
 * Worse, the threshold silently disabled the queue altogether: deepen_baselines
 * creates sources with videoLimit 10, and the test is `limit > 10`, so every
 * source it made missed the queue by one video.
 *
 * A scrape is an opaque call to a third party. Nothing about it is reliably
 * bounded, so there is no honest number here other than zero. `async: false`
 * remains available to force the old path when debugging.
 */
const INLINE_REFRESH_MAX_VIDEOS = 0;

/** How long callers should be willing to wait on a queued refresh. */
const REFRESH_JOB_DEADLINE_MS = 5 * 60_000;

export interface ListSourcesFilters {
  platform?: string;
  sourceType?: string;
  isActive?: boolean;
  nicheTag?: string;
}

export async function listSourcesForWorkspace(workspace: Workspace, filters: ListSourcesFilters) {
  const sources = await db.source.findMany({
    where: {
      workspaceId: workspace.id,
      platform: filters.platform,
      sourceType: filters.sourceType,
      isActive: filters.isActive,
      nicheTag: filters.nicheTag || undefined,
    },
    include: {
      // Filtered relation count: excludes baseline-only samples pulled to
      // keep a creator's outlier baseline fresh (see Video.isBaselineSample)
      // — they aren't content the workspace tracked, so they shouldn't
      // inflate what looks like a source's real video count.
      _count: { select: { videos: { where: { isBaselineSample: false } }, refreshRuns: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return sources.map(s => ({
    id: s.id,
    platform: s.platform,
    sourceType: s.sourceType,
    query: s.query,
    language: s.language,
    videoLimit: s.videoLimit,
    refreshSchedule: s.refreshSchedule,
    isActive: s.isActive,
    nicheTag: s.nicheTag,
    videoCount: s._count.videos,
    refreshCount: s._count.refreshRuns,
    lastRefreshedAt: s.lastRefreshedAt?.toISOString() ?? null,
    consecutiveFails: s.consecutiveFails,
    createdAt: s.createdAt.toISOString(),
  }));
}

export async function getSourceForWorkspace(workspace: Workspace, sourceId: string) {
  const source = await db.source.findFirst({
    where: { id: sourceId, workspaceId: workspace.id },
    include: {
      videos: {
        where: { isBaselineSample: false },
        take: 5,
        orderBy: { postedAt: 'desc' },
        select: { id: true, views: true, postedAt: true },
      },
      refreshRuns: { take: 3, orderBy: { ranAt: 'desc' } },
    },
  });
  if (!source) return null;

  // MediaJob has no Prisma relation to Source (sourceId is a plain nullable
  // column, shared with video-scoped kinds) — queried separately rather than
  // via `include`. Refusals like insufficient_credits/cap_breached never
  // reach runRefresh's db.refreshRun.create() call, so they leave no
  // RefreshRun row at all; without this, a source can fail every attempt
  // and still show nothing wrong anywhere in the UI.
  const lastRefreshJob = await db.mediaJob.findFirst({
    where: { sourceId, kind: 'refresh' },
    orderBy: { createdAt: 'desc' },
    select: { status: true, lastError: true, createdAt: true, finishedAt: true },
  });

  return { ...source, lastRefreshJob };
}

export interface CreateSourceInput {
  platform: string;
  sourceType: 'creator' | 'keyword' | 'hashtag';
  query: string;
  language: string;
  videoLimit: number;
  refreshSchedule: 'manual' | 'daily' | 'weekly';
  nicheTag?: string;
}

export type CreateSourceResult =
  | { ok: true; source: Source }
  | { ok: false; error: 'platform_not_supported'; platform: string; message: string; suggestion: string };

export async function createSourceForWorkspace(
  workspace: Workspace,
  input: CreateSourceInput,
): Promise<CreateSourceResult> {
  const { platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag } = input;

  // Refuse platforms that cannot be scraped, at the moment the user asks —
  // not two steps later at refresh.
  //
  // scrapeSource throws for reels and shorts (src/lib/apify.ts): there is no
  // scraper for either. Accepting the source anyway produced the worst
  // possible onboarding path — track succeeds, refresh fails, and the
  // product looks broken rather than incomplete. Found by walking the
  // new-user journey: search_library on an empty Reels library offered
  // exactly this dead end.
  if (platform !== 'tiktok') {
    return {
      ok: false,
      error: 'platform_not_supported',
      platform,
      message: `${platform} cannot be scraped yet — TikTok is the only live platform. `
        + 'Creating this source would succeed and then fail at refresh, so it is refused here instead.',
      suggestion: `If this query also exists on TikTok, track it there: `
        + `create_source with platform="tiktok", sourceType="${sourceType}", query="${query}".`,
    };
  }

  const source = await db.source.create({
    data: {
      workspaceId: workspace.id,
      platform, sourceType, query, language, videoLimit, refreshSchedule, nicheTag,
    },
  });
  return { ok: true, source };
}

export interface UpdateSourceInput {
  query?: string;
  videoLimit?: number;
  refreshSchedule?: 'manual' | 'daily' | 'weekly';
  isActive?: boolean;
  nicheTag?: string | null;
  language?: string;
}

export async function updateSourceForWorkspace(
  workspace: Workspace,
  sourceId: string,
  updates: UpdateSourceInput,
): Promise<Source | null> {
  const owned = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
  if (!owned) return null;

  return db.source.update({ where: { id: sourceId }, data: updates }).catch(() => null);
}

export async function deleteSourceForWorkspace(workspace: Workspace, sourceId: string): Promise<boolean> {
  const owned = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
  if (!owned) return false;

  // Delete in FK order
  await db.hook.deleteMany({ where: { video: { sourceId } } });
  await db.swipeEntry.deleteMany({ where: { video: { sourceId } } });
  await db.idea.deleteMany({ where: { video: { sourceId } } });
  await db.analysis.deleteMany({ where: { videoId: { in: (await db.video.findMany({ where: { sourceId }, select: { id: true } })).map(v => v.id) } } });
  await db.score.deleteMany({ where: { videoId: { in: (await db.video.findMany({ where: { sourceId }, select: { id: true } })).map(v => v.id) } } });
  await db.refreshRun.deleteMany({ where: { sourceId } });
  await db.video.deleteMany({ where: { sourceId } });
  await db.source.delete({ where: { id: sourceId } }).catch(() => null);

  // Deleting a source is a stronger "no thanks" than dismissing a mere
  // suggestion — the user tracked it and then decided against it. Record it
  // the same way, so seedSourceCandidates() doesn't turn around and suggest
  // the exact thing just removed.
  await dismissSuggestion(workspace, { sourceType: owned.sourceType as 'hashtag' | 'keyword' | 'creator', query: owned.query });

  return true;
}

export interface RefreshSourceInput {
  videoLimit?: number;
  /** Force inline (false) or queued (true). Default: queued (see INLINE_REFRESH_MAX_VIDEOS). */
  async?: boolean;
}

export type RefreshSourceResult =
  | { kind: 'not_found' }
  | { kind: 'already_queued'; jobId: string; status: string; sourceId: string }
  | {
      kind: 'queued';
      jobId: string;
      sourceId: string;
      query: string;
      videoLimit: number;
      deadlineAt: string;
      workerDispatched: boolean;
    }
  | { kind: 'cap_breached'; capStatus: Awaited<ReturnType<typeof getApifyCapStatus>> | Awaited<ReturnType<typeof trafficStatus>> }
  | { kind: 'insufficient_credits'; err: InsufficientCreditsError }
  | { kind: 'spend_cap_exceeded'; message: string; capStatus: Awaited<ReturnType<typeof getApifyCapStatus>> | Awaited<ReturnType<typeof trafficStatus>>; creditsRemaining: number }
  | {
      kind: 'done';
      message: string;
      sourceId: string;
      platform: string;
      sourceType: string;
      query: string;
      itemsPulled: number;
      newVideos: number;
      costCents: number;
      durationMs: number;
      errors: string[];
      apifyCapStatus: Awaited<ReturnType<typeof getApifyCapStatus>> | null;
      creditsCharged: number;
      creditsRemaining: number;
      fetchSuggestion: { threshold: number; count: number; hint: string } | null;
      rescoreQueued: boolean;
      analyzeCandidates: Array<{ id: string; creatorHandle: string; outlierScore: number | undefined }>;
    };

export async function refreshSourceForWorkspace(
  workspace: Workspace,
  sourceId: string,
  input: RefreshSourceInput,
): Promise<RefreshSourceResult> {
  const source = await db.source.findFirst({ where: { id: sourceId, workspaceId: workspace.id } });
  if (!source) return { kind: 'not_found' };

  // Same bootstrap/incremental plan runRefresh will use, so the job's
  // preAuthCredits and the worker's debit stay aligned (and so the UI
  // estimate reflects the small incremental scrape, not a 50-video full pull).
  const plan = await resolveRefreshPlan(
    {
      id: source.id,
      sourceType: source.sourceType,
      videoLimit: source.videoLimit,
      lastRefreshedAt: source.lastRefreshedAt,
    },
    input.videoLimit,
  );
  const limit = plan.limit;

  // Queue anything big enough to risk the 60s request budget. A scrape that
  // outlives it is killed after the Apify spend but before the rescore —
  // the user pays and the scoring never updates. Small scrapes stay inline
  // because a synchronous answer is nicer when it genuinely fits.
  const shouldQueue = input.async ?? limit > INLINE_REFRESH_MAX_VIDEOS;
  if (shouldQueue) {
    const existing = await outstandingJobForSource(sourceId);
    if (existing) {
      return { kind: 'already_queued', jobId: existing.id, status: existing.status, sourceId };
    }

    const deadlineAt = new Date(Date.now() + REFRESH_JOB_DEADLINE_MS);
    // Pass the resolved limit as limitOverride so a concurrent video insert
    // between enqueue and worker cannot change the pre-auth size mid-flight.
    // runRefresh still re-resolves postedAfter watermark at execute time.
    const job = await enqueueRefreshJob({
      workspaceId: workspace.id,
      sourceId,
      payload: { limitOverride: limit },
      videoLimit: limit,
      deadlineAt,
    });
    // Best-effort poke; pg_cron drains within a minute regardless.
    const dispatch = await dispatchWorker('refresh');

    return {
      kind: 'queued',
      jobId: job.id,
      sourceId,
      query: source.query,
      videoLimit: limit,
      deadlineAt: deadlineAt.toISOString(),
      workerDispatched: dispatch.dispatched,
    };
  }

  const startTime = Date.now();
  let itemsPulled = 0;
  let newVideos = 0;
  let costCents = 0;
  const errors: string[] = [];

  // Same audit line the queued path writes (settleAndApply). Without it an
  // inline run leaves a RefreshRun with errorsJson='[]' and no record of what
  // page size or watermark it chose, which is how a policy regression hides.
  errors.push(infoNote(
    `Refresh policy: mode=${plan.mode} limit=${limit}`
    + (plan.postedAfter ? ` postedAfter=${plan.postedAfter.toISOString()}` : '')
    + (plan.dry ? ' (dry source — narrowed page)' : ''),
  ));

  // Pre-flight: the ledger that belongs to the *active* scraper. A breached
  // Apify cap must not block the proxy path, and vice versa.
  if (scrapeCapKind(source.platform) === 'proxy') {
    const capStatus = await trafficStatus(source.workspaceId);
    if (capStatus.breached) {
      return { kind: 'cap_breached', capStatus };
    }
  } else if (source.platform !== 'shorts') {
    const capStatus = await getApifyCapStatus(source.workspaceId);
    if (capStatus.breached) {
      return { kind: 'cap_breached', capStatus };
    }
  }

  // Pre-authorize credits for the worst case (full `limit` videos
  // returned). Refunded down to actual usage below.
  const opId = randomUUID();
  const preAuthCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * limit);
  let creditBalance;
  try {
    creditBalance = await debitCredits(workspace.id, preAuthCredits, 'refresh_source', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { kind: 'insufficient_credits', err };
    }
    throw err;
  }
  let actualCredits = 0; // set as soon as we know how many videos Apify actually returned

  try {
    const result = await scrapeSource({
      workspaceId: source.workspaceId,
      platform: source.platform,
      sourceType: source.sourceType as 'creator' | 'keyword' | 'hashtag',
      query: source.query,
      limit,
      // The watermark is half the policy: without it this path pays for the
      // creator's already-known catalogue every run, exactly what the plan
      // was resolved to avoid. Only the queued path was passing it, so this
      // one silently bought a full page of known videos. Currently reachable
      // only with an explicit async:false (INLINE_REFRESH_MAX_VIDEOS is 0),
      // which is precisely why it could rot unnoticed.
      postedAfter: plan.postedAfter,
      refId: sourceId,
    });

    itemsPulled = result.items.length;
    costCents = result.costCents;

    // The actor signals a bad query with an in-dataset record, not a failed
    // run (see collectNotices in src/lib/apify.ts). Without this, a source
    // whose handle or hashtag does not exist reports a successful refresh
    // with errors: [] every time, while still costing a full scrape.
    if (result.notices.length > 0) {
      errors.push(...result.notices);
    }
    // Set as soon as the Apify cost is actually incurred — if DB
    // persistence or scoring throws below, this still reflects the
    // real COGS already spent, so the refund settlement stays correct.
    actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * itemsPulled);

    // Persist videos (dedup by platform + externalId)
    const thumbTargets: ThumbIngestTarget[] = [];
    const slideshowTargets: SlideshowIngestTarget[] = [];
    for (const nv of result.items) {
      const existing = await db.video.findFirst({
        where: { platform: nv.platform, externalId: nv.externalId },
        select: { id: true },
      });
      if (existing) continue;

      const created = await db.video.create({
        data: {
          sourceId,
          platform: nv.platform,
          externalId: nv.externalId,
          url: nv.url,
          thumbnailUrl: nv.thumbnailUrl,
          creatorHandle: nv.creatorHandle,
          creatorFollowers: nv.creatorFollowers,
          caption: nv.caption,
          postedAt: new Date(nv.postedAt),
          views: nv.views,
          likes: nv.likes,
          comments: nv.comments,
          shares: nv.shares,
          saves: nv.saves,
          durationSec: nv.durationSec,
          transcript: nv.transcript,
          transcriptSource: nv.transcriptSource,
          rawJson: JSON.stringify(nv.raw),
        },
        select: { id: true },
      });
      newVideos++;
      thumbTargets.push({
        videoId: created.id,
        platform: nv.platform,
        thumbnailUrl: nv.thumbnailUrl,
        coverDownloadUrl: nv.coverDownloadUrl,
      });
      const slides = slideshowTargetFromNormalized(created.id, nv.raw);
      if (slides) slideshowTargets.push(slides);
    }

    // Persist cover images to Supabase Storage. Deliberately after the
    // insert loop and batched (see src/lib/media.ts) — 50 sequential
    // round-trips would not fit the 60s function budget. Never throws:
    // a missing thumbnail must not fail a refresh that already paid Apify.
    if (thumbTargets.length > 0) {
      const ingest = await ingestThumbnails(source.workspaceId, thumbTargets);
      if (ingest.failed > 0) {
        errors.push(`Thumbnail ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
      }
    }
    if (slideshowTargets.length > 0) {
      const ingest = await ingestSlideshows(source.workspaceId, slideshowTargets);
      if (ingest.failed > 0) {
        errors.push(`Slideshow ingest: ${ingest.failed}/${ingest.stored + ingest.failed} failed`);
      }
    }

    // Re-score the source's videos so outliers surface
    if (newVideos > 0) {
      await batchScoreVideos(sourceId).catch(err => errors.push(`Scoring failed: ${(err as Error).message}`));
    }
  } catch (err) {
    if (err instanceof SpendCapExceededError || err instanceof TrafficCapExceededError) {
      // Cap breach — refuse, refund the full pre-auth, and report.
      creditBalance = await refundCredits(workspace.id, preAuthCredits, 'refresh_source', `${opId}:fail`, 'call_failed');
      return {
        kind: 'spend_cap_exceeded',
        message: err.message,
        capStatus: err instanceof TrafficCapExceededError
          ? await trafficStatus(source.workspaceId)
          : await getApifyCapStatus(source.workspaceId),
        creditsRemaining: creditBalance.total,
      };
    }
    errors.push((err as Error).message);
  }

  // Settle: refund the unused portion of the pre-auth. actualCredits
  // stays 0 if scrapeSource itself threw before returning any items.
  const refundAmount = preAuthCredits - actualCredits;
  if (refundAmount > 0) {
    creditBalance = await refundCredits(workspace.id, refundAmount, 'refresh_source', `${opId}:settle`, 'usage_settlement');
  }

  // Log the refresh run regardless of outcome
  await db.refreshRun.create({
    data: { sourceId, itemsPulled, newVideos, errorsJson: JSON.stringify(errors), costCents, ranAt: new Date() },
  });
  await db.source.update({ where: { id: sourceId }, data: { lastRefreshedAt: new Date() } });

  // Refreshing a CREATOR source is the moment that creator's history can
  // cross CREATOR_BASELINE_MIN_SAMPLE — which changes the score of their
  // videos sitting in OTHER sources (the hashtag scrape that surfaced them).
  // Those rows are not touched by the batchScoreVideos call above, which is
  // scoped to this source, so without this they keep a stale `estimated`
  // score computed against a source median. See deepen_baselines.
  //
  // Queued, not run here. Doing it inline is what kept dying: measured on a
  // real run, the scrape and scoring finished 48.2s into a 60s budget,
  // leaving 11.3s to rescore a 30-video hashtag source. It was killed every
  // time, so the refresh was billed and the score never moved.
  //
  // This inline path is now debug-only (async: false), but it must not
  // reintroduce the bug it was written around.
  let rescoreQueued = false;
  if (source.sourceType === 'creator' && itemsPulled > 0) {
    try {
      await enqueueRescoreJob({
        workspaceId: workspace.id,
        sourceId,
        payload: { creatorHandle: source.query },
      });
      rescoreQueued = true;
    } catch (err) {
      errors.push(`could not queue rescore: ${(err as Error).message}`);
    }
  }

  // Surface standout outliers so the caller can OFFER to fetch their videos
  // (download + store the MP4 without a full analysis). Fixed at 50x: the
  // handful of winners per scrape, not the whole pool — that is what makes
  // fetching videos affordable. Counts only videos without stored media.
  const FETCH_SUGGEST_THRESHOLD = 50;
  const fetchCandidates = await db.video.count({
    where: {
      sourceId,
      mediaStatus: { not: 'stored' },
      score: { outlierScore: { gte: FETCH_SUGGEST_THRESHOLD } },
    },
  });
  const fetchSuggestion = fetchCandidates > 0
    ? {
        threshold: FETCH_SUGGEST_THRESHOLD,
        count: fetchCandidates,
        hint: `${fetchCandidates} video(s) scored >= ${FETCH_SUGGEST_THRESHOLD}x and have no stored video yet. Ask the user if they want to see them play, then call fetch_videos with minOutlierScore ${FETCH_SUGGEST_THRESHOLD} (est ~${fetchCandidates}c Apify).`,
      }
    : null;

  const capStatus = source.platform !== 'shorts'
    ? await getApifyCapStatus(source.workspaceId)
    : null;

  // Videos worth paying to analyse: creator-relative ("actual") scores
  // only. An "estimated" score compares a video to its source's median,
  // which mostly flags big accounts posting normally — poor value for
  // credits. Prefer the ones that beat their own creator's baseline.
  const analyzeCandidatesRaw = await db.video.findMany({
    where: {
      sourceId,
      analyses: { none: {} },
      score: { scoreType: 'actual', outlierScore: { gte: 5 } },
    },
    include: { score: true },
    orderBy: { score: { outlierScore: 'desc' } },
    take: 5,
  });
  const analyzeCandidates = analyzeCandidatesRaw.map(c => ({
    id: c.id,
    creatorHandle: c.creatorHandle,
    outlierScore: c.score?.outlierScore,
  }));

  return {
    kind: 'done',
    message: errors.length ? 'Refresh completed with errors' : 'Refresh successful',
    sourceId,
    platform: source.platform,
    sourceType: source.sourceType,
    query: source.query,
    itemsPulled,
    newVideos,
    costCents,
    durationMs: Date.now() - startTime,
    errors,
    apifyCapStatus: capStatus,
    creditsCharged: actualCredits,
    creditsRemaining: creditBalance.total,
    fetchSuggestion,
    rescoreQueued,
    analyzeCandidates,
  };
}
