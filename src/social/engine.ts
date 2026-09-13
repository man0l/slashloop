// Social scheduler engine — one tick per cron invocation, no durable
// workflow runtime. Every step is idempotent by construction:
//
//   • claimDuePosts() flips QUEUE → PROCESSING in a single UPDATE…RETURNING,
//     so two overlapping ticks can never claim the same row.
//   • postPending() is the only irreversible step and always returns
//     pendingData persisted BEFORE any further progress is trusted.
//   • checkPostStatus/finalizePost resume from pendingData and honor the
//     Postiz no-duplicate contract (probe first, publish last).
//
// Error handling map:
//   RefreshTokenError → refresh once, retry the step once, else fail the post
//   ReconnectError    → integration.markRefreshNeeded + fail the post
//   BadBodyError      → platform rejected the content → fail the post
//   anything else     → transient: keep/return the post to a resumable state

import { createRegistry, getProvider } from './registry.js';
import * as store from './store.js';
import { BadBodyError, ReconnectError, RefreshTokenError } from './errors.js';
import type { ProviderPostContext, SocialConfig, SocialIntegrationRow, SocialPostRow } from './types.js';

export interface TickOptions {
  /** Max posts claimed per tick (subrequest/wall-clock budget guard). */
  batchLimit?: number;
  /** Max postPending attempts before a post is failed. */
  maxAttempts?: number;
  /** Max ticks a post may sit in PROCESSING (status polls + upload resumes)
   *  before it is failed — 120 ticks ≈ 2h at a 1-minute cron. */
  maxPendingTicks?: number;
  /** Test seam: fixed "now" (epoch seconds). */
  nowSeconds?: number;
}

export interface TickReport {
  claimed: number;
  published: number;
  errored: number;
  resumed: number;
  deferred: number;
  failures: Array<{ postId: string; provider: string; error: string }>;
}

export interface RefreshReport {
  scanned: number;
  refreshed: number;
  failed: number;
}

export async function socialEngineTick(cfg: SocialConfig, options: TickOptions = {}): Promise<TickReport> {
  const batchLimit = options.batchLimit ?? 8;
  const maxAttempts = options.maxAttempts ?? 8;
  const maxPendingTicks = options.maxPendingTicks ?? 120;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const registry = createRegistry(cfg);

  const report: TickReport = { claimed: 0, published: 0, errored: 0, resumed: 0, deferred: 0, failures: [] };

  // 1. Fresh posts: claim the due batch.
  const claimed = await store.claimDuePosts(batchLimit, now);
  report.claimed = claimed.length;
  for (const post of claimed) {
    const outcome = await startPost(registry, cfg, post, { maxAttempts, now });
    apply(report, outcome);
  }

  // 2. In-flight posts: advance the pending flow (status polls, resume
  //    uploads, publish containers). Bounded by the same batch budget.
  const inFlight = await store.processingPosts(batchLimit);
  for (const post of inFlight) {
    if (post.attempts > maxPendingTicks) {
      await store.markError(post.id, 'Processing timeout — the platform never confirmed the post');
      report.errored++;
      report.failures.push({ postId: post.id, provider: post.provider, error: 'processing timeout' });
      continue;
    }
    const outcome = await advancePost(registry, cfg, post, { now, maxAttempts });
    apply(report, outcome);
  }

  return report;
}

type Outcome = { kind: 'published' } | { kind: 'errored'; error: string } | { kind: 'resumed' } | { kind: 'deferred' };

function apply(report: TickReport, outcome: Outcome): void {
  switch (outcome.kind) {
    case 'published':
      report.published++;
      break;
    case 'errored':
      report.errored++;
      report.failures.push({ postId: '', provider: '', error: outcome.error });
      break;
    case 'resumed':
      report.resumed++;
      break;
    case 'deferred':
      report.deferred++;
      break;
  }
}

async function startPost(
  registry: ReturnType<typeof createRegistry>,
  cfg: SocialConfig,
  post: SocialPostRow,
  limits: { maxAttempts: number; now: number },
): Promise<Outcome> {
  const integration = await store.getIntegration(post.integration_id);
  if (!integration) {
    await store.markError(post.id, 'The connected account was removed before this post ran');
    return { kind: 'errored', error: 'integration missing' };
  }
  if (integration.refresh_needed) {
    await store.markError(post.id, 'The connected account needs to be re-authenticated');
    return { kind: 'errored', error: 'refresh needed' };
  }
  if (integration.disabled) {
    await store.markError(post.id, 'The connected account is disabled');
    return { kind: 'errored', error: 'integration disabled' };
  }

  const provider = getProvider(registry, post.provider);
  const details = postDetails(post);
  const validity = provider.checkValidity(details);
  if (validity !== true) {
    await store.markError(post.id, validity);
    return { kind: 'errored', error: validity };
  }

  const ctx = await contextFor(provider, cfg, post, integration, limits.now);
  if ('error' in ctx) {
    await store.markError(post.id, ctx.error);
    return { kind: 'errored', error: ctx.error };
  }

  try {
    const response = await provider.postPending(ctx);
    await store.savePendingData(post.id, response.pendingData, 1);
    return { kind: 'resumed' };
  } catch (err) {
    return await handleProviderError(err, { registry, cfg, post, integration, provider, limits });
  }
}

async function advancePost(
  registry: ReturnType<typeof createRegistry>,
  cfg: SocialConfig,
  post: SocialPostRow,
  limits: { now: number; maxAttempts: number },
): Promise<Outcome> {
  const integration = await store.getIntegration(post.integration_id);
  if (!integration || integration.refresh_needed || integration.disabled) {
    await store.markError(post.id, 'The connected account needs attention — reconnect it and post again');
    return { kind: 'errored', error: 'integration unavailable' };
  }

  const provider = getProvider(registry, post.provider);
  const pendingData = safeParse(post.pending_data);
  const attempts = post.attempts + 1;

  // Crash between claim and first save: nothing irreversible happened, so
  // start the upload from scratch on a later tick.
  if (!pendingData) {
    await store.releaseBackToQueue(post.id, '');
    return { kind: 'deferred' };
  }

  const ctx = await contextFor(provider, cfg, post, integration, limits.now, pendingData);
  if ('error' in ctx) {
    await store.markError(post.id, ctx.error);
    return { kind: 'errored', error: ctx.error };
  }

  try {
    const check = await provider.checkPostStatus(ctx);

    if (check.status === 'completed') {
      await store.markPublished(post.id, check.postId, check.releaseUrl);
      return { kind: 'published' };
    }

    if (check.status === 'ready' && provider.finalizePost) {
      const finalized = await provider.finalizePost({ ...ctx, pendingData: check.pendingData });
      if (finalized.status === 'completed') {
        await store.markPublished(post.id, finalized.postId, finalized.releaseUrl);
        return { kind: 'published' };
      }
      // 'pending'/'ready' both mean "progress persisted, come back later".
      await store.savePendingData(post.id, finalized.pendingData, attempts);
      return { kind: 'resumed' };
    }

    await store.savePendingData(post.id, check.pendingData, attempts);
    return { kind: 'resumed' };
  } catch (err) {
    return await handleProviderError(err, { registry, cfg, post, integration, provider, limits, pendingData });
  }
}

/** Refresh-then-retry-once, reconnect marking, or a definite failure. */
async function handleProviderError(
  err: unknown,
  ctx: {
    registry: ReturnType<typeof createRegistry>;
    cfg: SocialConfig;
    post: SocialPostRow;
    integration: SocialIntegrationRow;
    provider: ReturnType<typeof getProvider>;
    limits: { maxAttempts: number; now: number };
    pendingData?: Record<string, unknown>;
  },
): Promise<Outcome> {
  if (err instanceof RefreshTokenError && ctx.integration.refresh_token) {
    try {
      const refreshed = await ctx.provider.refreshToken(ctx.cfg, ctx.integration.refresh_token);
      await store.updateIntegrationTokens(
        ctx.integration.id,
        refreshed.accessToken,
        refreshed.refreshToken,
        ctx.limits.now + (refreshed.expiresIn ?? 0),
      );
      // Token replaced — the next tick retries the step with the new token.
      return { kind: 'deferred' };
    } catch {
      await store.markIntegrationRefreshNeeded(ctx.integration.id, 'Token refresh failed — please reconnect this account');
      await store.markError(ctx.post.id, 'The connected account needs to be re-authenticated');
      return { kind: 'errored', error: 'refresh failed' };
    }
  }

  if (err instanceof ReconnectError) {
    await store.markIntegrationRefreshNeeded(ctx.integration.id, err.message);
    await store.markError(ctx.post.id, err.message);
    return { kind: 'errored', error: err.message };
  }

  if (err instanceof BadBodyError) {
    await store.markError(ctx.post.id, err.message);
    return { kind: 'errored', error: err.message };
  }

  // Transient (network, unknown platform 5xx shape): keep the post alive —
  // with pendingData intact if the step already produced some — and retry on
  // a later tick until the attempt budget runs out.
  if (ctx.post.attempts + 1 > ctx.limits.maxAttempts) {
    const message = `Repeated failures: ${(err as Error).message}`.slice(0, 500);
    await store.markError(ctx.post.id, message);
    return { kind: 'errored', error: message };
  }

  if (ctx.pendingData) {
    await store.savePendingData(ctx.post.id, ctx.pendingData, ctx.post.attempts + 1);
    return { kind: 'deferred' };
  }
  await store.releaseBackToQueue(ctx.post.id, (err as Error).message);
  return { kind: 'deferred' };
}

/** Build the provider context, refreshing a token that expires within the
 *  next 10 minutes first (TikTok ~24h tokens, YouTube ~1h tokens). */
async function contextFor(
  provider: ReturnType<typeof getProvider>,
  cfg: SocialConfig,
  post: SocialPostRow,
  integration: SocialIntegrationRow,
  now: number,
  pendingData?: Record<string, unknown>,
): Promise<ProviderPostContext | { error: string }> {
  let token = integration.token;

  const expiresSoon = integration.token_expires_at !== null && integration.token_expires_at <= now + 600;
  if (expiresSoon && integration.refresh_token) {
    try {
      const refreshed = await provider.refreshToken(cfg, integration.refresh_token);
      token = refreshed.accessToken;
      await store.updateIntegrationTokens(integration.id, token, refreshed.refreshToken, now + (refreshed.expiresIn ?? 0));
    } catch {
      return { error: 'The connected account needs to be re-authenticated' };
    }
  }

  let settings: Record<string, unknown> = {};
  try {
    settings = post.settings ? (JSON.parse(post.settings) as Record<string, unknown>) : {};
  } catch {
    settings = {};
  }

  return {
    token,
    post: { id: post.id, message: post.content, settings, media: safeParseArray(post.media) },
    integration: { internalId: integration.internal_id, profile: integration.profile ?? '' },
    pendingData,
  };
}

function postDetails(post: SocialPostRow) {
  return {
    message: post.content,
    settings: safeParse(post.settings) ?? {},
    media: safeParseArray(post.media),
  };
}

function safeParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeParseArray(raw: string | null): Array<{ type: 'image' | 'video'; url: string; alt?: string; thumbnail?: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ type: 'image' | 'video'; url: string; alt?: string; thumbnail?: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── daily token refresh scan ────────────────────────────────────────────────

export async function socialRefreshScan(cfg: SocialConfig, options: { nowSeconds?: number } = {}): Promise<RefreshReport> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const registry = createRegistry(cfg);
  const due = await store.integrationsDueForRefresh();

  const report: RefreshReport = { scanned: due.length, refreshed: 0, failed: 0 };
  for (const integration of due) {
    const provider = getProvider(registry, integration.provider);
    try {
      const refreshed = await provider.refreshToken(cfg, integration.refresh_token!);
      await store.updateIntegrationTokens(integration.id, refreshed.accessToken, refreshed.refreshToken, now + (refreshed.expiresIn ?? 0));
      report.refreshed++;
    } catch (err) {
      await store.markIntegrationRefreshNeeded(integration.id, (err as Error).message || 'Token refresh failed — please reconnect');
      report.failed++;
    }
  }
  return report;
}
