// Instagram Graph API client (Business/Creator accounts, Facebook Login) —
// rewritten from Meta's official docs (developers.facebook.com/docs/
// instagram-api), Postiz's instagram.provider.ts used as a behavioral
// cross-check only (AGPL — no code copied).
//
// Flow: create invisible media container(s) by public media URL → poll each
// container's status_code until FINISHED → media_publish → permalink. The
// publish step lives in finalizePost with published ids recorded in
// pendingData, so a retry after a mid-publish crash skips the already-live
// containers instead of duplicating them.
//
// Publishing requires a PAGE access token for the Facebook Page linked to
// the IG account (graph.facebook.com login) — resolveIgAccount stores that
// page token as the integration token. Meta has no refresh-token rotation:
// the long-lived user token renews by exchanging itself, so the current
// user token is stored as both refresh_token and the re-derivation source.

import { BadBodyError, RefreshTokenError } from '../errors.js';
import { assertPublicHttpUrl, providerFetch } from '../fetch.js';
import type { AuthTokenDetails, PendingCheck, PostDetails, PostResponse, ProviderPostContext, SocialConfig, SocialProvider } from '../types.js';

interface Container {
  creationId: string;
  kind: 'single' | 'carousel-child' | 'carousel';
  published: boolean;
}

export class InstagramProvider implements SocialProvider {
  identifier = 'instagram' as const;
  name = 'Instagram';
  scopes = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'];

  private graphVersion = 'v21.0';
  private clientId = '';
  private clientSecret = '';

  configure(cfg: SocialConfig): void {
    this.graphVersion = cfg.instagram?.graphVersion ?? this.graphVersion;
    this.clientId = cfg.instagram?.clientId ?? '';
    this.clientSecret = cfg.instagram?.clientSecret ?? '';
  }

  classify = (body: string, status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (status === 401) return 'refresh-token';
    try {
      const parsed = JSON.parse(body) as { error?: { code?: number; message?: string } };
      const code = parsed?.error?.code;
      if (code === 190) return 'refresh-token'; // expired/invalid token
      if (code === 4 || code === 17 || code === 32) return 'retry'; // rate limits
    } catch {
      /* non-JSON body */
    }
    return status >= 500 ? 'retry' : status >= 400 ? 'bad-body' : undefined;
  };

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    this.configure(cfg);
    if (!this.clientId) throw new BadBodyError('Instagram app is not configured');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: this.scopes.join(','),
    });
    return `https://www.facebook.com/${this.graphVersion}/dialog/oauth?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    if (!this.clientId || !this.clientSecret) throw new BadBodyError('Instagram app is not configured');

    // Short-lived user token → long-lived (~60d) via fb_exchange_token.
    const short = await this.graph<{ access_token?: string; error?: { message?: string } }>(`/oauth/access_token`, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      code,
    });
    if (!short.access_token) throw new BadBodyError(short.error?.message || 'Meta did not return an access token');

    const long = await this.graph<{ access_token?: string; expires_in?: number; error?: { message?: string } }>(`/oauth/access_token`, {
      grant_type: 'fb_exchange_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      fb_exchange_token: short.access_token,
    });
    if (!long.access_token) throw new BadBodyError(long.error?.message || 'Meta long-lived token exchange failed');

    return this.resolveIgAccount(long.access_token, long.expires_in);
  }

  async refreshToken(_cfg: SocialConfig, userToken: string): Promise<AuthTokenDetails> {
    // Meta long-lived user tokens renew by exchanging themselves (must be
    // ≥24h old). Failure here means the user must reconnect — there is no
    // refresh-token rotation on this platform.
    const renewed = await this.graph<{ access_token?: string; expires_in?: number; error?: { message?: string } }>(`/oauth/access_token`, {
      grant_type: 'fb_exchange_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      fb_exchange_token: userToken,
    }).catch((err) => {
      if (err instanceof RefreshTokenError) throw err;
      throw new RefreshTokenError('Meta token renewal failed — please reconnect this account');
    });

    if (!renewed.access_token) {
      throw new RefreshTokenError(renewed.error?.message || 'Meta token renewal failed — please reconnect this account');
    }
    return this.resolveIgAccount(renewed.access_token, renewed.expires_in);
  }

  checkValidity(post: PostDetails): string | true {
    if (!post.media?.length) return 'Instagram posts need at least one photo or video';
    if (post.media.length > 10) return 'Instagram carousels take at most 10 items';
    return true;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const igId = ctx.integration.internalId;
    const medias = ctx.post.media.map((m) => ({ ...m, url: assertPublicHttpUrl(m.url, 'media') }));
    const isCarousel = medias.length > 1;
    const containers: Container[] = [];

    for (const media of medias) {
      const params: Record<string, string> = { access_token: ctx.token };
      if (media.url.toLowerCase().includes('.mp4')) {
        params.video_url = media.url;
        params.media_type = isCarousel ? 'VIDEO' : 'REELS';
      } else {
        params.image_url = media.url;
        if (isCarousel) params.media_type = 'IMAGE';
      }
      if (!isCarousel) {
        // Caption rides on the single container — Meta rejects captions on
        // carousel children (the caption goes on the CAROUSEL container).
        params.caption = ctx.post.message;
      }

      const created = await this.graph<{ id?: string }>(`/${igId}/media`, params);
      if (!created.id) throw new BadBodyError('Instagram did not create the media container');
      containers.push({ creationId: created.id, kind: isCarousel ? 'carousel-child' : 'single', published: false });
    }

    if (isCarousel) {
      const created = await this.graph<{ id?: string }>(`/${igId}/media`, {
        access_token: ctx.token,
        media_type: 'CAROUSEL',
        children: containers.map((c) => c.creationId).join(','),
        caption: ctx.post.message,
      });
      if (!created.id) throw new BadBodyError('Instagram did not create the carousel container');
      containers.push({ creationId: created.id, kind: 'carousel', published: false });
    }

    return { pendingData: { containers, publishedIds: [] } };
  }

  async checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck> {
    const containers = (ctx.pendingData?.containers as Container[] | undefined) ?? [];
    if (!containers.length) throw new BadBodyError('Instagram pending state is missing its containers');

    for (const container of containers) {
      if (container.published) continue;
      let status: { status_code?: string; status?: string };
      try {
        status = await this.graph(`/${container.creationId}`, { access_token: ctx.token, fields: 'status_code,status' });
      } catch (err) {
        // Transient poll errors must not fail the post — the container may
        // already be FINISHED; keep pending so the engine checks next tick.
        if (err instanceof BadBodyError || err instanceof RefreshTokenError) throw err;
        return { status: 'pending', pendingData: { ...ctx.pendingData } };
      }
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new BadBodyError(status.status || 'Instagram rejected the media container');
      }
      if (status.status_code !== 'FINISHED') {
        return { status: 'pending', pendingData: { ...ctx.pendingData } };
      }
    }

    return { status: 'ready', pendingData: { ...ctx.pendingData } };
  }

  async finalizePost(ctx: ProviderPostContext): Promise<PendingCheck> {
    const containers = ((ctx.pendingData?.containers as Container[] | undefined) ?? []).map((c) => ({ ...c }));
    const publishedIds = ((ctx.pendingData?.publishedIds as string[] | undefined) ?? []).slice();
    const igId = ctx.integration.internalId;

    for (const container of containers) {
      // Carousel children publish through the CAROUSEL container — skip them.
      if (container.published || container.kind === 'carousel-child') continue;

      const result = await this.graph<{ id?: string }>(`/${igId}/media_publish`, {
        access_token: ctx.token,
        creation_id: container.creationId,
      });
      container.published = true;
      if (result.id) publishedIds.push(String(result.id));
    }

    const publishable = containers.filter((c) => c.kind !== 'carousel-child');
    if (!publishable.length) throw new BadBodyError('Instagram pending state has no publishable container');
    if (!publishable.every((c) => c.published)) {
      return { status: 'pending', pendingData: { ...ctx.pendingData, containers, publishedIds } };
    }
    if (!publishedIds.length) {
      throw new BadBodyError('Instagram publish produced no post id');
    }

    const permalink = await this.graph<{ permalink?: string }>(`/${publishedIds[0]}`, {
      access_token: ctx.token,
      fields: 'permalink',
    })
      .then((r) => String(r.permalink ?? ''))
      .catch(() => '');

    return { status: 'completed', postId: publishedIds[publishedIds.length - 1], releaseUrl: permalink || 'https://www.instagram.com/' };
  }

  /** Pick the first Page that has a linked Instagram Business account; the
   *  PAGE access token (not the user token) is what container/publish calls
   *  require. internalId = IG user id, profile = IG username. */
  private async resolveIgAccount(userToken: string, expiresIn?: number): Promise<AuthTokenDetails> {
    const pages = await this.graph<Record<string, any>>(`/me/accounts`, {
      access_token: userToken,
      fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}',
    });

    for (const page of pages?.data ?? []) {
      const ig = page?.instagram_business_account;
      if (!ig?.id) continue;
      return {
        accessToken: page.access_token ?? userToken,
        refreshToken: userToken, // the renewable long-lived user token
        expiresIn: expiresIn ?? 60 * 24 * 3600,
        internalId: String(ig.id),
        name: page.name ?? ig.username ?? 'Instagram account',
        profile: ig.username ?? String(ig.id),
        picture: ig.profile_picture_url,
      };
    }
    throw new BadBodyError('No Instagram Business/Creator account found — link one to a Facebook Page first');
  }

  private async graph<T = Record<string, any>>(path: string, params: Record<string, string>): Promise<T> {
    const url = `https://graph.facebook.com/${this.graphVersion}${path}?${new URLSearchParams(params).toString()}`;
    const response = await providerFetch(url, { classify: this.classify });
    return (await response.json()) as T;
  }
}
