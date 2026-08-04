// ---------------------------------------------------------------------------
// AI source suggestions — seeds candidate hashtags/keywords/creators from a
// workspace's biggest outliers via Gemini, then verifies each candidate with
// exactly ONE real Apify scrape before it is ever shown to the user. A
// hallucinated hashtag with no real content is worse than no suggestion at
// all, so nothing here is surfaced without having actually returned videos.
//
// Split into two steps — seedSourceCandidates() and verifySourceCandidate()
// — rather than one combined call. A combined call means the caller waits
// for the slowest of up to MAX_VERIFIED_CANDIDATES real Apify scrapes before
// seeing anything at all (each one blocks synchronously for seconds to over
// a minute); this was previously the cause of the endpoint reliably timing
// out. Seeding is fast (one Gemini call) and returns immediately; the caller
// then fires one verify call per candidate itself and can render each result
// the moment its own call resolves, instead of waiting on all of them.
//
// Nothing is persisted as a tracked Source/Video during verification — a
// suggestion is just data in the response until the user explicitly tracks
// it (the normal create_source / POST /api/sources path).
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { Workspace } from '@prisma/client';
import { db } from '../db.js';
import { callGeminiText } from './gemini.js';
import { scrapeSource } from './apify.js';
import { getApifyCapStatus } from './spend-cap.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, creditBalance } from './credits.js';

/** How many of the workspace's biggest outliers to show the model as seed context. */
const SEED_OUTLIER_COUNT = 15;
/** Cap on candidates the model may propose in one call. */
const MAX_RAW_CANDIDATES = 8;
/** Cap on candidates actually offered for (paid) verification — bounds worst-case spend. */
export const MAX_VERIFIED_CANDIDATES = 5;
/** Small probe, not a real refresh — just enough to tell "real content" from "nothing here". */
const VERIFY_SCRAPE_LIMIT = 5;

export interface SeedCandidate {
  sourceType: 'hashtag' | 'keyword' | 'creator';
  query: string;
  rationale: string;
}

export interface SeedSourcesResult {
  ok: boolean;
  candidates: SeedCandidate[];
  rawCandidateCount: number;
  /** Candidates the model proposed that were already tracked — dropped before verification, never charged. */
  alreadyTrackedCount: number;
  /** Candidates the model proposed that this workspace previously dismissed ("no thanks") — dropped before verification, never charged. */
  alreadyDismissedCount: number;
  creditsCharged: number;
  creditsRemaining: number;
  errors: string[];
}

export interface SourceSuggestion {
  sourceType: 'hashtag' | 'keyword' | 'creator';
  query: string;
  rationale: string;
  sampleViews: number;
  sampleCaption: string;
  verifiedVideoCount: number;
}

export interface VerifyCandidateResult {
  /** false only for an unexpected error — insufficient credits and "no real
   *  content found" both come back ok:true with verified:false, since both
   *  are a normal, expected outcome rather than a failure. */
  ok: boolean;
  verified: boolean;
  suggestion?: SourceSuggestion;
  creditsCharged: number;
  creditsRemaining: number;
  error?: string;
}

const CANDIDATE_SCHEMA = z.array(z.object({
  sourceType: z.enum(['hashtag', 'keyword', 'creator']),
  query: z.string().min(1),
  rationale: z.string(),
})).max(MAX_RAW_CANDIDATES);

const SUGGEST_SYSTEM = `You are a TikTok content-discovery strategist. Given a list of a workspace's biggest outlier videos (creator, views, multiple vs. baseline, caption) and what's already tracked or previously rejected, suggest NEW hashtags, search keywords, or creator accounts worth tracking that are NOT in that list.

Look for patterns: recurring themes, adjacent niches, hashtags mentioned in captions that aren't tracked yet, creators with a similar style to the ones already breaking out. Prefer specific, real TikTok hashtags/handles over generic guesses — each one will be verified against real TikTok data, so a plausible-sounding but nonexistent hashtag just wastes the check.

Output raw JSON array, up to 8 items: [{"sourceType": "hashtag"|"keyword"|"creator", "query": "string, no # or @ prefix", "rationale": "one sentence, cite which outlier(s) this comes from"}]`;

/** Lowercase, strip a leading # or @ — the same normalization used to key SuggestionDismissal rows. */
function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/^[#@]/, '');
}

/**
 * Step 1: seed candidates from this workspace's biggest outliers via a
 * single Gemini call. Fast (one text-generation call) — no Apify scrapes
 * here, so nothing here is verified yet. Charges the flat suggestSources
 * fee once, a sunk cost regardless of how many candidates later verify.
 */
export async function seedSourceCandidates(workspace: Workspace): Promise<SeedSourcesResult> {
  const balanceBefore = await creditBalance(workspace.id);

  const outliers = await db.score.findMany({
    where: { outlierScore: { gte: 2 }, video: { source: { workspaceId: workspace.id } } },
    include: {
      video: {
        select: { creatorHandle: true, caption: true, views: true, source: { select: { query: true } } },
      },
    },
    orderBy: { outlierScore: 'desc' },
    take: SEED_OUTLIER_COUNT,
  });

  if (outliers.length === 0) {
    return {
      ok: false, candidates: [], rawCandidateCount: 0, alreadyTrackedCount: 0, alreadyDismissedCount: 0,
      creditsCharged: 0, creditsRemaining: balanceBefore.total,
      errors: ['No outlier videos yet — refresh a source first so there is something to seed suggestions from.'],
    };
  }

  const existingSources = await db.source.findMany({ where: { workspaceId: workspace.id }, select: { query: true } });
  const existingQueries = new Set(existingSources.map(s => normalizeQuery(s.query)));

  const dismissals = await db.suggestionDismissal.findMany({ where: { workspaceId: workspace.id }, select: { sourceType: true, query: true } });
  const dismissedKeys = new Set(dismissals.map(d => `${d.sourceType}:${d.query}`));

  const seedList = outliers
    .map((s, i) => `[${i}] @${s.video.creatorHandle} — ${s.video.views.toLocaleString()} views, ${s.outlierScore}x `
      + `(from tracked source "${s.video.source.query}"): "${s.video.caption.slice(0, 200)}"`)
    .join('\n');
  const excludedList = [...new Set([...existingQueries, ...dismissals.map(d => d.query)])].join(', ') || '(none)';
  const userMessage = `## This workspace's biggest outliers\n\n${seedList}\n\n## Already tracked or previously rejected (do not suggest these again)\n${excludedList}\n\nSuggest up to 8 new hashtags, keywords, or creators to track.`;

  const opId = randomUUID();
  try {
    await debitCredits(workspace.id, CREDIT_COSTS.suggestSources, 'suggest_sources', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return {
        ok: false, candidates: [], rawCandidateCount: 0, alreadyTrackedCount: 0, alreadyDismissedCount: 0,
        creditsCharged: 0, creditsRemaining: err.remaining,
        errors: [err.message],
      };
    }
    throw err;
  }

  let rawCandidates: z.infer<typeof CANDIDATE_SCHEMA>;
  try {
    const { parsed } = await callGeminiText(SUGGEST_SYSTEM, userMessage);
    const result = CANDIDATE_SCHEMA.safeParse(parsed);
    if (!result.success) throw new Error('Gemini returned candidates in an unexpected shape');
    rawCandidates = result.data;
  } catch (err) {
    await refundCredits(workspace.id, CREDIT_COSTS.suggestSources, 'suggest_sources', `${opId}:fail`, 'call_failed');
    const balance = await creditBalance(workspace.id);
    return {
      ok: false, candidates: [], rawCandidateCount: 0, alreadyTrackedCount: 0, alreadyDismissedCount: 0,
      creditsCharged: 0, creditsRemaining: balance.total,
      errors: [`Suggestion generation failed: ${(err as Error).message}`],
    };
  }

  // Dedupe against what's already tracked and what this workspace previously
  // dismissed, then cap how many the caller can send for (paid) verification.
  const alreadyTracked = rawCandidates.filter(c => existingQueries.has(normalizeQuery(c.query)));
  const alreadyDismissed = rawCandidates.filter(c =>
    !existingQueries.has(normalizeQuery(c.query)) && dismissedKeys.has(`${c.sourceType}:${normalizeQuery(c.query)}`));
  const candidates = rawCandidates
    .filter(c => !existingQueries.has(normalizeQuery(c.query)) && !dismissedKeys.has(`${c.sourceType}:${normalizeQuery(c.query)}`))
    .slice(0, MAX_VERIFIED_CANDIDATES);

  const balanceAfter = await creditBalance(workspace.id);
  return {
    ok: true,
    candidates,
    rawCandidateCount: rawCandidates.length,
    alreadyTrackedCount: alreadyTracked.length,
    alreadyDismissedCount: alreadyDismissed.length,
    creditsCharged: balanceBefore.total - balanceAfter.total,
    creditsRemaining: balanceAfter.total,
    errors: [],
  };
}

/**
 * Records a "no thanks" on a candidate so future seedSourceCandidates() calls
 * for this workspace exclude it — both from what's shown and from what's
 * sent to Gemini as already-considered. Idempotent (unique on workspace +
 * sourceType + normalized query): dismissing the same candidate twice is a
 * no-op, not an error.
 */
export async function dismissSuggestion(workspace: Workspace, candidate: Pick<SeedCandidate, 'sourceType' | 'query'>): Promise<void> {
  const query = normalizeQuery(candidate.query);
  await db.suggestionDismissal.upsert({
    where: { workspaceId_sourceType_query: { workspaceId: workspace.id, sourceType: candidate.sourceType, query } },
    create: { workspaceId: workspace.id, sourceType: candidate.sourceType, query },
    update: {},
  });
}

/**
 * Step 2: verify exactly ONE candidate with exactly ONE real Apify scrape.
 * Meant to be called once per candidate returned by seedSourceCandidates,
 * by the caller — not looped internally — so each candidate's result comes
 * back (and can be shown) independently, instead of the caller waiting for
 * every candidate before seeing any of them. A real Apify actor run blocks
 * synchronously for anywhere from a few seconds to well over a minute (and
 * can silently double that on a fallback retry — see
 * runTikTokActorWithFallback in apify.ts), so keeping this to one scrape per
 * call keeps each call's own worst case bounded and independent of how many
 * other candidates are being verified.
 */
export async function verifySourceCandidate(workspace: Workspace, candidate: SeedCandidate): Promise<VerifyCandidateResult> {
  const capStatus = await getApifyCapStatus(workspace.id);
  if (capStatus.breached) {
    const balance = await creditBalance(workspace.id);
    return { ok: true, verified: false, creditsCharged: 0, creditsRemaining: balance.total, error: 'Apify spend cap breached.' };
  }

  const verifyOpId = randomUUID();
  const verifyPreAuth = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * VERIFY_SCRAPE_LIMIT);
  const balanceBefore = await creditBalance(workspace.id);

  try {
    await debitCredits(workspace.id, verifyPreAuth, 'suggest_sources_verify', `${verifyOpId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: true, verified: false, creditsCharged: 0, creditsRemaining: err.remaining, error: 'Out of credits.' };
    }
    throw err;
  }

  try {
    const result = await scrapeSource({
      workspaceId: workspace.id,
      platform: 'tiktok',
      sourceType: candidate.sourceType,
      query: candidate.query,
      limit: VERIFY_SCRAPE_LIMIT,
    });

    const actualCredits = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * result.items.length);
    const refundAmount = verifyPreAuth - actualCredits;
    if (refundAmount > 0) {
      await refundCredits(workspace.id, refundAmount, 'suggest_sources_verify', `${verifyOpId}:settle`, 'usage_settlement');
    }

    const balanceAfter = await creditBalance(workspace.id);
    const creditsCharged = balanceBefore.total - balanceAfter.total;

    if (result.items.length === 0) {
      return { ok: true, verified: false, creditsCharged, creditsRemaining: balanceAfter.total };
    }
    const top = [...result.items].sort((a, b) => b.views - a.views)[0];
    return {
      ok: true,
      verified: true,
      suggestion: {
        sourceType: candidate.sourceType,
        query: candidate.query,
        rationale: candidate.rationale,
        sampleViews: top.views,
        sampleCaption: top.caption,
        verifiedVideoCount: result.items.length,
      },
      creditsCharged,
      creditsRemaining: balanceAfter.total,
    };
  } catch (err) {
    // The scrape itself threw (not just "0 results") — refund in full, this
    // candidate never got a real judgment either way.
    await refundCredits(workspace.id, verifyPreAuth, 'suggest_sources_verify', `${verifyOpId}:fail`, 'call_failed');
    const balance = await creditBalance(workspace.id);
    return { ok: false, verified: false, creditsCharged: 0, creditsRemaining: balance.total, error: (err as Error).message };
  }
}
