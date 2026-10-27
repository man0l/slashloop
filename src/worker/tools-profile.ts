// ---------------------------------------------------------------------------
// `tools-profile` — the full profile analysis behind slashloop.dev/tools creator
// pages (SLA-1058). Same lookup plumbing and callback as `tools-profile-lite`
// (tools-jobs.ts); this file only owns the shaping of 30 posts into the numbers
// the page shows. The result never carries a TikTok CDN URL: ids and text only,
// thumbnails come from oEmbed on the site.
// ---------------------------------------------------------------------------

import { webItemToApifyShape, type CreatorIdentity } from '../lib/scrapers/tiktok-web.js';
import {
  classifyProfileMiss,
  classifyToolsError,
  type ProfileLiteDeps,
  type ToolsErrorCode,
} from './tools-jobs.js';

/** Pre-authorised bytes for one full profile lookup (measured ~3.5 MB with recent posts). */
export const PROFILE_ESTIMATE_BYTES = 4 * 1024 * 1024;
export const PROFILE_POST_LIMIT = 30;
/** Video pages read to fill likes/comments/shares/sound on embed rows (~85KB each on the wire). */
export const PROFILE_HYDRATE_PAGES = 10;
/** Posts with known engagement needed before an engagement rate is shown. */
export const MIN_ENGAGEMENT_POSTS = 3;
export const OUTLIER_MULTIPLE = 3;
export const CAPTION_MAX = 140;
const EASTERN = 'America/New_York';

export type ProfileReason = 'lookup' | 'refresh' | 'seed';

export interface ProfilePost {
  id: string;
  postedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  isPhotoPost: boolean;
  caption: string;
  soundTitle: string | null;
}

export interface ProfileResult {
  handle: string;
  followers: number | null;
  following: number | null;
  /** Account-wide hearts, when the user detail carries it. */
  totalLikes: number | null;
  sampled: number;
  /** Posts whose likes/comments/shares were read; the averages and rates use only these. */
  statsSampled: number;
  avgLikes: number;
  avgComments: number;
  avgShares: number;
  avgViews: number;
  avgEngagement: number;
  erByFollowers: number | null;
  erByViews: number | null;
  medianViews: number;
  /** Posts at >= OUTLIER_MULTIPLE x the median, highest multiple first. */
  outliers: Array<{ id: string; views: number; multiple: number }>;
  /** Posts per week across the sampled window. Null under 2 dated posts. */
  postsPerWeek: number | null;
  windowDays: number | null;
  /** Top 3 posting hours, US Eastern (0-23), by average views. */
  bestHours: Array<{ hour: number; posts: number; avgViews: number }>;
  topHashtags: Array<{ tag: string; count: number }>;
  topSounds: Array<{ title: string; count: number }>;
  /** Newest first, up to PROFILE_POST_LIMIT. */
  posts: ProfilePost[];
  takenAt: string;
}

export type ProfileOutcome =
  | { status: 'done'; result: ProfileResult }
  | { status: 'failed'; code: ToolsErrorCode };

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
};

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function captionOf(item: any): string {
  const text = typeof item?.desc === 'string' ? item.desc : '';
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, CAPTION_MAX).join('');
}

function hashtagsOf(item: any): string[] {
  const out = new Set<string>();
  for (const e of Array.isArray(item?.textExtra) ? item.textExtra : []) {
    const name = typeof e?.hashtagName === 'string' ? e.hashtagName : '';
    if (name) out.add(name.toLowerCase());
  }
  if (!out.size) {
    for (const c of Array.isArray(item?.challenges) ? item.challenges : []) {
      const name = typeof c?.title === 'string' ? c.title : '';
      if (name) out.add(name.toLowerCase());
    }
  }
  return [...out];
}

function postFromItem(item: any): ProfilePost | null {
  const id = item?.id ?? item?.video?.id;
  if (id == null || String(id) === '') return null;
  const s = item?.stats ?? item?.statsV2 ?? {};
  const created = Number(item?.createTime);
  const title = typeof item?.music?.title === 'string' ? item.music.title.trim() : '';
  return {
    id: String(id),
    postedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
    views: count(s.playCount),
    likes: count(s.diggCount),
    comments: count(s.commentCount),
    shares: count(s.shareCount),
    isPhotoPost: webItemToApifyShape(item).postKind === 'slideshow',
    caption: captionOf(item),
    soundTitle: title || null,
  };
}

const easternHour = new Intl.DateTimeFormat('en-US', { timeZone: EASTERN, hour: 'numeric', hourCycle: 'h23' });

function rankCounts(map: Map<string, number>, top: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

export function shapeProfile(identity: Pick<CreatorIdentity, 'followers' | 'following' | 'totalLikes'>, handle: string, items: any[], now: Date): ProfileResult {
  const seen = new Set<string>();
  const rows: Array<{ post: ProfilePost; tags: string[] }> = [];
  for (const item of items) {
    const post = postFromItem(item);
    if (!post || seen.has(post.id)) continue;
    seen.add(post.id);
    rows.push({ post, tags: hashtagsOf(item) });
  }
  // Pinned posts lead the list regardless of age; the sample is "latest N".
  rows.sort((a, b) => (b.post.postedAt ?? '').localeCompare(a.post.postedAt ?? ''));
  const sample = rows.slice(0, PROFILE_POST_LIMIT);
  const posts = sample.map((r) => r.post);
  const n = posts.length;
  const sum = (pick: (p: ProfilePost) => number) => posts.reduce((t, p) => t + pick(p), 0);
  // Embed rows carry views only; counting their missing likes as 0 would publish a 0% rate.
  const known = posts.filter((p) => p.likes + p.comments + p.shares > 0);
  const k = known.length;
  const sumKnown = (pick: (p: ProfilePost) => number) => known.reduce((t, p) => t + pick(p), 0);
  const likes = sumKnown((p) => p.likes);
  const comments = sumKnown((p) => p.comments);
  const shares = sumKnown((p) => p.shares);
  const views = sum((p) => p.views);
  const knownViews = sumKnown((p) => p.views);
  const engagement = likes + comments + shares;
  const enough = k >= MIN_ENGAGEMENT_POSTS;
  const avgEngagement = k ? engagement / k : 0;
  const medianViews = median(posts.map((p) => p.views));

  const outliers = medianViews > 0
    ? posts
        .filter((p) => p.views >= OUTLIER_MULTIPLE * medianViews)
        .map((p) => ({ id: p.id, views: p.views, multiple: round(p.views / medianViews, 1) }))
        .sort((a, b) => b.views - a.views)
    : [];

  const times = posts.map((p) => (p.postedAt ? Date.parse(p.postedAt) : NaN)).filter(Number.isFinite);
  let postsPerWeek: number | null = null;
  let windowDays: number | null = null;
  if (times.length >= 2) {
    const spanDays = Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400_000);
    windowDays = round(spanDays, 1);
    postsPerWeek = round(((times.length - 1) / spanDays) * 7, 1);
  }

  const byHour = new Map<number, { posts: number; views: number }>();
  for (const p of posts) {
    if (!p.postedAt) continue;
    const hour = Number(easternHour.format(new Date(p.postedAt)));
    const slot = byHour.get(hour) ?? { posts: 0, views: 0 };
    slot.posts += 1;
    slot.views += p.views;
    byHour.set(hour, slot);
  }
  let hours = [...byHour.entries()].map(([hour, v]) => ({ hour, posts: v.posts, avgViews: round(v.views / v.posts, 0) }));
  // One post is noise: rank hours with at least two, falling back to all when none qualify.
  if (hours.some((h) => h.posts >= 2)) hours = hours.filter((h) => h.posts >= 2);
  const bestHours = hours.sort((a, b) => b.avgViews - a.avgViews || b.posts - a.posts || a.hour - b.hour).slice(0, 3);

  const tags = new Map<string, number>();
  for (const r of sample) for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  const sounds = new Map<string, number>();
  for (const p of posts) if (p.soundTitle) sounds.set(p.soundTitle, (sounds.get(p.soundTitle) ?? 0) + 1);

  const followers = identity.followers;
  return {
    handle,
    followers,
    following: identity.following ?? null,
    totalLikes: identity.totalLikes ?? null,
    sampled: n,
    statsSampled: k,
    avgLikes: k ? round(likes / k, 1) : 0,
    avgComments: k ? round(comments / k, 1) : 0,
    avgShares: k ? round(shares / k, 1) : 0,
    avgViews: n ? round(views / n, 1) : 0,
    avgEngagement: round(avgEngagement, 1),
    erByFollowers: enough && followers && followers > 0 ? round((avgEngagement / followers) * 100, 2) : null,
    erByViews: enough && knownViews > 0 ? round((engagement / knownViews) * 100, 2) : null,
    medianViews: round(medianViews, 0),
    outliers,
    postsPerWeek,
    windowDays,
    bestHours,
    topHashtags: rankCounts(tags, 5).map(([tag, c]) => ({ tag, count: c })),
    topSounds: rankCounts(sounds, 3).map(([title, c]) => ({ title, count: c })),
    posts,
    takenAt: now.toISOString(),
  };
}

export async function runProfile(handle: string, deps: ProfileLiteDeps): Promise<ProfileOutcome> {
  try {
    await deps.assertBudget(PROFILE_ESTIMATE_BYTES);
  } catch (err) {
    return { status: 'failed', code: classifyToolsError(err) };
  }
  try {
    let identity: Pick<CreatorIdentity, 'followers' | 'following' | 'totalLikes'> | null = null;
    let items: any[] = [];
    // Embed first: one ~40KB read for counts + posts, no profile page needed.
    const embed = deps.fetchEmbed ? await deps.fetchEmbed(handle, PROFILE_POST_LIMIT) : null;
    if (embed?.items.length) {
      identity = embed.identity;
      items = embed.items;
    } else {
      const resolved = await deps.resolveCreator(handle);
      if (!resolved) return { status: 'failed', code: classifyProfileMiss(deps.probe()) };
      identity = resolved;
      items = await deps.fetchPosts(resolved, PROFILE_POST_LIMIT);
    }
    if (items.length === 0) return { status: 'failed', code: 'not_found' };
    if (deps.hydrate) items = await deps.hydrate(items).catch(() => items);
    return { status: 'done', result: shapeProfile(identity, handle, items, deps.now()) };
  } catch (err) {
    return { status: 'failed', code: classifyToolsError(err) };
  }
}
