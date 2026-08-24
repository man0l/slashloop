// ---------------------------------------------------------------------------
// The `nextSteps` contract — forward edges on every tool result.
//
// Why this exists: the product's funnel collapses at "looked at it". A
// workspace can hold 246 videos and 48 scored outliers and still have zero
// analyses, zero hooks, zero ideas and zero briefs — everything downstream of
// viewing is untouched. That is not a discovery problem, it is a dead-end
// problem: `get_feed` hands back rows and stops, so the agent stops too.
//
// An agent can only offer what the tool result tells it exists. So every tool
// in the funnel attaches the move that comes next, pre-filled with the exact
// arguments to make it, and — crucially — whether making it spends money.
//
// Modelled on the `hostNote` field already used by show_gallery: addressed to
// the agent, not rendered verbatim to the user.
// ---------------------------------------------------------------------------

import { CREDIT_COSTS } from './credits.js';
import { estimateScrapeBytes, scrapeCapKind } from './scrapers/index.js';
import { bytesToCents, fmtBytes } from './scrapers/bandwidth.js';

/** Apify cost constants mirrored from src/lib/apify.ts for estimation only. */
const APIFY_CENTS_PER_RESULT = 0.37;
const APIFY_ACTOR_START_CENTS = 0.1;

export interface NextStep {
  /** Short, user-facing phrasing of the offer. */
  label: string;
  /** Tool the agent should call if the user accepts. */
  tool: string;
  /** Pre-filled arguments — the agent should not have to reconstruct these. */
  args?: Record<string, unknown>;
  /**
   * Human-readable spend for this step, e.g. "5 credits" or "~$0.19 Apify".
   * Omitted entirely when the step is free.
   */
  cost?: string;
  /**
   * TRUE when running this step debits credits or bills Apify.
   *
   * The agent MUST surface the cost and get an explicit yes before calling a
   * step with this set. Never batch several spending steps behind one
   * confirmation — the user is agreeing to a number, not to a direction.
   */
  spendsMoney?: boolean;
  /** Why this step is worth taking, in the user's terms. */
  why?: string;
}

/** Estimated Apify spend for scraping `n` results, as user-facing text. */
export function apifyCostLabel(results: number): string {
  return `~$${(apifyCostCents(results) / 100).toFixed(2)} Apify`;
}

/** Estimated Apify spend for scraping `n` results, in cents (for cost blocks). */
export function apifyCostCents(results: number): number {
  return Math.ceil(results * APIFY_CENTS_PER_RESULT + APIFY_ACTOR_START_CENTS);
}

// ---------------------------------------------------------------------------
// Provider-aware scraper cost quotes.
//
// List scrapes follow SCRAPER_PROVIDER: Apify bills per result, the own proxy
// worker bills per gigabyte (bytesToCents, $3/GB default). Quoting everything
// in "~$X Apify" was true when Apify was the only provider and is now just
// wrong whenever the worker is — so every scraper quote goes through these.
// needsLookup=true for the byte estimate is deliberate: it is the honest
// worst case (creator sources need a secUid lookup, hashtags don't).
// ---------------------------------------------------------------------------

/** Estimated scraper spend for a list scrape of `n` results, in cents. */
export function listScrapeCostCents(results: number): number {
  if (scrapeCapKind('tiktok') === 'proxy') {
    return bytesToCents(estimateScrapeBytes(results, true));
  }
  return apifyCostCents(results);
}

/** Estimated scraper spend for `n` results, as user-facing text. */
export function scraperCostLabel(results: number): string {
  if (scrapeCapKind('tiktok') === 'proxy') {
    return `~${fmtBytes(estimateScrapeBytes(results, true))} proxy traffic`;
  }
  return apifyCostLabel(results);
}

/** Estimated credit spend for analysing `n` videos, as user-facing text. */
export function analyzeCostLabel(videos: number): string {
  const credits = Math.ceil(videos * CREDIT_COSTS.analyzeVideo);
  return `${credits} credit${credits === 1 ? '' : 's'}`;
}

/** Estimated credit spend for a refresh returning `n` videos. */
export function refreshCreditLabel(videos: number): string {
  const credits = Math.ceil(videos * CREDIT_COSTS.refreshSourcePerVideo);
  return `${credits} credit${credits === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The `cost` block — one shape for spend on every tool response.
//
// Before this, each spending tool invented its own bookkeeping fields
// (creditsCharged here, estimatedCost there, costCents somewhere else), so a
// client had to know per-tool conventions to answer "what did this just cost
// me / what will it cost". Every metered tool now attaches this object next
// to its legacy fields (kept for back-compat with the site and existing
// skills): post-execution it reports what was actually charged; on quotes
// (dry runs, queued work) it carries the worst-case estimate and says so.
// ---------------------------------------------------------------------------

export interface CostBlock {
  /** Credits this call charged. 0 when the spend is pure scraper time or the block is a quote. */
  credits: number;
  /** Actual or estimated scraper spend in cents — Apify per-result when
   *  SCRAPER_PROVIDER=apify, modelled proxy bandwidth when the own worker is active. */
  scraperCents?: number;
  /** Credit balance after settlement. Omitted on pure quotes that touch no balance. */
  remaining?: number;
  /** Present only on quotes: the language is an estimate, not a settled amount. */
  quoted?: boolean;
  /** Worst-case framing for queued work that settles down later. */
  note?: string;
}

/** Build the standard cost block. All numbers are final/actual unless `quoted`. */
export function costBlock(
  credits: number,
  opts: { scraperCents?: number; remaining?: number; quoted?: boolean; note?: string } = {},
): CostBlock {
  return {
    credits,
    ...(opts.scraperCents != null ? { scraperCents: Math.round(opts.scraperCents * 100) / 100 } : {}),
    ...(opts.remaining != null ? { remaining: opts.remaining } : {}),
    ...(opts.quoted ? { quoted: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
}

/**
 * Standing instruction attached alongside the steps.
 *
 * Kept as one constant so the spend rule reads identically on every tool —
 * a rule the agent sees phrased three different ways is a rule it will apply
 * inconsistently.
 */
export const NEXT_STEPS_GUIDANCE =
  'Do not end your turn here. Offer the nextSteps below to the user in your own words, '
  + 'as concrete choices rather than a menu. For any step with spendsMoney=true you MUST state '
  + 'its cost and get an explicit yes before calling it — confirm each spending step separately, '
  + 'never several behind one approval. Free steps can simply be offered. '
  + 'If a step is clearly the best move, recommend it and say why.';

/**
 * Attach forward edges to a tool payload.
 *
 * Returns the payload unchanged when there is genuinely nothing to suggest, so
 * a terminal result never carries an empty, noise-generating `nextSteps: []`.
 */
export function withNextSteps<T extends Record<string, unknown>>(
  payload: T,
  steps: Array<NextStep | null | undefined>,
): T & { nextSteps?: NextStep[]; nextStepsGuidance?: string } {
  const clean = steps.filter((s): s is NextStep => Boolean(s));
  if (clean.length === 0) return payload;
  return { ...payload, nextSteps: clean, nextStepsGuidance: NEXT_STEPS_GUIDANCE };
}
