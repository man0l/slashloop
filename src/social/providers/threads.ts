// Threads API client — written from Meta's official Threads docs
// (developers.facebook.com/docs/threads), modeling the container lifecycle
// on the Instagram provider in this repo (same Postiz-derived engine
// contract): create container(s) → poll status until FINISHED → publish.
// Token model mirrors Instagram's: no refresh-token rotation — the long-lived
// user token (~60d) renews by exchanging itself (must be ≥24h old), so the
// current user token is stored as both refresh_token and re-derivation
// source. Short-lived code-exchange tokens (~1h) are immediately swapped for
// long-lived ones at connect time.

import { BadBodyError, RefreshTokenError } from '../errors.js';
import { assertPublicHttpUrl, providerFetch } from '../fetch.js';
import type { AuthTokenDetails, PendingCheck, PostDetails, PostResponse, ProviderId, ProviderPostContext, SocialConfig, SocialProvider } from '../types.js';

const AUTH = 'https://www.threads.com/oauth/authorize';
const TOKEN = 'https://graph.threads.net/oauth/access_token';
const API = 'https://graph.threads.net/v1.0';

interface Container {
  creationId: string;
  kind: 'single' | 'carousel-child' | 'carousel';
  published: boolean;
}

export class ThreadsProvider implements SocialProvider {
  identifier: ProviderId = 'threads';
  name = 'Threads';
  scopes = ['threads_basic', 'threads_content_publish'];

  classify = (body: string, status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (status === 401) return 'refresh-token';
    try {
      const parsed = JSON.parse(body) as { error?: { code?: number; message?: string; error_subcode?: number } };
      const code = parsed?.error?.code;
      if (code === 190) return 'refresh-token'; // expired/invalid token
      if (code === 4 || code === 17 || code === 32) return 'retry'; // rate limits
      if (code === 10) return 'reconnect'; // permission revoked by user
    } catch {
      /* non-JSON body */
    }
    return status >= 500 ? 'retry' : status >= 400 ? 'bad-body' : undefined;
  };

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    if (!cfg.threads?.clientId) throw new BadBodyError('Threads app is not configured');
    const params = new URLSearchParams({
      client_id: cfg.threads.clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: this.scopes.join(','),
    });
    return `${AUTH}?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    const clientId = cfg.threads?.clientId;
    const clientSecret = cfg.threads?.clientSecret;
    if (!clientId || !clientSecret) throw new BadBodyError('Threads app is not configured');

    // Short-lived user token (~1h) via the code exchange.
    const short = await providerFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString(),
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>);
    if (!short.access_token) throw new BadBodyError(short?.error?.message || 'Threads did not return an access token');

    // Immediately swap for a long-lived token (~60d).
    return this.withLongLivedToken(clientSecret, String(short.access_token));
  }

  async refreshToken(_cfg: SocialConfig, userToken: string): Promise<AuthTokenDetails> {
    // Long-lived tokens renew by exchanging themselves (must be ≥24h old).
    // Failure means the user must reconnect — no rotation on this platform.
    const renewed = await providerFetch(`${API}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: userToken }).toString()}`, {
      classify: this.classify,
    })
      .then((r) => r.json() as Promise<Record<string, any>>)
      .catch((err) => {
        if (err instanceof RefreshTokenError) throw err;
        throw new RefreshTokenError('Threads token renewal failed — please reconnect this account');
      });
    if (!renewed?.access_token) {
      throw new RefreshTokenError(renewed?.error?.message || 'Threads token renewal failed — please reconnect this account');
    }
    return this.withUserInfo(String(renewed.access_token), String(renewed.access_token), Number(renewed.expires_in) || undefined);
  }

  private async withLongLivedToken(clientSecret: string, shortToken: string): Promise<AuthTokenDetails> {
    const long = await providerFetch(`${API}/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: clientSecret, access_token: shortToken }).toString()}`, {
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>);
    if (!long?.access_token) throw new BadBodyError(long?.error?.message || 'Threads long-lived token exchange failed');
    return this.withUserInfo(String(long.access_token), String(long.access_token), Number(long.expires_in) || undefined);
  }

  private async withUserInfo(accessToken: string, userToken: string, expiresIn?: number): Promise<AuthTokenDetails> {
    const me = await providerFetch(`${API}/me?${new URLSearchParams({ fields: 'id,username,threads_profile_picture_url', access_token: accessToken }).toString()}`, {
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>);
    const internalId = String(me?.id ?? '');
    if (!internalId) throw new BadBodyError('No Threads profile found for this account');
    return {
      accessToken,
      refreshToken: userToken, // the renewable long-lived user token
      expiresIn: expiresIn ?? 60 * 24 * 3600,
      internalId,
      name: me.username ?? 'Threads account',
      profile: String(me.username ?? internalId).replace(/^@/, ''),
      picture: me.threads_profile_picture_url,
    };
  }

  checkValidity(post: PostDetails): string | true {
    const media = post.media ?? [];
    if (!media.length && !post.message.trim()) return 'Threads posts need text or media';
    if (post.message.length > 500) return 'Threads text is limited to 500 characters';
    if (media.length > 20) return 'Threads carousels take at most 20 items';
    return true;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const userId = ctx.integration.internalId;
    const medias = ctx.post.media.map((m) => ({ ...m, url: m.url.toLowerCase().includes('.mp4') ? assertPublicHttpUrl(m.url, 'video') : m.url }));
    const isCarousel = medias.length > 1;
    const containers: Container[] = [];

    if (!medias.length) {
      // Text-only post.
      const created = await this.threads<{ id?: string }>(`/${userId}/threads`, ctx.token, {
        media_type: 'TEXT',
        text: ctx.post.message.slice(0, 500),
      });
      if (!created.id) throw new BadBodyError('Threads did not create the text container');
      containers.push({ creationId: String(created.id), kind: 'single', published: false });
      return { pendingData: { containers, publishedIds: [] } };
    }

    for (const media of medias) {
      const isVideo = media.url.toLowerCase().includes('.mp4');
      const params: Record<string, string> = { media_type: isVideo ? 'VIDEO' : 'IMAGE' };
      if (isVideo) params.video_url = assertPublicHttpUrl(media.url, 'video');
      else params.image_url = assertPublicHttpUrl(media.url, 'photo');
      if (isCarousel) params.is_carousel_item = 'true';
      else if (ctx.post.message.trim()) params.text = ctx.post.message.slice(0, 500);

      const created = await this.threads<{ id?: string }>(`/${userId}/threads`, ctx.token, params);
      if (!created.id) throw new BadBodyError('Threads did not create the media container');
      containers.push({ creationId: String(created.id), kind: isCarousel ? 'carousel-child' : 'single', published: false });
    }

    if (isCarousel) {
      const created = await this.threads<{ id?: string }>(`/${userId}/threads`, ctx.token, {
        media_type: 'CAROUSEL',
        children: containers.map((c) => c.creationId).join(','),
        ...(ctx.post.message.trim() ? { text: ctx.post.message.slice(0, 500) } : {}),
      });
      if (!created.id) throw new BadBodyError('Threads did not create the carousel container');
      containers.push({ creationId: String(created.id), kind: 'carousel', published: false });
    }

    return { pendingData: { containers, publishedIds: [] } };
  }

  async checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck> {
    const containers = (ctx.pendingData?.containers as Container[] | undefined) ?? [];
    if (!containers.length) throw new BadBodyError('Threads pending state is missing its containers');

    for (const container of containers) {
      if (container.published) continue;
      let status: { status?: string; error_message?: string };
      try {
        status = await this.threads(`/${container.creationId}`, ctx.token, { fields: 'status' });
      } catch (err) {
        // Transient poll errors must not fail the post — the container may
        // already be FINISHED; keep pending so the engine checks next tick.
        if (err instanceof BadBodyError || err instanceof RefreshTokenError) throw err;
        return { status: 'pending', pendingData: { ...ctx.pendingData } };
      }
      if (status.status === 'ERROR') {
        throw new BadBodyError(status.error_message || 'Threads rejected the media container');
      }
      if (status.status !== 'FINISHED') {
        return { status: 'pending', pendingData: { ...ctx.pendingData } };
      }
    }

    return { status: 'ready', pendingData: { ...ctx.pendingData } };
  }

  async finalizePost(ctx: ProviderPostContext): Promise<PendingCheck> {
    const containers = ((ctx.pendingData?.containers as Container[] | undefined) ?? []).map((c) => ({ ...c }));
    const publishedIds = ((ctx.pendingData?.publishedIds as string[] | undefined) ?? []).slice();
    const userId = ctx.integration.internalId;

    for (const container of containers) {
      // Carousel children publish through the CAROUSEL container — skip them.
      if (container.published || container.kind === 'carousel-child') continue;

      const result = await this.threads<{ id?: string }>(`/${userId}/threads_publish`, ctx.token, {
        creation_id: container.creationId,
      });
      container.published = true;
      if (result.id) publishedIds.push(String(result.id));
    }

    const publishable = containers.filter((c) => c.kind !== 'carousel-child');
    if (!publishable.length) throw new BadBodyError('Threads pending state has no publishable container');
    if (!publishable.every((c) => c.published)) {
      return { status: 'pending', pendingData: { ...ctx.pendingData, containers, publishedIds } };
    }
    if (!publishedIds.length) {
      throw new BadBodyError('Threads publish produced no post id');
    }

    const profile = ctx.integration.profile || ctx.integration.internalId;
    const permalink = await this.threads<{ permalink?: string }>(`/${publishedIds[0]}`, ctx.token, { fields: 'permalink' })
      .then((r) => String(r.permalink ?? ''))
      .catch(() => '');
    return { status: 'completed', postId: publishedIds[publishedIds.length - 1], releaseUrl: permalink || `https://www.threads.com/@${profile}` };
  }

  private async threads<T = Record<string, any>>(path: string, token: string, params: Record<string, string>): Promise<T> {
    const response = await providerFetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      classify: this.classify,
    });
    return (await response.json()) as T;
  }
}
