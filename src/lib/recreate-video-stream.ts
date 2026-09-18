// Workers-native video → slideshow: Cloudflare Stream is the frame server.
//
// The VPS drainer's recreate branch runs ffmpeg on a temp MP4 — impossible on
// workerd (no fs, no subprocess) and far beyond the drain's cheap-job budget.
// This module is the pure-Workers alternative, stepped by the every-minute
// drain tick: each tick advances ONE cheap phase and persists the state
// machine in the job's payloadJson, so a multi-minute pipeline never holds a
// Worker longer than a slow API call:
//
//   plan   — Gemini (same model as Analyze) picks keyframes; stored in payload
//   copy   — hand Stream the signed R2 URL (`/stream/copy`); no video bytes
//            through the Worker
//   wait   — poll readyToStream (processing takes up to ~5 min; idle ticks
//            are free and write nothing)
//   slides — one Stream thumbnail per tick → gpt-image-2.5-sunburst → R2;
//            the last tick stamps recreationKeys and deletes the Stream copy
//            (stops the storage billing)
//
// Both executors can race for a row: the VPS drainer also claims `recreate`
// and runs the ffmpeg path. Whoever takes the row first completes it; the
// loser finds nothing resumable. Resume safety: a `stepAt` lease in the
// payload stops two tick isolates from advancing the same running job.

import { db } from '../db.js';
import { CREDIT_COSTS, refundCredits } from './credits.js';
import { completeJob, failJob, toMediaJobRow, type MediaJobRow } from './jobs.js';
import {
  fetchStoredVideoBytes, stampRecreationKeys, signedMediaUrl,
} from './media.js';
import { putObject, thumbBucket, recreationPath } from './storage.js';
import { generateOpenRouterImage } from './openrouter.js';
import { liveGeminiFile } from '../analysis/index.js';
import {
  planVideoSlides, buildVideoSlidePrompt,
  fallbackIntervalPlan, planTimestamps, MIN_VIDEO_SLIDES, MAX_VIDEO_SLIDES,
  type VideoSlidePlan, type VideoSlidePlanResult,
} from './recreate-slideshow.js';
import {
  streamConfig, streamCopyFromUrl, streamVideoStatus,
  fetchStreamThumbnail, deleteStreamVideo, STREAM_RECREATE_NAME_PREFIX,
  type StreamVideoStatus,
} from './stream-frames.js';

export type VideoRecreatePhase = 'plan' | 'copy' | 'wait' | 'slides' | 'done';

export interface VideoRecreatePayload {
  mode: 'video';
  phase?: VideoRecreatePhase;
  /** Lease: ms epoch of the last saved step. Resume only after LEASE_MS. */
  stepAt?: number;
  plan?: VideoSlidePlan['slides'];
  planModel?: string;
  planSource?: string;
  /** Per-slide pricing true-up done (enqueue pre-auths the 8-slide max). */
  priced?: boolean;
  streamUid?: string;
  thumbBase?: string;
  slideIndex?: number;
  keys?: string[];
  /** 0-based plan indices whose generation failed (e.g. OpenAI safety
   *  rejection) — skipped so one bad frame cannot kill the whole deck. */
  skipped?: number[];
  costUsd?: number;
}

/** One tick may advance a running job only if the previous step is stale. */
export const RECREATE_STEP_LEASE_MS = 90_000;

/** Video decks pre-auth the 8-slide max at enqueue (slide count unknown until
 *  the plan phase); photo decks debit the exact count up front. */
export function recreatePreAuthCredits(slideCount: number): number {
  return Math.max(0, Math.min(slideCount, MAX_VIDEO_SLIDES)) * CREDIT_COSTS.recreateSlideshow;
}

/** True-up once the plan lands: refund the pre-auth/max gap (0 when the deck
 *  used the full max). Pure — the caller performs the refund + row update. */
export function recreateTrueUpRefund(preAuthCredits: number | null, slideCount: number): number {
  const actual = Math.max(0, slideCount) * CREDIT_COSTS.recreateSlideshow;
  return Math.max(0, (preAuthCredits ?? actual) - actual);
}

/** Stream-ready polling inside a drive: 4s interval, ~3 min cap before the
 *  drive yields and the cron resumes the job. */
export const RECREATE_WAIT_POLL_MS = 4_000;
export const RECREATE_WAIT_MAX_POLLS = 45;

interface VideoCore {
  id: string;
  caption: string;
  creatorHandle: string;
  mediaKey: string | null;
  mediaStatus: string;
  durationSec: number | null;
  rawJson: string | null;
  geminiFileUri: string | null;
  geminiFileName: string | null;
  geminiFileExpiresAt: Date | null;
}

/** Everything the state machine needs — injected so tests can fake the world. */
export interface RecreateVideoDeps {
  loadVideo(videoId: string): Promise<(VideoCore & { workspaceId: string }) | null>;
  signMediaUrl(mediaKey: string): Promise<string | null>;
  planSlides(video: VideoCore): Promise<VideoSlidePlanResult>;
  streamCopy(signedUrl: string, videoId: string): Promise<string>;
  streamStatus(uid: string): Promise<StreamVideoStatus>;
  streamThumbnail(uid: string, tSec: number, baseThumbnailUrl: string): Promise<Uint8Array>;
  streamDelete(uid: string): Promise<void>;
  generateSlide(prompt: string, referenceDataUrl: string): Promise<{ bytes: Uint8Array; contentType: string; costUsd: number }>;
  putSlide(workspaceId: string, videoId: string, index: number, bytes: Uint8Array, contentType: string): Promise<string>;
  stampKeys(videoId: string, keys: string[]): Promise<void>;
  savePayload(jobId: string, payload: VideoRecreatePayload): Promise<void>;
  complete(jobId: string, payload: VideoRecreatePayload): Promise<void>;
  fail(jobId: string, message: string): Promise<{ terminal: boolean }>;
  refund(jobId: string, workspaceId: string, opId: string | null, preAuthCredits: number | null): Promise<void>;
}

export function parseRecreatePayload(raw: string): VideoRecreatePayload {
  try {
    return JSON.parse(raw || '{}') as VideoRecreatePayload;
  } catch {
    return { mode: 'video' };
  }
}

/**
 * The real dependency set. Every db call is sequential (D1 single-writer),
 * every network call bounded.
 */
export function defaultRecreateVideoDeps(): RecreateVideoDeps {
  const config = streamConfig();
  if (!config) throw new Error('Cloudflare Stream is not configured (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_STREAM_TOKEN/CLOUDFLARE_API_TOKEN).');
  return {
    async loadVideo(videoId) {
      const video = await db.video.findUnique({
        where: { id: videoId },
        select: {
          id: true, caption: true, creatorHandle: true, mediaKey: true, mediaStatus: true,
          durationSec: true, rawJson: true, sourceId: true, geminiFileUri: true,
          geminiFileName: true, geminiFileExpiresAt: true,
        },
      });
      if (!video) return null;
      const source = await db.source.findUnique({ where: { id: video.sourceId }, select: { workspaceId: true } });
      if (!source?.workspaceId) return null;
      const { sourceId: _sourceId, ...core } = video;
      return { ...core, workspaceId: source.workspaceId };
    },
    async signMediaUrl(mediaKey) {
      const signed = await signedMediaUrl({ mediaKey, mediaStatus: 'stored' });
      return signed.url;
    },
    async planSlides(video) {
      if (!video.mediaKey) throw new Error('Store the video first (Download video), then recreate it as a slideshow.');
      const bytes = await fetchStoredVideoBytes(video.mediaKey);
      if (!bytes) throw new Error('Could not read the stored MP4.');
      return planVideoSlides({
        videoId: video.id,
        videoBytes: bytes,
        durationSec: video.durationSec,
        creatorHandle: video.creatorHandle,
        caption: video.caption,
        geminiFile: liveGeminiFile(video),
      });
    },
    streamCopy: (url, videoId) => streamCopyFromUrl(config, url, { name: `${STREAM_RECREATE_NAME_PREFIX}${videoId}` }),
    streamStatus: (uid) => streamVideoStatus(config, uid),
    streamThumbnail: (uid, tSec, base) => fetchStreamThumbnail(config, uid, tSec, base),
    streamDelete: (uid) => deleteStreamVideo(config, uid),
    async generateSlide(prompt, referenceDataUrl) {
      const img = await generateOpenRouterImage({
        prompt,
        referenceUrl: referenceDataUrl,
        quality: 'low',
        aspectRatio: '9:16',
      });
      return { bytes: new Uint8Array(img.buffer), contentType: img.contentType, costUsd: img.costUsd };
    },
    async putSlide(workspaceId, videoId, index, bytes, contentType) {
      const path = recreationPath(workspaceId, videoId, index);
      await putObject({ bucket: thumbBucket(), path, body: bytes, contentType: contentType || 'image/jpeg' });
      return path;
    },
    stampKeys: (videoId, keys) => stampRecreationKeys(videoId, keys),
    async savePayload(jobId, payload) {
      payload.stepAt = Date.now();
      await db.mediaJob.update({
        where: { id: jobId },
        data: { payloadJson: JSON.stringify(payload), startedAt: new Date() },
      });
    },
    async complete(jobId, payload) {
      await completeJob(jobId, null, JSON.stringify({ ...payload, phase: 'done' as const }));
    },
    fail: (jobId, message) => failJob(jobId, message),
    async refund(jobId, workspaceId, opId, preAuthCredits) {
      if (!opId) return;
      await refundCredits(
        workspaceId,
        // Pre-per-slide rows (flat 2/deck); current rows always carry the
        // true-up'd amount on the row itself.
        preAuthCredits ?? 2,
        'recreate_slideshow',
        `${opId}:fail`,
        'call_failed',
      ).catch(e => console.warn(`[recreate-stream] refund failed for ${jobId}: ${(e as Error).message}`));
    },
  };
}

/**
 * Claim the next video-mode recreate job. The queued take is ATOMIC — the
 * same single UPDATE..RETURNING claimNextJob uses (D1 is single-writer; two
 * concurrent tick isolates serialize, the loser sees nothing). The stepper is
 * Workers-only, so there is no Postgres branch. Resume path: a running row
 * whose stepAt lease expired. Null when nothing is resumable.
 */
export async function takeVideoRecreateJob(): Promise<MediaJobRow | null> {
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    UPDATE "MediaJob"
       SET "status" = 'running',
           "startedAt" = ${new Date()},
           "attempts" = "attempts" + 1
     WHERE "id" = (
       SELECT "id" FROM "MediaJob"
        WHERE "status" = 'queued' AND "kind" = 'recreate'
          AND "payloadJson" LIKE '%"mode":"video"%'
        ORDER BY "createdAt" ASC
        LIMIT 1
     )
    RETURNING *
  `;
  if (rows[0]) return toMediaJobRow(rows[0]);

  const running = await db.mediaJob.findFirst({
    where: { kind: 'recreate', status: 'running', payloadJson: { contains: '"mode":"video"' } },
    orderBy: { startedAt: 'asc' },
  });
  if (!running) return null;
  const payload = parseRecreatePayload(running.payloadJson);
  // A fresh stepAt means another tick's step is still in flight.
  if (payload.stepAt && Date.now() - payload.stepAt < RECREATE_STEP_LEASE_MS) return null;
  return running as unknown as MediaJobRow;
}

/** Advance ONE phase of one job. Throws on step failure (caller fails the job). */
export async function advanceRecreateVideoJob(
  job: Pick<MediaJobRow, 'id' | 'videoId' | 'workspaceId' | 'opId' | 'preAuthCredits' | 'payloadJson'>,
  deps: RecreateVideoDeps,
): Promise<VideoRecreatePayload | null> {
  if (!job.videoId) throw new Error('recreate job has no videoId');
  const payload = parseRecreatePayload(job.payloadJson);

  const video = await deps.loadVideo(job.videoId);
  if (!video) throw new Error('Video (or its workspace) vanished.');

  const phase = payload.phase ?? 'plan';

  if (phase === 'plan') {
    let planResult: VideoSlidePlanResult;
    try {
      planResult = await deps.planSlides(video);
    } catch (err) {
      console.warn(`[recreate-stream] slide plan failed for ${video.id}, falling back to interval frames: ${(err as Error).message}`);
      planResult = { plan: fallbackIntervalPlan(video.durationSec), model: 'interval', source: 'fallback-interval' };
    }
    // Short clips sometimes come back with a single planned slide; a carousel
    // needs a few — top up with interval frames (keeps the planned ones).
    let plan = planResult.plan;
    if (plan.slides.length < MIN_VIDEO_SLIDES) {
      const timestamps = planTimestamps(plan, video.durationSec);
      plan = {
        slides: timestamps.map(t =>
          plan.slides.find(s => s.tSec === t) ?? { tSec: t, description: '', overlayText: null },
        ),
      };
    }
    payload.plan = plan.slides;
    payload.planModel = planResult.model;
    payload.planSource = planResult.source;
    // Per-slide pricing true-up, once: enqueue pre-authed the 8-slide max,
    // now that the plan is known refund the difference and pin the row's
    // preAuthCredits to the true amount (terminal-failure refunds read it).
    if (!payload.priced && job.opId) {
      const refund = recreateTrueUpRefund(job.preAuthCredits, payload.plan.length);
      if (refund > 0) {
        await refundCredits(job.workspaceId, refund, 'recreate_slideshow', `${job.opId}:trueup`, 'adjustment').catch((e) =>
          console.warn(`[recreate-stream] true-up refund failed for ${job.id}: ${(e as Error).message}`),
        );
        await db.mediaJob.update({ where: { id: job.id }, data: { preAuthCredits: (job.preAuthCredits ?? 0) - refund } });
      }
      payload.priced = true;
    }
    payload.phase = 'copy';
    await deps.savePayload(job.id, payload);
    return payload;
  }

  if (phase === 'copy') {
    if (!video.mediaKey) throw new Error('Store the video first (Download video), then recreate it as a slideshow.');
    const signedUrl = await deps.signMediaUrl(video.mediaKey);
    if (!signedUrl) throw new Error('Could not sign the stored MP4 for Stream.');
    const uid = await deps.streamCopy(signedUrl, video.id);
    payload.streamUid = uid;
    payload.phase = 'wait';
    await deps.savePayload(job.id, payload);
    return payload;
  }

  if (phase === 'wait') {
    if (!payload.streamUid) throw new Error('Stream copy phase never recorded a uid.');
    const status = await deps.streamStatus(payload.streamUid);
    if (status.state === 'error') throw new Error(`Stream processing failed for ${payload.streamUid}.`);
    if (!status.ready) {
      // Still processing — write nothing; the driver polls again after a
      // short sleep, the tick resumes much later if the driver is gone.
      console.log(`[recreate-stream] ${video.id}: Stream not ready yet (${status.state}), waiting.`);
      return payload;
    }
    if (!status.thumbnailUrl) throw new Error(`Stream video ${payload.streamUid} is ready but returned no thumbnail URL.`);
    payload.thumbBase = status.thumbnailUrl;
    payload.phase = 'slides';
    payload.slideIndex = 0;
    await deps.savePayload(job.id, payload);
    return payload;
  }

  // slides — all remaining keyframes IN PARALLEL: each slide is an
  // independent OpenRouter call (~15-25s), so sequential generation was the
  // last slow leg. A provider safety rejection skips one frame; a real error
  // fails the attempt (the cron resumes the phase from the payload).
  if (!payload.streamUid) throw new Error('Stream copy phase never recorded a uid.');
  const slides = payload.plan ?? [];
  if (!slides.length) throw new Error('Plan phase never stored slides.');
  const startIndex = payload.slideIndex ?? 0;
  const remaining = slides.slice(startIndex).map((meta, off) => ({ meta, index: startIndex + off }));

  const results = await Promise.all(remaining.map(async ({ meta, index }) => {
    try {
      const frame = await deps.streamThumbnail(payload.streamUid!, meta.tSec, payload.thumbBase ?? '');
      const prompt = buildVideoSlidePrompt({
        slideIndex: index,
        slideCount: slides.length,
        caption: video.caption,
        description: meta.description,
      });
      const img = await deps.generateSlide(prompt, `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}`);
      if (img.bytes.length < 512) throw new Error(`recreated slide ${index + 1} too small`);
      const key = await deps.putSlide(video.workspaceId, video.id, index, img.bytes, img.contentType);
      console.log(`[recreate-stream] ${video.id}: slide ${index + 1}/${slides.length} ($${img.costUsd.toFixed(4)})`);
      return { index, key, costUsd: img.costUsd, skipped: false };
    } catch (err) {
      // The image provider (not the pipeline) rejected THIS frame — the
      // classic case is OpenAI's safety system on a suggestive keyframe.
      // Failing the whole deck over one frame refunds everything; skipping
      // the frame ships a smaller deck instead.
      if (!/safety system|safety_violations/i.test((err as Error).message)) throw err;
      console.warn(`[recreate-stream] ${video.id}: slide ${index + 1}/${slides.length} rejected by the image provider's safety system — skipping`);
      return { index, skipped: true };
    }
  }));

  payload.keys = [...(payload.keys ?? []), ...results.filter(r => !r.skipped).map(r => r.key!)];
  payload.skipped = [...(payload.skipped ?? []), ...results.filter(r => r.skipped).map(r => r.index)];
  payload.costUsd = (payload.costUsd ?? 0) + results.filter(r => !r.skipped).reduce((sum, r) => sum + (r as { costUsd: number }).costUsd, 0);
  payload.slideIndex = slides.length;
  if (!payload.keys.length) throw new Error('every slide was rejected by the image provider — nothing to deliver');

  await finalizeRecreate(job, video, payload, deps);
  return null;
}

async function finalizeRecreate(
  job: Pick<MediaJobRow, 'id' | 'opId'>,
  video: VideoCore & { workspaceId: string },
  payload: VideoRecreatePayload,
  deps: RecreateVideoDeps,
): Promise<void> {
  const keys = payload.keys ?? [];
  if (!keys.length) throw new Error('finalize without any slides');
  await deps.stampKeys(video.id, keys);
  await deps.complete(job.id, payload);
  // Best-effort: an orphaned Stream copy costs fractions of a cent per day.
  if (payload.streamUid) await deps.streamDelete(payload.streamUid).catch(() => {});
  console.log(`[recreate-stream] ${video.id}: done, ${keys.length} slides, $${(payload.costUsd ?? 0).toFixed(4)} image-gen`);
}

/** Step failure → cleanup + failJob (+ refund once terminal), mirroring the
 *  VPS recreate branch's money path. Exported for the state-machine tests. */
export async function failRecreateVideoJob(job: MediaJobRow, deps: RecreateVideoDeps, message: string): Promise<void> {
  const payload = parseRecreatePayload(job.payloadJson);
  if (payload.streamUid) await deps.streamDelete(payload.streamUid).catch(() => {});
  const { terminal } = await deps.fail(job.id, message);
  if (terminal && job.opId) await deps.refund(job.id, job.workspaceId, job.opId, job.preAuthCredits);
  console.warn(`[recreate-stream] job ${job.id} failed (terminal=${terminal}): ${message}`);
}

/**
 * Drive ONE job continuously: phases chain back-to-back inside this call
 * (plan -> copy -> wait-with-polls -> every slide -> finalize) until it is
 * done, the wall-clock deadline hits, or Stream keeps us waiting past the
 * poll cap. The payload checkpoints mean a deadline/kill mid-drive simply
 * resumes from the same phase on the next trigger — the cron is the safety
 * net, not the metronome.
 */
export async function driveVideoRecreateJob(
  job: MediaJobRow,
  deps: RecreateVideoDeps,
  deadlineMs: number,
  opts: { waitPollMs?: number } = {},
): Promise<void> {
  const waitPollMs = opts.waitPollMs ?? RECREATE_WAIT_POLL_MS;
  let payload = parseRecreatePayload(job.payloadJson);
  let waitPolls = 0;
  let lastPhase = payload.phase ?? 'plan';
  let lastIndex = payload.slideIndex ?? -1;

  while (Date.now() < deadlineMs) {
    const advanced = await advanceRecreateVideoJob({ ...job, payloadJson: JSON.stringify(payload) }, deps);
    if (!advanced) return; // finalized
    payload = advanced;
    const phase = payload.phase ?? 'plan';
    const index = payload.slideIndex ?? -1;
    if (phase !== lastPhase || index !== lastIndex) {
      lastPhase = phase;
      lastIndex = index;
      waitPolls = 0;
      continue; // progress — next phase immediately
    }
    if (phase === 'wait' && ++waitPolls <= RECREATE_WAIT_MAX_POLLS) {
      await sleep(waitPollMs);
      continue; // Stream still processing — poll again
    }
    return; // no progress within this drive — a later tick resumes
  }
}

/**
 * Drive as many video recreations as the wall-clock budget allows. The
 * trigger (cron tick, enqueue poke) starts the drive; the cron is the resume
 * safety net for anything that outlives its budget.
 */
export async function driveRecreateVideoJobs(opts: {
  wallBudgetMs: number;
  waitPollMs?: number;
}): Promise<{ driven: number; error?: string }> {
  const deps = defaultRecreateVideoDeps();
  const startedAt = Date.now();
  let driven = 0;
  while (Date.now() - startedAt < opts.wallBudgetMs) {
    const job = await takeVideoRecreateJob();
    if (!job) break;
    try {
      await driveVideoRecreateJob(job, deps, startedAt + opts.wallBudgetMs, {
        waitPollMs: opts.waitPollMs,
      });
    } catch (err) {
      await failRecreateVideoJob(job, deps, (err as Error).message);
    }
    driven++;
  }
  return { driven };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
