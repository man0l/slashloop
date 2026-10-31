// Pinterest API v5 client — written from Pinterest's official docs
// (developers.pinterest.com/docs/api/v5). Postiz's pinterest.provider.ts was
// used as a behavioral cross-check only (AGPL — no code copied).
//
// Differences from the Meta-family providers in this folder:
//   • A Pin must land on a BOARD. The board is per-post (settings.boardId),
//     chosen in the composer from listDestinations() — the first provider
//     here with a per-post destination.
//   • Image pins are created in one call and are live immediately, so there
//     is no container/poll stage: postPending creates the pin and
//     checkPostStatus reports 'ready' at once.
//   • Video pins go through the media upload flow: register (POST /media) →
//     upload bytes to the returned S3 form → poll /media/{id} until
//     'succeeded' → create the pin with source_type 'video_id'. Pinterest
//     requires a cover image for video pins; we use the media thumbnail.
//   • Token model: access token ~30 days, refresh token ~1 year, standard
//     OAuth2 refresh_token grant with HTTP Basic client auth (unlike Meta,
//     where the secret rides in the body).
//
// Access tiers: a Trial-access app can create pins but they are sandboxed
// (visible only to their creator). Standard access (video demo of the OAuth
// flow + a pin creation through the app) makes them public.

import { BadBodyError, RefreshTokenError, isTransientError } from '../errors.js';
import { assertPublicHttpUrl, providerFetch } from '../fetch.js';
import type {
  AuthTokenDetails,
  Destination,
  PendingCheck,
  PostDetails,
  PostResponse,
  ProviderPostContext,
  SocialConfig,
  SocialProvider,
} from '../types.js';

const AUTH = 'https://www.pinterest.com/oauth/';
const API = 'https://api.pinterest.com/v5';
const TOKEN = `${API}/oauth/token`;

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 800;
const CAROUSEL_MAX = 5;

/** Per-post settings the composer writes for a Pinterest integration. */
export interface PinterestPostSettings {
  boardId?: string;
  title?: string;
  link?: string;
  altText?: string;
}

interface PendingState {
  /** Set once the pin exists — image pins get it in postPending. */
  pinId?: string;
  /** Video upload id while the video is still processing. */
  mediaId?: string;
  coverImageUrl?: string;
}

export class PinterestProvider implements SocialProvider {
  identifier = 'pinterest' as const;
  name = 'Pinterest';
  scopes = ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'];

  private clientId = '';
  private clientSecret = '';

  configure(cfg: SocialConfig): void {
    this.clientId = cfg.pinterest?.clientId ?? '';
    this.clientSecret = cfg.pinterest?.clientSecret ?? '';
  }

  classify = (body: string, status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (status === 401) return 'refresh-token';
    if (status === 429) return 'retry';
    try {
      const parsed = JSON.parse(body) as { code?: number; message?: string };
      // v5 error codes: 2 = authentication failed, 3 = authorization failed
      // (scope missing / revoked), 29 = rate limit.
      if (parsed.code === 2) return 'refresh-token';
      if (parsed.code === 3) return 'reconnect';
      if (parsed.code === 29) return 'retry';
    } catch {
      /* non-JSON body */
    }
    return status >= 500 ? 'retry' : status >= 400 ? 'bad-body' : undefined;
  };

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    this.configure(cfg);
    if (!this.clientId) throw new BadBodyError('Pinterest app is not configured');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(','),
      state,
    });
    return `${AUTH}?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    if (!this.clientId || !this.clientSecret) throw new BadBodyError('Pinterest app is not configured');

    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    if (!token.access_token) throw new BadBodyError(token.message || 'Pinterest did not return an access token');
    return this.withUserInfo(String(token.access_token), token.refresh_token ? String(token.refresh_token) : undefined, Number(token.expires_in) || undefined);
  }

  async refreshToken(cfg: SocialConfig, refreshToken: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    const renewed = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: this.scopes.join(','),
    }).catch((err) => {
      if (err instanceof RefreshTokenError || isTransientError(err)) throw err;
      throw new RefreshTokenError('Pinterest token renewal failed — please reconnect this account');
    });
    if (!renewed?.access_token) {
      throw new RefreshTokenError(renewed?.message || 'Pinterest token renewal failed — please reconnect this account');
    }
    // Pinterest keeps the same refresh token unless continuous refresh is
    // enabled; keep whichever we have so the next renewal still works.
    const nextRefresh = renewed.refresh_token ? String(renewed.refresh_token) : refreshToken;
    return this.withUserInfo(String(renewed.access_token), nextRefresh, Number(renewed.expires_in) || undefined);
  }

  /** Boards the connected account can pin to — the composer's board picker. */
  async listDestinations(_cfg: SocialConfig, token: string): Promise<Destination[]> {
    const boards: Destination[] = [];
    let bookmark: string | undefined;
    do {
      const params: Record<string, string> = { page_size: '100', privacy: 'ALL' };
      if (bookmark) params.bookmark = bookmark;
      const page = await this.api<{ items?: Array<{ id: string; name: string; privacy?: string }>; bookmark?: string | null }>(
        'GET',
        `/boards?${new URLSearchParams(params).toString()}`,
        token,
      );
      for (const board of page.items ?? []) {
        boards.push({ id: String(board.id), name: board.privacy === 'SECRET' ? `${board.name} (secret)` : board.name });
      }
      bookmark = page.bookmark ?? undefined;
    } while (bookmark && boards.length < 500);
    return boards;
  }

  checkValidity(post: PostDetails): string | true {
    const settings = post.settings as PinterestPostSettings;
    if (!settings?.boardId) return 'Pick a Pinterest board for this post';
    const media = post.media ?? [];
    if (!media.length) return 'Pinterest pins need a photo or video';
    const videos = media.filter((m) => m.type === 'video' || m.url.toLowerCase().includes('.mp4'));
    if (videos.length > 1) return 'Pinterest pins take one video';
    if (videos.length === 1 && media.length > 1) return 'Pinterest pins cannot mix video and images';
    if (media.length > CAROUSEL_MAX) return `Pinterest carousels take at most ${CAROUSEL_MAX} images`;
    if ((settings.title ?? '').length > TITLE_MAX) return `Pinterest titles are limited to ${TITLE_MAX} characters`;
    if (post.message.length > DESCRIPTION_MAX) return `Pinterest descriptions are limited to ${DESCRIPTION_MAX} characters`;
    if (settings.link) {
      try {
        const url = new URL(settings.link);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Pinterest destination link must be http(s)';
      } catch {
        return 'Pinterest destination link is not a valid URL';
      }
    }
    return true;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const settings = ctx.post.settings as PinterestPostSettings;
    const medias = ctx.post.media.map((m) => ({ ...m, url: assertPublicHttpUrl(m.url, 'media') }));
    const isVideo = medias.length === 1 && (medias[0].type === 'video' || medias[0].url.toLowerCase().includes('.mp4'));

    if (!isVideo) {
      const mediaSource =
        medias.length === 1
          ? { source_type: 'image_url', url: medias[0].url }
          : { source_type: 'multiple_image_urls', items: medias.map((m) => ({ url: m.url })) };
      const pin = await this.createPin(ctx.token, settings, ctx.post.message, mediaSource);
      const state: PendingState = { pinId: pin.id };
      return { pendingData: { ...state } };
    }

    // Video: register an upload, push the bytes, then poll (checkPostStatus).
    const coverImageUrl = medias[0].thumbnail ? assertPublicHttpUrl(medias[0].thumbnail, 'cover image') : undefined;
    if (!coverImageUrl) throw new BadBodyError('Pinterest video pins need a cover image — add a thumbnail to the video');

    const registered = await this.api<{ media_id?: string; upload_url?: string; upload_parameters?: Record<string, string> }>('POST', '/media', ctx.token, {
      media_type: 'video',
    });
    if (!registered.media_id || !registered.upload_url) throw new BadBodyError('Pinterest did not open a video upload');

    const video = await fetch(medias[0].url);
    if (!video.ok || !video.body) throw new BadBodyError('Could not fetch the video for Pinterest upload');
    const form = new FormData();
    for (const [key, value] of Object.entries(registered.upload_parameters ?? {})) form.append(key, value);
    form.append('file', await video.blob(), 'video.mp4');
    const upload = await fetch(registered.upload_url, { method: 'POST', body: form });
    if (!upload.ok && upload.status !== 204) throw new BadBodyError(`Pinterest video upload failed (${upload.status})`);

    const state: PendingState = { mediaId: registered.media_id, coverImageUrl };
    return { pendingData: { ...state } };
  }

  async checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck> {
    const state = (ctx.pendingData ?? {}) as PendingState;
    if (state.pinId) return { status: 'ready', pendingData: { ...ctx.pendingData } };
    if (!state.mediaId) throw new BadBodyError('Pinterest pending state is missing its upload');

    let media: { status?: string };
    try {
      media = await this.api<{ status?: string }>('GET', `/media/${state.mediaId}`, ctx.token);
    } catch (err) {
      if (err instanceof BadBodyError || err instanceof RefreshTokenError) throw err;
      return { status: 'pending', pendingData: { ...ctx.pendingData } };
    }
    if (media.status === 'failed') throw new BadBodyError('Pinterest could not process the video');
    if (media.status !== 'succeeded') return { status: 'pending', pendingData: { ...ctx.pendingData } };
    return { status: 'ready', pendingData: { ...ctx.pendingData } };
  }

  async finalizePost(ctx: ProviderPostContext): Promise<PendingCheck> {
    const state = { ...(ctx.pendingData ?? {}) } as PendingState;
    const settings = ctx.post.settings as PinterestPostSettings;

    if (!state.pinId) {
      if (!state.mediaId) throw new BadBodyError('Pinterest pending state has nothing to publish');
      // Same exposure as Instagram's media_publish: a crash between this call
      // and the engine persisting 'completed' would re-create the pin on
      // retry. The window is one DB write; acceptable for v1.
      const pin = await this.createPin(ctx.token, settings, ctx.post.message, {
        source_type: 'video_id',
        media_id: state.mediaId,
        cover_image_url: state.coverImageUrl,
      });
      state.pinId = pin.id;
    }

    return { status: 'completed', postId: state.pinId, releaseUrl: `https://www.pinterest.com/pin/${state.pinId}/` };
  }

  private async createPin(token: string, settings: PinterestPostSettings, description: string, mediaSource: Record<string, unknown>): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      board_id: settings.boardId,
      description: description.slice(0, DESCRIPTION_MAX),
      media_source: mediaSource,
    };
    if (settings.title) body.title = settings.title.slice(0, TITLE_MAX);
    if (settings.link) body.link = settings.link;
    if (settings.altText) body.alt_text = settings.altText.slice(0, 500);
    const created = await this.api<{ id?: string | number; message?: string }>('POST', '/pins', token, body);
    if (!created.id) throw new BadBodyError(created.message || 'Pinterest did not create the pin');
    return { id: String(created.id) };
  }

  private async withUserInfo(accessToken: string, refreshToken: string | undefined, expiresIn?: number): Promise<AuthTokenDetails> {
    const me = await this.api<Record<string, any>>('GET', '/user_account', accessToken);
    const username = String(me?.username ?? '');
    const internalId = String(me?.id ?? username);
    if (!internalId) throw new BadBodyError('No Pinterest account found for this token');
    return {
      accessToken,
      refreshToken,
      expiresIn: expiresIn ?? 30 * 24 * 3600,
      internalId,
      name: me?.business_name ?? username ?? 'Pinterest account',
      profile: username || internalId,
      picture: me?.profile_image,
    };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, any>> {
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const response = await providerFetch(TOKEN, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      classify: this.classify,
    });
    return (await response.json()) as Record<string, any>;
  }

  private async api<T = Record<string, any>>(method: 'GET' | 'POST', path: string, token: string, body?: Record<string, unknown>): Promise<T> {
    const response = await providerFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      classify: this.classify,
    });
    return (await response.json()) as T;
  }
}
