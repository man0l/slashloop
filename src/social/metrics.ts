// Post metrics sync — views, likes, comments and the platform-specific
// counters (METRIC_KEYS: saves, shares, reposts, reach, clicks…) for published posts, shown
// on the calendar. Rides the social cron tick (api/cron/social.ts, */2) like
// the token-refresh scan: one indexed LIMIT query that returns zero rows
// between due syncs, so no extra cron trigger is needed.
//
// Cadence (decays with post age, anchored on published_at):
//   first 12h      → every 10 minutes
//   next 48h       → hourly
//   after that     → daily
//
// A failed sync — or a stale read whose views went backwards — keeps the last
// counters and retries on the normal cadence; a credential failure flags the
// account exactly like the publish path does.

import { createRegistry, getProvider } from './registry.js';
import * as store from './store.js';
import { isAuthFailure, isSubrequestLimit, RefreshTokenError } from './errors.js';
import { METRIC_KEYS } from './types.js';
import type { MetricKey, MetricsContext, PostMetrics, SocialConfig, SocialIntegrationRow, SocialPostRow } from './types.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/** Seconds until the next sync for a post `ageSeconds` after publishing. */
export function metricsInterval(ageSeconds: number): number {
  if (ageSeconds < 12 * HOUR) return 10 * MINUTE;
  if (ageSeconds < 60 * HOUR) return HOUR;
  return 24 * HOUR;
}

export function nextMetricsAt(publishedAt: number, now: number): number {
  return now + metricsInterval(Math.max(0, now - publishedAt));
}

export interface MetricsTickOptions {
  /** Max posts synced per tick (shares the cron's subrequest budget). */
  limit?: number;
  nowSeconds?: number;
}

export interface MetricsReport {
  due: number;
  synced: number;
  /** Fetched fine but views went backwards — last counters kept. */
  stale: number;
  failed: number;
}

export async function socialMetricsTick(cfg: SocialConfig, options: MetricsTickOptions = {}): Promise<MetricsReport> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const registry = createRegistry(cfg);
  const providers = [...registry.values()].filter((p) => typeof p.fetchMetrics === 'function').map((p) => p.identifier);
  const due = await store.postsDueForMetrics(providers, options.limit ?? 6, now);
  const report: MetricsReport = { due: due.length, synced: 0, stale: 0, failed: 0 };
  if (!due.length) return report;

  const integrations = new Map<string, SocialIntegrationRow | undefined>();
  const updates: store.MetricsUpdate[] = [];
  const insights = new Map<string, string>();

  for (const post of due) {
    const nextAt = nextMetricsAt(post.published_at ?? post.publish_date, now);
    if (!integrations.has(post.integration_id)) integrations.set(post.integration_id, await store.getIntegration(post.integration_id));
    const integration = integrations.get(post.integration_id);
    if (!integration || integration.disabled || integration.refresh_needed) {
      // Nothing to call with — check back on the slow cadence.
      updates.push({ id: post.id, error: 'Account disconnected', nextAt: now + 24 * HOUR });
      report.failed++;
      continue;
    }
    try {
      const raw = await fetchWithRefresh(registry, cfg, post, integration, now);
      if (raw.insightsStatus && raw.insightsStatus !== integration.insights_status) {
        insights.set(integration.id, raw.insightsStatus);
        integration.insights_status = raw.insightsStatus;
        if (raw.insightsStatus !== 'ok') console.warn(`[social] insights unavailable for ${post.provider} account ${integration.id}: ${raw.insightsStatus}`);
      }
      const metrics = normalize(raw);
      if (isStaleRead(post, metrics)) {
        // Lifetime views don't shrink; a drop (YouTube answers 0 from a lagging
        // replica on fresh uploads) is a stale read — keep the last counters.
        console.info(`[social] metrics ${post.provider} post ${post.id}: stale read (views ${post.views} → ${metrics.views}), kept last counters`);
        updates.push({ id: post.id, error: null, nextAt });
        report.stale++;
        continue;
      }
      updates.push({ id: post.id, metrics, ...(raw.retention ? { retention: raw.retention } : {}), nextAt });
      report.synced++;
    } catch (err) {
      // Invocation fetch cap: every later call fails too — the rest stay due.
      if (isSubrequestLimit(err)) break;
      const message = (err as Error).message || 'metrics sync failed';
      console.warn(`[social] metrics ${post.provider} post ${post.id}: ${message}`);
      updates.push({ id: post.id, error: message, nextAt });
      report.failed++;
    }
  }

  await store.saveMetrics(updates, now);
  await store.saveInsightsStatus(insights);
  return report;
}

async function fetchWithRefresh(
  registry: ReturnType<typeof createRegistry>,
  cfg: SocialConfig,
  post: SocialPostRow,
  integration: SocialIntegrationRow,
  now: number,
): Promise<PostMetrics> {
  const provider = getProvider(registry, post.provider);
  const ctx: MetricsContext = {
    token: integration.token,
    releaseId: post.release_id ?? '',
    releaseUrl: post.release_url,
    integration: { internalId: integration.internal_id, profile: integration.profile ?? '' },
    publishedAt: post.published_at ?? post.publish_date,
  };

  const expired = integration.token_expires_at !== null && integration.token_expires_at <= now + 60;
  let refreshed = false;
  const refresh = async () => {
    if (!integration.refresh_token) throw new RefreshTokenError();
    try {
      const fresh = await provider.refreshToken(cfg, integration.refresh_token);
      await store.updateIntegrationTokens(integration.id, fresh.accessToken, fresh.refreshToken, now + (fresh.expiresIn ?? 0));
      // Later posts on the same account reuse the cached row.
      integration.token = fresh.accessToken;
      integration.token_expires_at = now + (fresh.expiresIn ?? 0);
      ctx.token = fresh.accessToken;
      refreshed = true;
    } catch (err) {
      if (isAuthFailure(err)) await store.markIntegrationRefreshNeeded(integration.id, 'Token refresh failed — please reconnect this account');
      throw err;
    }
  };

  if (expired) await refresh();
  try {
    return await provider.fetchMetrics!(ctx);
  } catch (err) {
    if (!(err instanceof RefreshTokenError) || refreshed) throw err;
    await refresh();
    return await provider.fetchMetrics!(ctx);
  }
}

/** Views went backwards since the last stored sync. */
function isStaleRead(post: SocialPostRow, metrics: Record<MetricKey, number | null>): boolean {
  const before = post.views;
  return typeof before === 'number' && before > 0 && metrics.views !== null && metrics.views < before;
}

function normalize(m: PostMetrics): Record<MetricKey, number | null> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, n(m[k])])) as Record<MetricKey, number | null>;
}
