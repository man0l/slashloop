// Set the cover/thumbnail of a post that may already be published.
//
//   not yet published (DRAFT/QUEUE/SCRUB/ERROR) → stored on the media; the
//     provider applies it at publish time (Instagram cover_url, YouTube
//     thumbnails.set).
//   PUBLISHED → only providers with a post-publish API (YouTube thumbnails.set)
//     can change it; the rest report "unsupported" instead of silently
//     succeeding. On success the thumbnail is stored on the media so
//     list_social_posts echoes it.

import { assertPublicHttpUrl } from './fetch.js';
import { BadBodyError, RefreshTokenError, isAuthFailure } from './errors.js';
import { createRegistry, getProvider } from './registry.js';
import * as store from './store.js';
import type { MediaContent, SocialConfig, SocialIntegrationRow, SocialPostRow, SocialProvider } from './types.js';

export type ThumbnailStatus = 'updated' | 'saved' | 'unsupported' | 'processing' | 'skipped' | 'failed';

export interface ThumbnailResult {
  postId: string;
  provider: string;
  status: ThumbnailStatus;
  message?: string;
}

export interface ThumbnailTarget {
  groupId?: string;
  postId?: string;
}

export type SetThumbnailOutcome =
  | { ok: true; results: ThumbnailResult[] }
  | { ok: false; error: 'invalid_thumbnail' | 'missing_target'; message: string };

const NOT_SUPPORTED: Record<string, string> = {
  instagram: 'Not supported by Instagram: the Graph API cannot change the cover of a published Reel. Set it in the Instagram app (Edit → Cover), or re-post with a thumbnail.',
};

export async function setPostThumbnail(
  cfg: SocialConfig,
  owners: string[],
  target: ThumbnailTarget,
  thumbnailUrl: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SetThumbnailOutcome> {
  if (!target.groupId && !target.postId) return { ok: false, error: 'missing_target', message: 'Pass groupId or postId.' };
  try {
    assertPublicHttpUrl(thumbnailUrl, 'thumbnail');
  } catch (err) {
    return { ok: false, error: 'invalid_thumbnail', message: (err as Error).message };
  }

  const found: SocialPostRow[] = [];
  for (const ownerId of owners) found.push(...(await store.listGroupRows(ownerId, target)));

  const registry = createRegistry(cfg);
  const integrations = new Map<string, SocialIntegrationRow | undefined>();
  const results: ThumbnailResult[] = [];

  for (const row of found) {
    const base = { postId: row.id, provider: row.provider };
    if (row.state === 'PROCESSING') {
      results.push({ ...base, status: 'processing', message: 'The post is publishing right now — try again in a moment.' });
      continue;
    }

    const media = parseMedia(row.media);
    const videoIdx = media.flatMap((m, i) => (m.type === 'video' ? [i] : []));
    if (!videoIdx.length) {
      results.push({ ...base, status: 'skipped', message: 'The post has no video to attach a thumbnail to.' });
      continue;
    }
    const withThumbnail = media.map((m, i) => (videoIdx.includes(i) ? { ...m, thumbnail: thumbnailUrl } : m));

    if (row.state !== 'PUBLISHED') {
      await store.replacePostMedia(row.id, withThumbnail);
      results.push({ ...base, status: 'saved', message: 'Stored; it is applied when the post publishes.' });
      continue;
    }

    const provider = getProvider(registry, row.provider);
    if (!provider.setThumbnail) {
      results.push({ ...base, status: 'unsupported', message: NOT_SUPPORTED[row.provider] ?? `${provider.name} does not allow changing the thumbnail of a published post.` });
      continue;
    }
    if (!row.release_id) {
      results.push({ ...base, status: 'failed', message: 'The published post has no platform id on record.' });
      continue;
    }

    if (!integrations.has(row.integration_id)) integrations.set(row.integration_id, await store.getIntegration(row.integration_id));
    const integration = integrations.get(row.integration_id);
    if (!integration || integration.disabled || integration.refresh_needed) {
      results.push({ ...base, status: 'failed', message: 'The connected account is disconnected — reconnect it first.' });
      continue;
    }

    try {
      await callWithFreshToken(provider, cfg, integration, now, (token) => provider.setThumbnail!({ token, releaseId: row.release_id!, thumbnailUrl }));
      await store.replacePostMedia(row.id, withThumbnail);
      results.push({ ...base, status: 'updated' });
    } catch (err) {
      console.warn(`[social] set thumbnail ${row.provider} post ${row.id}: ${(err as Error).message}`);
      results.push({ ...base, status: 'failed', message: failureMessage(err) });
    }
  }

  return { ok: true, results };
}

function failureMessage(err: unknown): string {
  if (err instanceof BadBodyError) return err.message;
  if (err instanceof RefreshTokenError) return 'The platform rejected the account token — reconnect the account.';
  return (err as Error).message || 'Could not set the thumbnail.';
}

export async function callWithFreshToken<T = void>(
  provider: SocialProvider,
  cfg: SocialConfig,
  integration: SocialIntegrationRow,
  now: number,
  call: (token: string) => Promise<T>,
): Promise<T> {
  let refreshed = false;
  const refresh = async () => {
    if (!integration.refresh_token) throw new RefreshTokenError();
    try {
      const fresh = await provider.refreshToken(cfg, integration.refresh_token);
      await store.updateIntegrationTokens(integration.id, fresh.accessToken, fresh.refreshToken, now + (fresh.expiresIn ?? 0));
      integration.token = fresh.accessToken;
      refreshed = true;
    } catch (err) {
      if (isAuthFailure(err)) await store.markIntegrationRefreshNeeded(integration.id, 'Token refresh failed — please reconnect this account');
      throw err;
    }
  };

  if (integration.token_expires_at !== null && integration.token_expires_at <= now + 60) await refresh();
  try {
    return await call(integration.token);
  } catch (err) {
    if (!(err instanceof RefreshTokenError) || refreshed) throw err;
    await refresh();
    return await call(integration.token);
  }
}

function parseMedia(raw: string | null): MediaContent[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as MediaContent[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
