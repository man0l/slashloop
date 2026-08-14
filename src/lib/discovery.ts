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
//      each with view evidence.
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
): { hashtags: MinedHashtag[]; creators: MinedCreator[]; totalSampled: number } {
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

  return { hashtags, creators, totalSampled };
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
// ---------------------------------------------------------------------------

export async function mineDiscoverSeed(workspace: Workspace, seed: DiscoverySeed): Promise<SeedMineResult> {
  if (scrapeCapKind('tiktok') === 'proxy') {
    const capStatus = await trafficStatus(workspace.id);
    if (capStatus.breached) {
      const balance = await creditBalance(workspace.id);
      return { ok: true, verified: false, seed, sampleCount: 0, topViews: 0, hashtags: [], creators: [], creditsCharged: 0, creditsRemaining: balance.total, error: 'Proxy traffic cap breached.' };
    }
  } else {
    const capStatus = await getApifyCapStatus(workspace.id);
    if (capStatus.breached) {
      const balance = await creditBalance(workspace.id);
      return { ok: true, verified: false, seed, sampleCount: 0, topViews: 0, hashtags: [], creators: [], creditsCharged: 0, creditsRemaining: balance.total, error: 'Apify spend cap breached.' };
    }
  }

  const opId = randomUUID();
  const preAuth = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * MINE_SCRAPE_LIMIT);
  const balanceBefore = await creditBalance(workspace.id);

  try {
    await debitCredits(workspace.id, preAuth, 'discover_mine', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: true, verified: false, seed, sampleCount: 0, topViews: 0, hashtags: [], creators: [], creditsCharged: 0, creditsRemaining: err.remaining, error: 'Out of credits.' };
    }
    throw err;
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
    const creditsCharged = balanceBefore.total - balanceAfter.total;

    if (result.items.length === 0) {
      return { ok: true, verified: false, seed, sampleCount: 0, topViews: 0, hashtags: [], creators: [], creditsCharged, creditsRemaining: balanceAfter.total };
    }

    const items = [...result.items].sort((a, b) => b.views - a.views);
    const topViews = items[0].views;
    const seedHashtagKey = seed.sourceType === 'hashtag' ? seed.query : null;

    // Hashtags: count per video (once per caption), carry the top-view sample.
    const tagAcc = new Map<string, { videoCount: number; totalViews: number; sampleCaption: string }>();
    for (const item of items) {
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

    // Creators: keep handles seen more than once in the sample — a single
    // appearance is noise on a 5-video probe.
    const creatorAcc = new Map<string, { views: number[]; followers: number | null; topCaption: string; topViews: number }>();
    for (const item of items) {
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

    return {
      ok: true,
      verified: true,
      seed,
      sampleCount: items.length,
      topViews,
      hashtags,
      creators,
      creditsCharged,
      creditsRemaining: balanceAfter.total,
    };
  } catch (err) {
    // The scrape itself threw (not just "0 results") — refund in full; this
    // seed never got a real judgment either way.
    await refundCredits(workspace.id, preAuth, 'discover_mine', `${opId}:fail`, 'call_failed');
    const balance = await creditBalance(workspace.id);
    return {
      ok: false, verified: false, seed, sampleCount: 0, topViews: 0, hashtags: [], creators: [],
      creditsCharged: 0, creditsRemaining: balance.total, error: (err as Error).message,
    };
  }
}
