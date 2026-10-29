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

async function fetchListOnce(deps: TrendsDeps, period: number, industryId: string | null): Promise<any[]> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await deps.fetchHashtagList(period, industryId);
    } catch (err) {
      lastError = err;
      if (errorCode(err) === 'budget') break;
    }
  }
  throw lastError;
}

export async function runTrends(payload: TrendsPayload, deps: TrendsDeps): Promise<TrendsOutcome> {
  // The ceiling is checked before the first byte of network use: a breach
  // costs nothing and the Worker serves its fallback.
  try {
    await deps.assertBudget(listBytesEstimate(payload.periods.length) + payload.sampleTags * TRENDS_SAMPLE_BYTES_PER_TAG);
  } catch (err) {
    return { status: 'failed', code: errorCode(err) };
  }

  // The overall list per period is the product: if one is unreadable the run
  // fails and the Worker keeps serving the previous snapshot. An industry list
  // that fails after its retry is skipped (that niche just has fewer tags).
  const results: ListResult[] = [];
  for (const period of payload.periods) {
    const scopes: Array<{ scope: string; id: string | null }> = [
      { scope: 'overall', id: null },
      ...CC_INDUSTRIES.map((i) => ({ scope: i.name, id: i.id })),
    ];
    for (const { scope, id } of scopes) {
      try {
        results.push({ period, scope, items: await fetchListOnce(deps, period, id) });
      } catch (err) {
        console.warn(`[tools-trends] list ${scope}/${period}d failed: ${(err as Error).message}`);
        if (id === null || errorCode(err) === 'budget') {
          return { status: 'failed', code: errorCode(err) === 'budget' ? 'budget' : 'source' };
        }
      }
    }
  }
  const hashtags = mapHashtagLists(results, payload.periods);
  if (!hashtags.length) return { status: 'failed', code: 'source' };

  const samplePosts: SamplePost[] = [];
  const examples = new Map<string, ExamplePick>();
  const tags = pickSampleTags(hashtags, payload.periods[0]!, payload.sampleTags);
  let sampledTags = 0;
  let consecutiveFailures = 0;
  for (const tag of tags) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_SAMPLE_FAILURES) break;
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
