// ---------------------------------------------------------------------------
// AI source suggestions — seeds candidate hashtags/keywords/creators from a
// workspace's biggest outliers via Gemini, then verifies each candidate with
// exactly ONE real Apify scrape before it is ever shown to the user. A
// hallucinated hashtag with no real content is worse than no suggestion at
// all, so nothing here is surfaced without having actually returned videos.
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
/** Cap on candidates actually verified against Apify — bounds worst-case spend. */
const MAX_VERIFIED_CANDIDATES = 5;
/** Small probe, not a real refresh — just enough to tell "real content" from "nothing here". */
const VERIFY_SCRAPE_LIMIT = 5;

export interface SourceSuggestion {
  sourceType: 'hashtag' | 'keyword' | 'creator';
  query: string;
  rationale: string;
  sampleViews: number;
  sampleCaption: string;
  verifiedVideoCount: number;
}

export interface SuggestSourcesResult {
  ok: boolean;
  suggestions: SourceSuggestion[];
  rawCandidateCount: number;
  /** Candidates the model proposed but that didn't survive: already tracked,
   *  or verification came back with no real videos. */
  discardedCount: number;
  creditsCharged: number;
  creditsRemaining: number;
  errors: string[];
}

const CANDIDATE_SCHEMA = z.array(z.object({
  sourceType: z.enum(['hashtag', 'keyword', 'creator']),
  query: z.string().min(1),
  rationale: z.string(),
})).max(MAX_RAW_CANDIDATES);

const SUGGEST_SYSTEM = `You are a TikTok content-discovery strategist. Given a list of a workspace's biggest outlier videos (creator, views, multiple vs. baseline, caption) and what's already tracked, suggest NEW hashtags, search keywords, or creator accounts worth tracking that are NOT already tracked.

Look for patterns: recurring themes, adjacent niches, hashtags mentioned in captions that aren't tracked yet, creators with a similar style to the ones already breaking out. Prefer specific, real TikTok hashtags/handles over generic guesses — each one will be verified against real TikTok data, so a plausible-sounding but nonexistent hashtag just wastes the check.

Output raw JSON array, up to 8 items: [{"sourceType": "hashtag"|"keyword"|"creator", "query": "string, no # or @ prefix", "rationale": "one sentence, cite which outlier(s) this comes from"}]`;

export async function suggestSourcesForWorkspace(workspace: Workspace): Promise<SuggestSourcesResult> {
  const errors: string[] = [];
  const balanceBefore = await creditBalance(workspace.id);

  // ---- seed: biggest outliers + what's already tracked ----
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
      ok: false, suggestions: [], rawCandidateCount: 0, discardedCount: 0,
      creditsCharged: 0, creditsRemaining: balanceBefore.total,
      errors: ['No outlier videos yet — refresh a source first so there is something to seed suggestions from.'],
    };
  }

  const existingSources = await db.source.findMany({ where: { workspaceId: workspace.id }, select: { query: true } });
  const existingQueries = new Set(existingSources.map(s => s.query.toLowerCase().replace(/^[#@]/, '')));

  const seedList = outliers
    .map((s, i) => `[${i}] @${s.video.creatorHandle} — ${s.video.views.toLocaleString()} views, ${s.outlierScore}x `
      + `(from tracked source "${s.video.source.query}"): "${s.video.caption.slice(0, 200)}"`)
    .join('\n');
  const trackedList = [...existingQueries].join(', ') || '(none)';
  const userMessage = `## This workspace's biggest outliers\n\n${seedList}\n\n## Already tracked (do not suggest these again)\n${trackedList}\n\nSuggest up to 8 new hashtags, keywords, or creators to track.`;

  // ---- AI call: flat fee, charged once regardless of how many candidates
  // survive verification below — the call itself is a sunk cost either way. ----
  const opId = randomUUID();
  try {
    await debitCredits(workspace.id, CREDIT_COSTS.suggestSources, 'suggest_sources', `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return {
        ok: false, suggestions: [], rawCandidateCount: 0, discardedCount: 0,
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
      ok: false, suggestions: [], rawCandidateCount: 0, discardedCount: 0,
      creditsCharged: 0, creditsRemaining: balance.total,
      errors: [`Suggestion generation failed: ${(err as Error).message}`],
    };
  }

  // Dedupe against what's already tracked before spending anything on
  // verification, then cap how many get the (paid) verification pass.
  const alreadyTracked = rawCandidates.filter(c => existingQueries.has(c.query.toLowerCase().replace(/^[#@]/, '')));
  const candidates = rawCandidates
    .filter(c => !existingQueries.has(c.query.toLowerCase().replace(/^[#@]/, '')))
    .slice(0, MAX_VERIFIED_CANDIDATES);

  // ---- verify: exactly ONE real Apify scrape per candidate, run
  // CONCURRENTLY rather than one after another. A real Apify actor run
  // blocks synchronously (run-sync-get-dataset-items) for anywhere from a
  // few seconds to well over a minute, and can silently double that on a
  // fallback retry (see runTikTokActorWithFallback) — five of those stacked
  // sequentially inside one HTTP request has no realistic chance of
  // finishing before the request times out, which is exactly what made this
  // endpoint appear to return nothing at all. Running them in parallel
  // bounds worst-case wall time to roughly one scrape's latency instead of
  // MAX_VERIFIED_CANDIDATES of them. Never persisted as a Source/Video —
  // only shown if it's still ok to spend on, and only kept as a suggestion
  // if it actually returned videos. ----
  const capStatus = await getApifyCapStatus(workspace.id);
  if (capStatus.breached) {
    errors.push('Apify spend cap breached — no candidates were verified.');
  }

  type VerifyOutcome =
    | { candidate: typeof candidates[number]; outcome: 'verified'; suggestion: SourceSuggestion }
    | { candidate: typeof candidates[number]; outcome: 'empty' | 'no_credits' }
    | { candidate: typeof candidates[number]; outcome: 'error'; message: string };

  const verifyResults: VerifyOutcome[] = capStatus.breached ? [] : await Promise.all(candidates.map(async (candidate): Promise<VerifyOutcome> => {
    const verifyOpId = randomUUID();
    const verifyPreAuth = Math.ceil(CREDIT_COSTS.refreshSourcePerVideo * VERIFY_SCRAPE_LIMIT);
    try {
      await debitCredits(workspace.id, verifyPreAuth, 'suggest_sources_verify', `${verifyOpId}:preauth`);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) return { candidate, outcome: 'no_credits' };
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

      if (result.items.length === 0) return { candidate, outcome: 'empty' };
      const top = [...result.items].sort((a, b) => b.views - a.views)[0];
      return {
        candidate,
        outcome: 'verified',
        suggestion: {
          sourceType: candidate.sourceType,
          query: candidate.query,
          rationale: candidate.rationale,
          sampleViews: top.views,
          sampleCaption: top.caption,
          verifiedVideoCount: result.items.length,
        },
      };
    } catch (err) {
      // The scrape itself threw (not just "0 results") — refund in full,
      // this candidate never got a real judgment either way.
      await refundCredits(workspace.id, verifyPreAuth, 'suggest_sources_verify', `${verifyOpId}:fail`, 'call_failed');
      return { candidate, outcome: 'error', message: (err as Error).message };
    }
  }));

  const suggestions: SourceSuggestion[] = [];
  let discardedCount = alreadyTracked.length;
  let notedOutOfCredits = false;
  for (const r of verifyResults) {
    if (r.outcome === 'verified') {
      suggestions.push(r.suggestion);
    } else if (r.outcome === 'empty') {
      discardedCount++;
    } else if (r.outcome === 'error') {
      discardedCount++;
      errors.push(`Couldn't verify "${r.candidate.query}": ${r.message}`);
    } else {
      discardedCount++;
      if (!notedOutOfCredits) {
        errors.push('Ran out of credits partway through verification.');
        notedOutOfCredits = true;
      }
    }
  }

  const balanceAfter = await creditBalance(workspace.id);
  return {
    ok: true,
    suggestions,
    rawCandidateCount: rawCandidates.length,
    discardedCount,
    creditsCharged: balanceBefore.total - balanceAfter.total,
    creditsRemaining: balanceAfter.total,
    errors,
  };
}
