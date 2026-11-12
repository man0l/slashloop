// Instagram Audio API catalogue search for the search_instagram_audio tool.
// Only Facebook Login connections (provider instagram_fb) can read the
// catalogue or attach a track; Instagram Login accounts get a pointed error.

import { BadBodyError, RefreshTokenError } from './errors.js';
import { createRegistry, getProvider } from './registry.js';
import * as store from './store.js';
import { callWithFreshToken } from './thumbnail.js';
import type { AudioTrack, SocialConfig } from './types.js';

export type AudioSearchOutcome =
  | { ok: true; handle: string; trending: boolean; tracks: AudioTrack[] }
  | { ok: false; error: 'account_not_found' | 'reconnect_required' | 'audio_unsupported' | 'audio_search_failed'; message: string };

export const AUDIO_SEARCH_DEFAULT_LIMIT = 20;
export const AUDIO_SEARCH_MAX_LIMIT = 50;

export async function searchInstagramAudio(
  cfg: SocialConfig,
  owners: string[],
  integrationId: string,
  query: string | undefined,
  limit = AUDIO_SEARCH_DEFAULT_LIMIT,
  now = Math.floor(Date.now() / 1000),
): Promise<AudioSearchOutcome> {
  const integration = await store.getIntegration(integrationId);
  if (!integration || !owners.includes(integration.owner_id) || !integration.provider.startsWith('instagram')) {
    return { ok: false, error: 'account_not_found', message: 'No visible Instagram account has that id. Call list_social_accounts.' };
  }
  const provider = getProvider(createRegistry(cfg), integration.provider);
  if (!provider.searchAudio) {
    return {
      ok: false,
      error: 'audio_unsupported',
      message: 'This account is connected through Instagram Login, which Meta\'s Audio API does not support. Reconnect it through Facebook Login (provider instagram_fb) to search and attach music.',
    };
  }
  if (integration.disabled || integration.refresh_needed) {
    return { ok: false, error: 'reconnect_required', message: 'The account needs to be reconnected in the web app first.' };
  }

  const q = query?.trim() || undefined;
  try {
    const tracks = await callWithFreshToken(provider, cfg, integration, now, (token) =>
      provider.searchAudio!({ token, internalId: integration.internal_id, query: q, limit }));
    return { ok: true, handle: integration.profile || integration.name || integration.internal_id, trending: !q, tracks };
  } catch (err) {
    if (err instanceof RefreshTokenError) return { ok: false, error: 'reconnect_required', message: 'Meta rejected the account token — reconnect the account.' };
    const message = err instanceof BadBodyError ? err.message : (err as Error).message;
    return { ok: false, error: 'audio_search_failed', message: message || 'Audio search failed.' };
  }
}
