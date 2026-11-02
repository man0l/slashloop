// ---------------------------------------------------------------------------
// tools-trends job (slashloop.dev/tools trends pages) — VPS side.
//
// One run per day: the Creative Center lists (overall plus every top-level
// industry, per period) for the hashtag ranking, then a first-page sample of
// /tag/<name> for the top tags (sounds and formats come from those posts). All
// of it goes through the proxy. One signed snapshot goes back to the tools
// Worker; the Worker never touches TikTok, and nothing here costs credits or
// writes workspace video rows.
// ---------------------------------------------------------------------------

import { webItemToApifyShape } from '../lib/scrapers/tiktok-web.js';
import {
  CC_INDUSTRIES,
  CC_LIST_BYTES_ESTIMATE,
  mapHashtagLists,
  type ListResult,
  type TrendHashtag,
} from '../lib/creative-center.js';
import { coverUrlOf, type AuthoredCoverTarget } from './tools-covers.js';
import type { ToolsErrorCode } from './tools-jobs.js';

/** ~980 KB per /tag page (30 posts) measured live on the VPS 2026-10-27; budgeted at 1 MB x 20 tags. */
export const TRENDS_SAMPLE_BYTES_PER_TAG = 1024 * 1024;
export const TRENDS_SAMPLE_POSTS_PER_TAG = 30;
export const TRENDS_MAX_SAMPLE_TAGS = 20;
/** Example posts kept per sampled tag (SLA-1149); a niche page shows up to 6 of them, a tag row 3. */
export const TRENDS_EXAMPLES_PER_TAG = 3;
const MAX_CONSECUTIVE_SAMPLE_FAILURES = 3;
/** Consecutive lists that fail after their retries; also the trip point of the 429/5xx breaker. */
const MAX_CONSECUTIVE_LIST_FAILURES = 3;
/** Attempts per list: a throttled response (429/5xx) gets backoff and a third try; anything else retries once, immediately. */
const MAX_THROTTLED_ATTEMPTS = 3;
const MAX_PLAIN_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
/**
 * Run-level deadlines, measured from the start of runTrends, under the 300s
 * job timeout (jobTimeoutMs('tools-trends')). No list attempt starts after
 * the list deadline; one in flight can still take LIST_TIMEOUT_MS (30s). No
 * tag sample starts after the sample deadline. A degraded Creative Center
 * then ends the run as failed:source instead of a job-level timeout that the
 * queue re-runs (SLA-1162).
 */
export const TRENDS_LIST_DEADLINE_MS = 150_000;
export const TRENDS_SAMPLE_DEADLINE_MS = 210_000;
const DESC_MAX_CHARS = 300;

export interface TrendsPayload {
  requestId: string;
  callbackUrl: string;
  country: 'US';
  periods: number[];
  sampleTags: number;
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseTrendsPayload(raw: string): TrendsPayload | { error: string } {
  let p: any;
  try {
    p = JSON.parse(raw || '{}');
  } catch {
    return { error: 'tools-trends payload is not JSON' };
  }
  if (!p || typeof p !== 'object') return { error: 'tools-trends payload is not an object' };
  if (typeof p.requestId !== 'string' || !REQUEST_ID_RE.test(p.requestId)) return { error: 'tools job has no valid requestId' };
  if (typeof p.callbackUrl !== 'string' || !p.callbackUrl) return { error: 'tools job callbackUrl is not allowed' };
  if (p.country !== 'US') return { error: 'tools-trends supports country US only' };
  const periods = Array.isArray(p.periods) ? p.periods : [];
  if (!periods.length || !periods.every((x: unknown) => x === 7 || x === 30)) {
    return { error: 'tools-trends periods must be a non-empty subset of [7, 30]' };
  }
  const sampleTags = p.sampleTags;
  if (!Number.isInteger(sampleTags) || sampleTags < 0 || sampleTags > TRENDS_MAX_SAMPLE_TAGS) {
    return { error: `tools-trends sampleTags must be an integer 0-${TRENDS_MAX_SAMPLE_TAGS}` };
  }
  return {
    requestId: p.requestId,
    callbackUrl: p.callbackUrl,
    country: 'US',
    periods: [...new Set<number>(periods)].sort((a, b) => a - b),
    sampleTags,
  };
}

export interface SamplePost {
  id: string;
  tag: string;
  createTime: number | null;
  soundId: string | null;
  soundTitle: string | null;
  soundAuthor: string | null;
  playCount: number;
  author: string | null;
  durationSec: number | null;
  isPhoto: boolean;
  desc: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Raw /tag item -> the ten fields we keep. Anything else (URLs, stats beyond plays) is dropped; example covers are picked up separately. */
export function mapSampleItem(item: any, tag: string): SamplePost | null {
  const id = item?.id != null ? String(item.id) : '';
  if (!id) return null;
  const music = item?.music ?? {};
  const createTime = Number(item?.createTime);
  const duration = Number(item?.video?.duration);
  const shape = webItemToApifyShape(item);
  const play = Number(item?.stats?.playCount ?? item?.statsV2?.playCount);
  return {
    id,
    tag,
    createTime: Number.isFinite(createTime) && createTime > 0 ? createTime : null,
    soundId: music.id != null && String(music.id) ? String(music.id) : null,
    soundTitle: str(music.title),
    soundAuthor: str(music.authorName),
    playCount: Number.isFinite(play) && play > 0 ? play : 0,
    author: str(item?.author?.uniqueId),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    isPhoto: shape.postKind === 'slideshow',
    desc: String(item?.desc ?? '').slice(0, DESC_MAX_CHARS),
  };
}

export interface TrendsDeps {
  /** Throws on a proxy-budget breach; called before any network use. */
  assertBudget(proxyBytes: number): Promise<void>;
  /** Raw Creative Center items for one list; industryId null = the overall list. */
  fetchHashtagList(period: number, industryId: string | null): Promise<any[]>;
  resolveChallengeId(tag: string): Promise<string | null>;
  fetchTagPosts(tag: string, challengeId: string, limit: number): Promise<any[]>;
  /** Direct (off-proxy) cover download plus signed push to the site; returns the stored ids. Unset = no covers. */
  uploadCovers?(targets: AuthoredCoverTarget[]): Promise<string[]>;
  now(): Date;
  /** Backoff wait between throttled retries; defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
  /** Jitter source in [0, 1); defaults to Math.random. */
  random?(): number;
}

export type TrendsOutcome =
  | {
      status: 'done';
      body: {
        takenAt: string;
        country: 'US';
        hashtags: TrendHashtag[];
        samplePosts: SamplePost[];
        /** Top sampled post ids per tag by views, deduped (SLA-1149). */
        exampleIds: string[];
        /** The subset of exampleIds whose cover the site stored. */
        covers: string[];
      };
      sampledTags: number;
    }
  | { status: 'failed'; code: ToolsErrorCode };

function errorCode(err: unknown): ToolsErrorCode {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'TrafficCapExceededError' || e?.name === 'SpendCapExceededError') return 'budget';
  if (e?.name === 'CreativeCenterError') return 'source';
  if (/\b(429|403)\b|waf|captcha|challenge|rate.?limit|blocked/i.test(String(e?.message ?? err ?? ''))) return 'blocked';
  return 'error';
}

export interface ExamplePick {
  post: SamplePost;
  coverUrl: string | null;
}

/** Top posts by views for one tag. Needs an author and a post time, which the site requires of a sample row. */
export function pickExamples(items: any[], tag: string, n = TRENDS_EXAMPLES_PER_TAG): ExamplePick[] {
  const picks: ExamplePick[] = [];
  for (const item of items) {
    const post = mapSampleItem(item, tag);
    if (!post || !post.author || post.createTime === null || post.playCount <= 0) continue;
    picks.push({ post, coverUrl: coverUrlOf(item) });
  }
  return picks
    .sort((a, b) => b.post.playCount - a.post.playCount || a.post.id.localeCompare(b.post.id))
    .slice(0, n);
}

/** Top tags by their position in the merged first-period list, distinct. */
export function pickSampleTags(hashtags: TrendHashtag[], period: number, n: number): string[] {
  const best = new Map<string, number>();
  for (const h of hashtags) {
    if (h.period !== period) continue;
    const cur = best.get(h.tag);
    if (cur === undefined || h.mergedRank < cur) best.set(h.tag, h.mergedRank);
  }
  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([tag]) => tag);
}

/** Bytes pre-authorised for the Creative Center lists: overall + every industry, per period. */
export function listBytesEstimate(periods: number): number {
  return periods * (CC_INDUSTRIES.length + 1) * CC_LIST_BYTES_ESTIMATE;
}

class ListDeadlineError extends Error {
  override name = 'ListDeadlineError';
}

/** 429 and 5xx from the Creative Center: it is shedding load, so waiting helps and hammering does not. */
export function isThrottled(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/** Exponential from 1s, capped at 8s, jittered to 50-100% so sibling runs do not retry in lockstep. */
export function backoffMs(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + random * 0.5));
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchListOnce(
  deps: TrendsDeps,
  period: number,
  industryId: string | null,
  deadline: number,
): Promise<any[]> {
  let lastError: unknown = null;
  let attempt = 0;
  while (true) {
    attempt++;
    if (deps.now().getTime() >= deadline) throw lastError ?? new ListDeadlineError('list deadline passed');
    try {
      return await deps.fetchHashtagList(period, industryId);
    } catch (err) {
      lastError = err;
      if (errorCode(err) === 'budget') throw err;
      if (!isThrottled(err)) {
        if (attempt >= MAX_PLAIN_ATTEMPTS) throw err;
        continue;
      }
      if (attempt >= MAX_THROTTLED_ATTEMPTS) throw err;
      const wait = backoffMs(attempt, (deps.random ?? Math.random)());
      // A wait that would run past the list deadline is a retry that cannot happen.
      if (deps.now().getTime() + wait >= deadline) throw err;
      await (deps.sleep ?? realSleep)(wait);
    }
  }
}

interface ListTally {
  ok: number;
  failed: number;
  total: number;
  lastStatus: string;
}

/** The one line a run writes about its Creative Center lists, in place of a warn per failed category. */
function logListSummary(tally: ListTally, outcome: 'done' | 'breaker' | 'deadline' | 'overall-failed' | 'budget'): void {
  const skipped = tally.total - tally.ok - tally.failed;
  const line =
    `[tools-trends] lists ${outcome}: ok=${tally.ok} failed=${tally.failed} skipped=${skipped} of ${tally.total}, last failure: ${tally.lastStatus}`;
  if (outcome === 'done' && tally.failed === 0) console.log(line);
  else console.warn(line);
}

export async function runTrends(payload: TrendsPayload, deps: TrendsDeps): Promise<TrendsOutcome> {
  const started = deps.now().getTime();
  const listDeadline = started + TRENDS_LIST_DEADLINE_MS;
  const sampleDeadline = started + TRENDS_SAMPLE_DEADLINE_MS;
  // The ceiling is checked before the first byte of network use: a breach
  // costs nothing and the Worker serves its fallback.
  try {
    await deps.assertBudget(listBytesEstimate(payload.periods.length) + payload.sampleTags * TRENDS_SAMPLE_BYTES_PER_TAG);
  } catch (err) {
    return { status: 'failed', code: errorCode(err) };
  }

  // The overall list per period is the product: if one is unreadable the run
  // fails and the Worker keeps serving the previous snapshot. An industry list
  // that fails after its retry is skipped (that niche just has fewer tags),
  // but several in a row or a passed list deadline mean the source is
  // degraded: fail rather than ship a thin ranking over a good snapshot.
  const results: ListResult[] = [];
  let consecutiveListFailures = 0;
  const tally: ListTally = {
    ok: 0,
    failed: 0,
    total: payload.periods.length * (CC_INDUSTRIES.length + 1),
    lastStatus: 'none',
  };
  for (const period of payload.periods) {
    const scopes: Array<{ scope: string; id: string | null }> = [
      { scope: 'overall', id: null },
      ...CC_INDUSTRIES.map((i) => ({ scope: i.name, id: i.id })),
    ];
    for (const { scope, id } of scopes) {
      if (deps.now().getTime() >= listDeadline) {
        logListSummary(tally, 'deadline');
        return { status: 'failed', code: 'source' };
      }
      try {
        results.push({ period, scope, items: await fetchListOnce(deps, period, id, listDeadline) });
        tally.ok++;
        consecutiveListFailures = 0;
      } catch (err) {
        consecutiveListFailures++;
        tally.failed++;
        tally.lastStatus = `${scope}/${period}d ${(err as Error).message}`;
        if (errorCode(err) === 'budget') {
          logListSummary(tally, 'budget');
          return { status: 'failed', code: 'budget' };
        }
        if (id === null) {
          logListSummary(tally, 'overall-failed');
          return { status: 'failed', code: 'source' };
        }
        // Breaker: the source keeps refusing, so stop here and let the next cron run try again.
        if (consecutiveListFailures >= MAX_CONSECUTIVE_LIST_FAILURES) {
          logListSummary(tally, 'breaker');
          return { status: 'failed', code: 'source' };
        }
      }
    }
  }
  logListSummary(tally, 'done');
  const hashtags = mapHashtagLists(results, payload.periods);
  if (!hashtags.length) return { status: 'failed', code: 'source' };

  const samplePosts: SamplePost[] = [];
  const examples = new Map<string, ExamplePick>();
  const tags = pickSampleTags(hashtags, payload.periods[0]!, payload.sampleTags);
  let sampledTags = 0;
  let consecutiveFailures = 0;
  for (const tag of tags) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_SAMPLE_FAILURES) break;
    if (deps.now().getTime() >= sampleDeadline) {
      console.warn(`[tools-trends] sample deadline ${TRENDS_SAMPLE_DEADLINE_MS}ms passed; shipping ${sampledTags} sampled tags`);
      break;
    }
    try {
      const challengeId = await deps.resolveChallengeId(tag);
      if (!challengeId) throw new Error(`no challenge id for #${tag}`);
      const items = await deps.fetchTagPosts(tag, challengeId, TRENDS_SAMPLE_POSTS_PER_TAG);
      const posts = items.map((i) => mapSampleItem(i, tag)).filter((p): p is SamplePost => p !== null);
      if (posts.length) {
        samplePosts.push(...posts);
        for (const pick of pickExamples(items, tag)) if (!examples.has(pick.post.id)) examples.set(pick.post.id, pick);
        sampledTags++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    } catch (err) {
      consecutiveFailures++;
      console.warn(`[tools-trends] sample #${tag} failed: ${(err as Error).message}`);
      // The byte ledger says stop; do not keep fetching past it.
      if (errorCode(err) === 'budget') break;
    }
  }

  // Covers are best effort and never fail the run: an example without a stored cover renders a placeholder.
  const exampleIds = [...examples.keys()];
  let covers: string[] = [];
  if (deps.uploadCovers && examples.size) {
    const targets: AuthoredCoverTarget[] = [...examples.values()].flatMap((e) =>
      e.coverUrl ? [{ id: e.post.id, url: e.coverUrl, author: e.post.author as string }] : [],
    );
    try {
      const stored = new Set(await deps.uploadCovers(targets));
      covers = exampleIds.filter((id) => stored.has(id));
    } catch (err) {
      console.warn(`[tools-trends] cover upload failed: ${(err as Error).message}`);
    }
  }

  // The ranking is the product; a thin or empty sample ships as-is and the
  // Worker's page copy states the sample size it actually got.
  return {
    status: 'done',
    sampledTags,
    body: { takenAt: deps.now().toISOString(), country: 'US', hashtags, samplePosts, exampleIds, covers },
  };
}
