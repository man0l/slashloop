// Instagram API with **Facebook Login** (graph.facebook.com) — the connection
// Meta's Audio API requires ("not supported on the Instagram API with Instagram
// Login", developers.facebook.com/docs/instagram-platform/content-publishing/
// audio-api). Everything after the connect step (containers, polling, publish,
// insights) is the Instagram Login provider's flow on a different host, so this
// class only overrides auth and account resolution and adds searchAudio.
//
// The IG account must be a Business/Creator account linked to a Facebook Page.
// Publishing uses the PAGE access token (stored as the integration token);
// the renewable long-lived USER token is stored as refresh_token, which is what
// the fb_exchange_token renewal re-derives the page token from.
//
// Credentials are the parent **Facebook app** id/secret (SOCIAL_META_FB_*), not
// the Instagram-app pair the Instagram Login provider uses.

import { BadBodyError, RefreshTokenError, isTransientError } from '../errors.js';
import type { AudioSearchContext, AudioTrack, AuthTokenDetails, ProviderId, SocialConfig } from '../types.js';
import { InstagramProvider } from './instagram.js';

const FB_HOST = 'https://graph.facebook.com';

export class InstagramFacebookProvider extends InstagramProvider {
  identifier: ProviderId = 'instagram_fb';
  name = 'Instagram (Facebook Login)';
  scopes = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement', 'business_management'];
  protected supportsAudio = true;
  protected host = FB_HOST;
  private configId = '';

  configure(cfg: SocialConfig): void {
    this.graphVersion = cfg.instagramFb?.graphVersion ?? this.graphVersion;
    this.clientId = cfg.instagramFb?.clientId ?? '';
    this.clientSecret = cfg.instagramFb?.clientSecret ?? '';
    this.configId = cfg.instagramFb?.configId ?? '';
  }

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    this.configure(cfg);
    if (!this.clientId) throw new BadBodyError('Instagram (Facebook Login) app is not configured');
    const params = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, state, response_type: 'code' });
    // Business-type apps use Facebook Login for Business: a config_id carries
    // the permission set and `scope` is not accepted alongside it.
    if (this.configId) params.set('config_id', this.configId);
    else params.set('scope', this.scopes.join(','));
    return `https://www.facebook.com/${this.graphVersion}/dialog/oauth?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    if (!this.clientId || !this.clientSecret) throw new BadBodyError('Instagram (Facebook Login) app is not configured');

    const short = await this.graph<{ access_token?: string; error?: { message?: string } }>('/oauth/access_token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    if (!short.access_token) throw new BadBodyError(short.error?.message || 'Meta did not return an access token');
    return this.exchangeLongLived(short.access_token);
  }

  async refreshToken(cfg: SocialConfig, userToken: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    // Long-lived user tokens renew by exchanging themselves; failure = reconnect.
    return this.exchangeLongLived(userToken).catch((err) => {
      if (err instanceof RefreshTokenError || isTransientError(err)) throw err;
      throw new RefreshTokenError('Meta token renewal failed — please reconnect this account');
    });
  }

  async searchAudio(ctx: AudioSearchContext): Promise<AudioTrack[]> {
    const params: Record<string, string> = { audio_type: 'music', user_id: ctx.internalId, access_token: ctx.token };
    if (ctx.query?.trim()) params.search_query = ctx.query.trim();
    const res = await this.graph<{ audio?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }>('/ig_audio', params);
    return (res.audio ?? res.data ?? []).slice(0, ctx.limit).flatMap((t) => {
      const id = t.audio_id ?? t.id;
      if (id === undefined || id === null) return [];
      const duration = Number(t.duration_in_ms);
      return [{
        id: String(id),
        title: String(t.title ?? ''),
        artist: String(t.display_artist ?? ''),
        durationMs: Number.isFinite(duration) ? duration : null,
      }];
    });
  }

  private async exchangeLongLived(token: string): Promise<AuthTokenDetails> {
    const long = await this.graph<{ access_token?: string; expires_in?: number; error?: { message?: string } }>('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      fb_exchange_token: token,
    });
    if (!long.access_token) throw new BadBodyError(long.error?.message || 'Meta long-lived token exchange failed');
    return this.resolveIgAccount(long.access_token, long.expires_in);
  }

  /** First Page with a linked IG Business account; its PAGE token publishes. */
  private async resolveIgAccount(userToken: string, expiresIn?: number): Promise<AuthTokenDetails> {
    const pages = await this.graph<Record<string, any>>('/me/accounts', {
      access_token: userToken,
      fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}',
    });
    for (const page of pages?.data ?? []) {
      const ig = page?.instagram_business_account;
      if (!ig?.id) continue;
      return {
        accessToken: page.access_token ?? userToken,
        refreshToken: userToken,
        expiresIn: expiresIn ?? 60 * 24 * 3600,
        internalId: String(ig.id),
        name: page.name ?? ig.username ?? 'Instagram account',
        profile: String(ig.username ?? ig.id).replace(/^@/, ''),
        picture: ig.profile_picture_url,
      };
    }
    throw new BadBodyError('No Instagram Business/Creator account found — link one to a Facebook Page first');
  }
}
