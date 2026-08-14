// ---------------------------------------------------------------------------
// MCP Tool: discover — the keyword-driven front door to the product.
//
// "I'm thinking about <niche>" should not require already knowing which
// hashtag to track. The user pastes a few keywords/hashtags/handles; the AI
// expands them into seed keywords, each seed is probed with a small real
// scrape, and hashtags + creator handles are mined from the sampled captions
// with view evidence — the agent then presents verified, trackable sources.
//
// One-shot on purpose (like suggest_sources): a conversational tool call has
// to return one final answer, so all seed probes run concurrently here. The
// site UI drives the same pipeline through the split REST actions instead
// (api/sources.ts) so its screen can render each probe as it lands.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';
import { CREDIT_COSTS } from '../lib/credits.js';
import { withNextSteps } from '../lib/next-steps.js';
import {
  MAX_INPUT_KEYWORDS,
  MAX_SEEDS,
  MINE_SCRAPE_LIMIT,
  aggregateDiscovery,
  expandDiscoverySeeds,
  loadExclusionSets,
  mineDiscoverSeed,
  type DiscoverySeed,
  type SeedMineResult,
} from '../lib/discovery.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** How many track-this nextSteps to attach — a wall of 19 identical offers
 * reads as noise, the top few are what anyone actually acts on. */
const MAX_TRACK_STEPS = 6;
/** Hashtags / creators surfaced in the response, after ranking. */
const MAX_HASHTAG_SUGGESTIONS = 8;
const MAX_CREATOR_SUGGESTIONS = 5;

const MAX_PROBE_COST = Math.ceil(MAX_SEEDS * MINE_SCRAPE_LIMIT * CREDIT_COSTS.refreshSourcePerVideo);

function fmtViews(views: number): string {
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M`;
  if (views >= 1_000) return `${Math.round(views / 1_000)}k`;
  return `${views}`;
}

function hashtagEvidence(videoCount: number, avgViews: number, totalSampled: number): string {
  return `Appeared in ${videoCount} of ${totalSampled} sampled videos, averaging ${fmtViews(avgViews)} views.`;
}

function creatorEvidence(videoCount: number, medianViews: number, followers: number | null): string {
  const followerNote = followers ? `, ${fmtViews(followers)} followers` : '';
  return `${videoCount} sampled video${videoCount === 1 ? '' : 's'}${followerNote}, median ${fmtViews(medianViews)} views.`;
}

function seedLabel(seed: Pick<DiscoverySeed, 'sourceType' | 'query'>): string {
  return seed.sourceType === 'hashtag' ? `#${seed.query}` : seed.sourceType === 'creator' ? `@${seed.query}` : seed.query;
}

function trackStep(seed: Pick<DiscoverySeed, 'sourceType' | 'query'>, why: string) {
  return {
    label: `Track ${seedLabel(seed)}`,
    tool: 'create_source',
    args: { platform: 'tiktok', sourceType: seed.sourceType, query: seed.query },
    why,
  };
}

export function registerDiscoverTools(server: McpServer) {
  server.tool('discover',
    `Discover trackable TikTok sources from a few niche keywords, hashtags (#tag) and/or creator handles `
    + `(@handle). AI expands the inputs into seed keywords, every seed is probed with a small REAL scrape `
    + `(${MINE_SCRAPE_LIMIT} videos each), and hashtags + creator handles are mined from the sampled captions with view `
    + `evidence — so every suggestion is verified against actual TikTok content, never hallucinated. `
    + `Costs ${CREDIT_COSTS.discoverSeeds} credits for the AI call plus ~${CREDIT_COSTS.refreshSourcePerVideo} `
    + `credits per probed video (up to ~${MAX_PROBE_COST} worst case; empty or failed probes are refunded). `
    + `Nothing is tracked automatically — the user picks from the suggestions.`,
    {
      keywords: z.array(z.string()).min(1).max(MAX_INPUT_KEYWORDS)
        .describe('Niche keywords, hashtags (#tag) and/or creator handles (@handle) describing the area to research.'),
    },
    async ({ keywords }) => {
      const workspace = await requireWorkspace();

      const expanded = await expandDiscoverySeeds(workspace, keywords);
      if (!expanded.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'discover_failed',
            message: expanded.errors[0] ?? 'Could not expand keywords into seeds.',
            creditsCharged: expanded.creditsCharged,
            creditsRemaining: expanded.creditsRemaining,
          }, null, 2) }],
          isError: true,
        };
      }

      const mines: SeedMineResult[] = await Promise.all(expanded.seeds.map(seed => mineDiscoverSeed(workspace, seed)));
      const { trackedKeys, dismissedKeys } = await loadExclusionSets(workspace.id);
      const { hashtags, creators, totalSampled } = aggregateDiscovery(mines, new Set([...trackedKeys, ...dismissedKeys]));

      const verifiedSeeds = mines.filter(m => m.verified);
      const deadSeeds = mines.filter(m => !m.verified && !m.error);
      const notices = mines.filter(m => m.error).map(m => `${seedLabel(m.seed)}: ${m.error}`);
      const creditsCharged = expanded.creditsCharged + mines.reduce((sum, m) => sum + m.creditsCharged, 0);
      const creditsRemaining = mines.length > 0 ? mines[mines.length - 1].creditsRemaining : expanded.creditsRemaining;

      const topHashtags = hashtags.slice(0, MAX_HASHTAG_SUGGESTIONS);
      const topCreators = creators.slice(0, MAX_CREATOR_SUGGESTIONS);
      // Seeds the user typed or the AI proposed that actually have content —
      // the most literal "track what you searched for" option.
      const newSeeds = verifiedSeeds.filter(m => !m.seed.alreadyTracked);

      const suggestions: Array<{ sourceType: DiscoverySeed['sourceType']; query: string; evidence: string; sampleCaption?: string }> = [
        ...newSeeds.map(m => ({
          sourceType: m.seed.sourceType,
          query: m.seed.query,
          evidence: `Probed directly: ${m.sampleCount} videos found, top ${fmtViews(m.topViews)} views.`,
        })),
        ...topHashtags.map(t => ({
          sourceType: 'hashtag' as const,
          query: t.query,
          evidence: hashtagEvidence(t.videoCount, t.avgViews, totalSampled),
          sampleCaption: t.sampleCaption ? t.sampleCaption.slice(0, 140) : undefined,
        })),
        ...topCreators.map(c => ({
          sourceType: 'creator' as const,
          query: c.query,
          evidence: creatorEvidence(c.videoCount, c.medianViews, c.followers),
          sampleCaption: c.sampleCaption ? c.sampleCaption.slice(0, 140) : undefined,
        })),
      ];

      const steps = suggestions.slice(0, MAX_TRACK_STEPS).map(s => trackStep(s, s.evidence));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: suggestions.length > 0
            ? `${suggestions.length} verified source suggestion(s) from ${verifiedSeeds.length}/${mines.length} live seed(s), ${totalSampled} videos sampled.`
            : 'No trackable sources found — every seed came back empty or blocked. Try different or broader keywords.',
          keywords,
          seeds: mines.map(m => ({
            sourceType: m.seed.sourceType,
            query: m.seed.query,
            origin: m.seed.origin,
            alreadyTracked: m.seed.alreadyTracked ?? false,
            verified: m.verified,
            sampleCount: m.sampleCount,
            topViews: m.topViews || undefined,
          })),
          deadSeeds: deadSeeds.map(m => ({ sourceType: m.seed.sourceType, query: m.seed.query })),
          suggestions,
          creditsCharged,
          creditsRemaining,
          notices: notices.length ? notices : undefined,
        }, steps), null, 2) }],
      };
    });
}
