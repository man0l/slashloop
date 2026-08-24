// ---------------------------------------------------------------------------
// Keyword-driven source discovery — the "paste a niche, get trackable
// sources" funnel shared by the MCP `discover` tool and the site's Discover
// screen. Two halves, mirroring suggestions.ts:
//
//   1. expandDiscoverySeeds(keywords) — fast. One Gemini call expands the
//      user's keywords/hashtags/handles into seed hashtags + keywords. No
//      scraping, so it returns immediately.
//   2. mineDiscoverSeed(seed) — one small probe scrape (MINE_SCRAPE_LIMIT
//      videos) per seed, per call. From the sampled captions it mines the
//      hashtags people actually post under and the creators actually posting,
//      each with view evidence. On Vercel this enqueues a `discover` MediaJob
//      for the Contabo proxy scraper and waits; the worker scrapes inline.
//
// The split is deliberate — same reason suggestions.ts is split: a combined
// call waits on the slowest of several real scrapes and used to time the
// endpoint out. Callers fire one mine per seed and render each as it lands.
//
// The model NEVER proposes creator handles — a plausible-sounding made-up
// handle is the worst hallucination here, and no prompt fix guarantees against
// it. Creators only ever come from probe-scrape evidence. Nothing is
// persisted: a suggestion is data in a response until the user tracks it
// through the normal create_source path.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { callModelText } from './llm.js';
import { normalizeQuery } from './canonical-query.js';
import { scrapeCapKind, scrapeSource, trafficStatus } from './scrapers/index.js';
import { getApifyCapStatus } from './spend-cap.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, creditBalance } from './credits.js';
import {
  DISCOVER_JOB_DEADLINE_MS, enqueueDiscoverJob, parseDiscoverJobPayload, type MediaJobRow,
} from './jobs.js';
import type { NormalizedVideo } from '../normalizers.js';

/** Input keywords/hashtags/handles accepted in one discover run. */
export const MAX_INPUT_KEYWORDS = 8;
/** Total seeds probed per run (inputs first, AI fills the remaining slots). Bounds worst-case spend. */
export const MAX_SEEDS = 6;
/** Small probe, not a real refresh — enough caption data to mine, not a paid pull. */
export const MINE_SCRAPE_LIMIT = 5;

export interface DiscoverySeed {
  sourceType: 'hashtag' | 'keyword' | 'creator';
  query: string;
  rationale: string;
  origin: 'input' | 'ai';
  /** True when this exact source is already tracked — probed anyway when the
   * user typed it themselves (explicit intent), but flagged so callers can
   * render it as "already tracked". */
  alreadyTracked?: boolean;
}

export interface DiscoverySeedResult {
  ok: boolean;
  seeds: DiscoverySeed[];
  /** AI-proposed candidates dropped because the exact source is already tracked. */
  alreadyTrackedCount: number;
  /** AI-proposed candidates dropped because this workspace previously dismissed them. */
  alreadyDismissedCount: number;
  creditsCharged: number;
  creditsRemaining: number;
  errors: string[];
}

export interface MinedHashtag {
  query: string;
  videoCount: number;
  avgViews: number;
  sampleCaption: string;
}

export interface MinedCreator {
  query: string;
  videoCount: number;
  medianViews: number;
  followers: number | null;
  sampleCaption: string;
}

export interface MinedSound {
  query: string;
  title: string;
  author: string;
  videoCount: number;
  avgViews: number;
}

export interface SeedMineResult {
  /** false only for an unexpected error — cap breaches, insufficient credits
   * and "no real content found" are ok:true with verified:false, all normal
   * outcomes rather than failures (same contract as verifySourceCandidate). */
  ok: boolean;
  verified: boolean;
  seed: DiscoverySeed;
  sampleCount: number;
  topViews: number;
  hashtags: MinedHashtag[];
  creators: MinedCreator[];
  sounds: MinedSound[];
  creditsCharged: number;
  creditsRemaining: number;
  error?: string;
}

/** AI may only propose things TikTok can be probed against without a handle —
 * creators come exclusively from mined scrape evidence. */
const AI_SEED_SCHEMA = z.array(z.object({
  sourceType: z.enum(['hashtag', 'keyword']),
  query: z.string().min(1),
  rationale: z.string(),
})).max(MAX_INPUT_KEYWORDS);

const DISCOVER_SYSTEM = `You are a TikTok content-discovery strategist. The user gives a few niche keywords, hashtags, or creator handles describing an area they want to research. Expand that niche into the specific hashtags and search keywords that creators in it actually post under.

Prefer concrete community tags over generic ones — "saunas" beats "wellness", "silentrehearsal" beats "music". Prefer terms a real audience would type or tap, not marketing-speak. Do NOT propose creator handles: handles are mined from real TikTok data later, and a plausible-sounding but made-up handle just wastes the check.

Output raw JSON array, up to 8 items: [{"sourceType": "hashtag"|"keyword", "query": "string, no # prefix, lowercase, no spaces for hashtags", "rationale": "one sentence on why this seed fits the niche"}]`;

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests.
// ---------------------------------------------------------------------------

/** Hashtags in a caption, lowercased, deduped within the caption. */
export function extractHashtags(caption: string): string[] {
  const matches = caption.matchAll(/#([\p{L}\p{N}_]+)/gu);
  return [...new Set([...matches].map(m => m[1].toLowerCase()))];
}

/** Middle value of an unsorted list — a couple of viral flukes shouldn't
 * crown a creator whose other posts are quiet. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** `["@Coach", "#GymTok", "home workout"]` → typed seeds, normalized + deduped. */
export function parseDiscoveryInput(keywords: string[]): DiscoverySeed[] {
  const seeds: DiscoverySeed[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const sourceType: DiscoverySeed['sourceType'] = trimmed.startsWith('@') ? 'creator' : trimmed.startsWith('#') ? 'hashtag' : 'keyword';
    const query = normalizeQuery(sourceType, trimmed);
    if (!query) continue;
    const key = `${sourceType}:${query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ sourceType, query, rationale: 'Typed by the user.', origin: 'input' });
    if (seeds.length >= MAX_INPUT_KEYWORDS) break;
  }
  return seeds;
}

/** Build the suggestion lists from per-seed mines. Pure: callers pass the
 * tracked/dismissed key sets so this stays unit-testable without a DB. */
export function aggregateDiscovery(
  mines: SeedMineResult[],
  excludedKeys: Set<string>,
): { hashtags: MinedHashtag[]; creators: MinedCreator[]; sounds: MinedSound[]; totalSampled: number } {
  const verified = mines.filter(m => m.verified);
  const totalSampled = verified.reduce((sum, m) => sum + m.sampleCount, 0);
  const seedKeys = new Set(mines.map(m => `${m.seed.sourceType}:${m.seed.query}`));

  // Hashtags: merge counts across seeds, keep the highest-view sample caption.
  const tags = new Map<string, { videoCount: number; totalViews: number; topViews: number; sampleCaption: string }>();
  for (const mine of verified) {
    for (const tag of mine.hashtags) {
      const excluded = excludedKeys.has(`hashtag:${tag.query}`) || seedKeys.has(`hashtag:${tag.query}`);
      if (excluded) continue;
      const acc = tags.get(tag.query) ?? { videoCount: 0, totalViews: 0, topViews: 0, sampleCaption: '' };
      acc.videoCount += tag.videoCount;
      acc.totalViews += tag.videoCount * tag.avgViews;
      // Keep the caption from the strongest occurrence that has one.
      if (tag.sampleCaption && (acc.videoCount === tag.videoCount || tag.avgViews > acc.topViews)) {
        acc.topViews = tag.avgViews;
        acc.sampleCaption = tag.sampleCaption;
      }
      tags.set(tag.query, acc);
    }
  }
  const hashtags: MinedHashtag[] = [...tags.entries()]
    .map(([query, acc]) => ({ query, videoCount: acc.videoCount, avgViews: Math.round(acc.totalViews / acc.videoCount), sampleCaption: acc.sampleCaption }))
    .sort((a, b) => b.videoCount - a.videoCount || b.avgViews - a.avgViews);

  // Creators: merge appearances across seeds, keep the best follower count.
  const handles = new Map<string, { videoCount: number; views: number[]; followers: number | null; sampleCaption: string }>();
  for (const mine of verified) {
    for (const creator of mine.creators) {
      const excluded = excludedKeys.has(`creator:${creator.query}`) || seedKeys.has(`creator:${creator.query}`);
      if (excluded) continue;
      const acc = handles.get(creator.query) ?? { videoCount: 0, views: [], followers: null, sampleCaption: '' };
      acc.videoCount += creator.videoCount;
      acc.views.push(creator.medianViews);
      acc.followers = Math.max(acc.followers ?? 0, creator.followers ?? 0) || creator.followers;
      if (!acc.sampleCaption) acc.sampleCaption = creator.sampleCaption;
      handles.set(creator.query, acc);
    }
  }
  const creators: MinedCreator[] = [...handles.entries()]
    .map(([query, acc]) => ({ query, videoCount: acc.videoCount, medianViews: median(acc.views), followers: acc.followers, sampleCaption: acc.sampleCaption }))
    .sort((a, b) => b.medianViews - a.medianViews || b.videoCount - a.videoCount);

  const soundMap = new Map<string, { title: string; author: string; videoCount: number; totalViews: number }>();
  for (const mine of verified) {
    for (const sound of mine.sounds ?? []) {
      const acc = soundMap.get(sound.query) ?? { title: sound.title, author: sound.author, videoCount: 0, totalViews: 0 };
      acc.videoCount += sound.videoCount;
      acc.totalViews += sound.videoCount * sound.avgViews;
      if (sound.title && !acc.title) acc.title = sound.title;
      soundMap.set(sound.query, acc);
    }
  }
  const sounds: MinedSound[] = [...soundMap.entries()]
    .map(([query, acc]) => ({
      query, title: acc.title, author: acc.author,
      videoCount: acc.videoCount, avgViews: Math.round(acc.totalViews / acc.videoCount),
    }))
    .sort((a, b) => b.videoCount - a.videoCount || b.avgViews - a.avgViews);

  return { hashtags, creators, sounds, totalSampled };
}

// ---------------------------------------------------------------------------
// Step 1 — expand keywords into seeds (one Gemini call, no scraping).
// ---------------------------------------------------------------------------

const MAX_AI_SEEDS = 8;

/** Strict `sourceType:normalizedQuery` keys for what the workspace already
 * tracks or has dismissed — shared by seed expansion and suggestion
 * aggregation so both filter with the exact same keys. */
export async function loadExclusionSets(workspaceId: string) {
  const [sources, dismissals] = await Promise.all([
    db.source.findMany({ where: { workspaceId }, select: { sourceType: true, query: true } }),
    db.suggestionDismissal.findMany({ where: { workspaceId }, select: { sourceType: true, query: true } }),
  ]);
  return {
    trackedKeys: new Set(sources.map(s => `${s.sourceType}:${normalizeQuery(s.sourceType, s.query)}`)),
    dismissedKeys: new Set(dismissals.map(d => `${d.sourceType}:${d.query}`)),
  };
}

export async function expandDiscoverySeeds(workspace: Workspace, keywords: string[]): Promise<DiscoverySeedResult> {
  const balanceBefore = await creditBalance(workspace.id);
  const fail = (errors: string[], creditsRemaining = balanceBefore.total, creditsCharged = 0): DiscoverySeedResult => ({
    ok: false, seeds: [], alreadyTrackedCount: 0, alreadyDismissedCount: 0, creditsCharged, creditsRemaining, errors,
  });

  const inputSeeds = parseDiscoveryInput(keywords);
  if (inputSeeds.length === 0) {
    return fail(['No usable keywords — pass terms, #hashtags or @handles (non-empty, after trimming #/@ prefixes).']);
  }

  const { trackedKeys, dismissedKeys } = await loadExclusionSets(workspace.id);
  // Inputs are explicit user intent — probe them even if an identical source
  // is already tracked (flag it instead), so "discover around what I track"
  // works. AI candidates get no such trust.
  for (const seed of inputSeeds) {
    if (trackedKeys.has(`${seed.sourceType}:${seed.query}`)) seed.alreadyTracked = true;
  }
  const selected = inputSeeds.slice(0, MAX_SEEDS);
  const selectedKeys = new Set(selected.map(s => `${s.sourceType}:${s.query}`));

  // Slots left for AI. With inputs alone filling the cap there is nothing for
  // the model to add — skip the call and the charge entirely.
  const slots = MAX_SEEDS - selected.length;
  let rawAi: z.infer<typeof AI_SEED_SCHEMA> = [];
  let alreadyTrackedCount = 0;
  let alreadyDismissedCount = 0;
  let creditsCharged = 0;

  if (slots > 0) {
    const opId = randomUUID();
    try {
      await debitCredits(workspace.id, CREDIT_COSTS.discoverSeeds, 'discover_seeds', `${opId}:preauth`);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) return fail([err.message], err.remaining);
      throw err;
    }

    try {
      const userMessage = `## The user's niche inputs\n${inputSeeds.map(s => `${s.sourceType}: ${s.query}`).join('\n')}\n\n`
        + `## Already tracked or previously rejected (do not re-propose)\n`
        + `${[...trackedKeys, ...dismissedKeys].join(', ') || '(none)'}\n\n`
        + `Expand the niche into up to ${MAX_AI_SEEDS} seed hashtags/keywords to probe on TikTok.`;
      const { parsed } = await callModelText(DISCOVER_SYSTEM, userMessage);
      const result = AI_SEED_SCHEMA.safeParse(parsed);
      if (!result.success) throw new Error('Model returned seeds in an unexpected shape');
      rawAi = result.data;
    } catch (err) {
      await refundCredits(workspace.id, CREDIT_COSTS.discoverSeeds, 'discover_seeds', `${opId}:fail`, 'call_failed');
      const balance = await creditBalance(workspace.id);
      return fail([`Seed expansion failed: ${(err as Error).message}`], balance.total);
    }

    for (const candidate of rawAi) {
      if (selected.length >= MAX_SEEDS) break;
      const query = normalizeQuery(candidate.sourceType, candidate.query);
      if (!query) continue;
      const key = `${candidate.sourceType}:${query}`;
      if (selectedKeys.has(key)) continue;
      if (trackedKeys.has(key)) { alreadyTrackedCount++; continue; }
      if (dismissedKeys.has(key)) { alreadyDismissedCount++; continue; }
      selectedKeys.add(key);
      selected.push({ sourceType: candidate.sourceType, query, rationale: candidate.rationale, origin: 'ai' });
    }

    const balanceAfter = await creditBalance(workspace.id);
    creditsCharged = balanceBefore.total - balanceAfter.total;
  }

  const balanceEnd = await creditBalance(workspace.id);
  return {
    ok: true,
    seeds: selected,
    alreadyTrackedCount,
    alreadyDismissedCount,
    creditsCharged,
    creditsRemaining: balanceEnd.total,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Step 2 — probe one seed and mine hashtags/creators from the samples.
//
// Production API (Vercel) cannot scrape TikTok: no residential proxy, and
// Apify's token is not the live path. Refresh already queues a MediaJob for
// the Contabo scraper worker (SCRAPER_PROVIDER=proxy). Discover mines do
// the same — enqueue, the scraper runs the probe, the waiting call reads
// the result off the job. Local / the worker itself still scrape inline.
// ---------------------------------------------------------------------------

/** How long the API/MCP call will wait for the scraper worker. Inside the
 *  60s Vercel maxDuration with a few seconds of spare. */
export const DISCOVER_WAIT_MS = 50_000;
const DISCOVER_POLL_MS = 1_000;

/**
 * Queue the probe onto the Contabo scraper when this process cannot (or
 * should not) scrape itself.
 *
 *  - Vercel production sets WORKER_URL and has no proxy → queue.
 *  - The scraper worker (WORKER_KINDS includes discover/refresh) IS the
 *    thing that scrapes → never queue from here, or we'd deadlock waiting
 *    on a job only this process can claim.
 *  - Local without WORKER_URL scrapes inline (Apify or proxy, whatever is
 *    configured).
 */
export function shouldQueueDiscoverMine(): boolean {
  const kinds = (process.env.WORKER_KINDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (kinds.includes('discover') || kinds.includes('refresh')) return false;
  return Boolean(process.env.WORKER_URL?.trim() || process.env.WORKER_ACTIVE?.trim());
}

/** Pure: turn sampled videos into mined hashtags + creators. */
export function mineFromItems(seed: DiscoverySeed, items: NormalizedVideo[]): {
  verified: boolean;
  sampleCount: number;
  topViews: number;
  hashtags: MinedHashtag[];
  creators: MinedCreator[];
  sounds: MinedSound[];
} {
  if (items.length === 0) {
    return { verified: false, sampleCount: 0, topViews: 0, hashtags: [], creators: [], sounds: [] };
  }

  const ranked = [...items].sort((a, b) => b.views - a.views);
  const topViews = ranked[0].views;
  const seedHashtagKey = seed.sourceType === 'hashtag' ? seed.query : null;

  const tagAcc = new Map<string, { videoCount: number; totalViews: number; sampleCaption: string }>();
  for (const item of ranked) {
    for (const tag of extractHashtags(item.caption)) {
      if (tag === seedHashtagKey) continue;
      const acc = tagAcc.get(tag) ?? { videoCount: 0, totalViews: 0, sampleCaption: '' };
      acc.videoCount += 1;
      acc.totalViews += item.views;
      if (!acc.sampleCaption) acc.sampleCaption = item.caption;
      tagAcc.set(tag, acc);
    }
  }
  const hashtags: MinedHashtag[] = [...tagAcc.entries()]
    .map(([query, acc]) => ({ query, videoCount: acc.videoCount, avgViews: Math.round(acc.totalViews / acc.videoCount), sampleCaption: acc.sampleCaption }))
    .sort((a, b) => b.videoCount - a.videoCount || b.avgViews - a.avgViews)
    .slice(0, 10);

  const creatorAcc = new Map<string, { views: number[]; followers: number | null; topCaption: string; topViews: number }>();
  for (const item of ranked) {
    const handle = item.creatorHandle.toLowerCase();
    if (!handle) continue;
    const acc = creatorAcc.get(handle) ?? { views: [], followers: null, topCaption: '', topViews: 0 };
    acc.views.push(item.views);
    acc.followers = Math.max(acc.followers ?? 0, item.creatorFollowers ?? 0) || item.creatorFollowers;
    if (item.views > acc.topViews) { acc.topViews = item.views; acc.topCaption = item.caption; }
    creatorAcc.set(handle, acc);
  }
  const creators: MinedCreator[] = [...creatorAcc.entries()]
    .filter(([handle, acc]) => acc.views.length >= 2 && handle !== seed.query)
    .map(([query, acc]) => ({ query, videoCount: acc.views.length, medianViews: median(acc.views), followers: acc.followers, sampleCaption: acc.topCaption }))
    .sort((a, b) => b.medianViews - a.medianViews)
    .slice(0, 5);

  const soundAcc = new Map<string, { title: string; author: string; videoCount: number; totalViews: number }>();
  for (const item of ranked) {
    const sound = item.sound;
    if (!sound?.id && !sound?.title) continue;
    const key = (sound.id || sound.title).toLowerCase();
    const acc = soundAcc.get(key) ?? { title: sound.title, author: sound.author, videoCount: 0, totalViews: 0 };
    acc.videoCount += 1;
    acc.totalViews += item.views;
    soundAcc.set(key, acc);
  }
  const sounds: MinedSound[] = [...soundAcc.entries()]
    .map(([query, acc]) => ({
      query, title: acc.title, author: acc.author,
      videoCount: acc.videoCount, avgViews: Math.round(acc.totalViews / acc.videoCount),
    }))
    .sort((a, b) => b.videoCount - a.videoCount || b.avgViews - a.avgViews)
    .slice(0, 8);

  return { verified: true, sampleCount: ranked.length, topViews, hashtags, creators, sounds };
}

function emptyMine(seed: DiscoverySeed, creditsRemaining: number, extra: Partial<SeedMineResult> = {}): SeedMineResult {
  return {
    ok: true, verified: false, seed, sampleCount: 0, topViews: 0,
    hashtags: [], creators: [], sounds: [], creditsCharged: 0, creditsRemaining,
    ...extra,
  };
}

function asSeedMineResult(seed: DiscoverySeed, raw: unknown): SeedMineResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SeedMineResult>;
  if (typeof r.ok !== 'boolean' || typeof r.verified !== 'boolean') return null;
  return {
    ok: r.ok,
    verified: r.verified,
    seed,
    sampleCount: typeof r.sampleCount === 'number' ? r.sampleCount : 0,
    topViews: typeof r.topViews === 'number' ? r.topViews : 0,
    hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
    creators: Array.isArray(r.creators) ? r.creators : [],
    sounds: Array.isArray(r.sounds) ? r.sounds : [],
    creditsCharged: typeof r.creditsCharged === 'number' ? r.creditsCharged : 0,
    creditsRemaining: typeof r.creditsRemaining === 'number' ? r.creditsRemaining : 0,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitForDiscoverJob(
  jobId: string,
  workspaceId: string,
  seed: DiscoverySeed,
  timeoutMs: number,
): Promise<SeedMineResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await db.mediaJob.findFirst({
      where: { id: jobId, workspaceId },
    }) as unknown as MediaJobRow | null;
    if (!job) return null;
    if (job.status === 'done') {
      const payload = parseDiscoverJobPayload(job.payloadJson);
      const parsed = asSeedMineResult(seed, payload.result);
      if (parsed) return parsed;
      const balance = await creditBalance(workspaceId);
      return emptyMine(seed, balance.total, {
        ok: false,
        error: 'Discover probe finished with no result.',
      });
    }
    if (job.status === 'failed') {
      const balance = await creditBalance(workspaceId);
      return emptyMine(seed, balance.total, {
        ok: false,
        error: job.lastError || 'Discover probe failed on the scraper worker.',
      });
    }
    await sleep(DISCOVER_POLL_MS);
  }
  return null;
}

/**
 * The scrape + mine body. Called inline locally, and by the scraper worker
 * for queued jobs. `alreadyDebited` is set when enqueue already took the
 * pre-auth (same opId), so a retry of this job does not charge twice.
 */
export async function runDiscoverMine(
  workspace: Workspace,
  seed: DiscoverySeed,
  opts?: { opId?: string; preAuthCredits?: number; alreadyDebited?: boolean },
): Promise<SeedMineResult> {
  const opId = opts?.opId ?? randomUUID();
  const preAuth = opts?.preAuthCredits ?? Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * MINE_SCRAPE_LIMIT);
  const balanceBefore = await creditBalance(workspace.id);

  if (!opts?.alreadyDebited) {
    try {
      await debitCredits(workspace.id, preAuth, 'discover_mine', `${opId}:preauth`);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return emptyMine(seed, err.remaining, { error: 'Out of credits.' });
      }
      throw err;
    }
  }

  try {
    const result = await scrapeSource({
      workspaceId: workspace.id,
      platform: 'tiktok',
      sourceType: seed.sourceType,
      query: seed.query,
      limit: MINE_SCRAPE_LIMIT,
      refId: `discover:${seed.sourceType}:${seed.query}`,
    });

    const actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * result.items.length);
    const refundAmount = preAuth - actualCredits;
    if (refundAmount > 0) {
      await refundCredits(workspace.id, refundAmount, 'discover_mine', `${opId}:settle`, 'usage_settlement');
    }
    const balanceAfter = await creditBalance(workspace.id);
    // When enqueue already debited, balanceBefore is post-debit so the
    // difference would under-count (often 0). The kept amount is what we
    // did not refund.
    const creditsCharged = opts?.alreadyDebited
      ? actualCredits
      : Math.max(0, balanceBefore.total - balanceAfter.total);
    const mined = mineFromItems(seed, result.items);

    return {
      ok: true,
      seed,
      creditsCharged,
      creditsRemaining: balanceAfter.total,
      ...mined,
    };
  } catch (err) {
    // The scrape itself threw (not just "0 results") — refund in full; this
    // seed never got a real judgment either way.
    await refundCredits(workspace.id, preAuth, 'discover_mine', `${opId}:fail`, 'call_failed');
    const balance = await creditBalance(workspace.id);
    return emptyMine(seed, balance.total, {
      ok: false,
      error: (err as Error).message,
    });
  }
}

export async function mineDiscoverSeed(workspace: Workspace, seed: DiscoverySeed): Promise<SeedMineResult> {
  // Queued mines run on the Contabo proxy scraper, which enforces its own
  // PROXY_TRAFFIC_CAP_GB. This process (Vercel) often has a different/default
  // cap, so we do not pre-check traffic here — a false breach would refuse a
  // probe the worker would have run.
  if (!shouldQueueDiscoverMine()) {
    if (scrapeCapKind('tiktok') === 'proxy') {
      const capStatus = await trafficStatus(workspace.id);
      if (capStatus.breached) {
        const balance = await creditBalance(workspace.id);
        return emptyMine(seed, balance.total, { error: 'Proxy traffic cap breached.' });
      }
    } else {
      const capStatus = await getApifyCapStatus(workspace.id);
      if (capStatus.breached) {
        const balance = await creditBalance(workspace.id);
        return emptyMine(seed, balance.total, { error: 'Apify spend cap breached.' });
      }
    }
  }

  if (!shouldQueueDiscoverMine()) {
    return runDiscoverMine(workspace, seed);
  }

  const opId = randomUUID();
  const preAuth = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * MINE_SCRAPE_LIMIT);

  try {
    await debitCredits(workspace.id, preAuth, 'discover_mine', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return emptyMine(seed, err.remaining, { error: 'Out of credits.' });
    }
    throw err;
  }

  let job: MediaJobRow;
  try {
    job = await enqueueDiscoverJob({
      workspaceId: workspace.id,
      payload: {
        sourceType: seed.sourceType,
        query: seed.query,
        rationale: seed.rationale,
        origin: seed.origin,
        alreadyTracked: seed.alreadyTracked,
      },
      opId,
      preAuthCredits: preAuth,
      deadlineAt: new Date(Date.now() + DISCOVER_JOB_DEADLINE_MS),
    });
  } catch (err) {
    await refundCredits(workspace.id, preAuth, 'discover_mine', `${opId}:fail`, 'call_failed');
    const balance = await creditBalance(workspace.id);
    return emptyMine(seed, balance.total, {
      ok: false,
      error: `Could not queue discover probe: ${(err as Error).message}`,
    });
  }

  const waited = await waitForDiscoverJob(job.id, workspace.id, seed, DISCOVER_WAIT_MS);
  if (waited) return waited;

  const balance = await creditBalance(workspace.id);
  return emptyMine(seed, balance.total, {
    ok: false,
    error: 'Probe is still running on the scraper. Wait a moment and try again.',
  });
}
