// Instagram API client using **Instagram Login** (Business/Creator accounts)
// — written from Meta's official docs (developers.facebook.com/docs/
// instagram-platform/instagram-api-with-instagram-login). Postiz's
// instagram.standalone.provider.ts was used as a behavioral cross-check only
// (AGPL — no code copied).
//
// Why Instagram Login and not Facebook Login: the slashloop Meta app is a
// Business-type app whose "Facebook Login for Business" product requires a
// config_id (no plain `scope` dialog), and Facebook Login additionally
// requires the IG account to be linked to a Facebook Page. Instagram Login
// needs neither — the creator authorizes on instagram.com directly, and the
// app's "Instagram Tester" role (dev mode) / app review (live) gates access.
//
// Flow: create invisible media container(s) by public media URL → poll each
// container's status_code until FINISHED → media_publish → permalink. The
// publish step lives in finalizePost with published ids recorded in
// pendingData, so a retry after a mid-publish crash skips the already-live
// containers instead of duplicating them.
//
// Token model: the code exchange yields a short-lived (~1h) token that is
// immediately swapped for a long-lived (~60d) one. Meta has no refresh-token
// rotation — the long-lived token renews by refreshing itself (must be ≥24h
// old and unexpired), so the current token is stored as both access_token
// and refresh_token.
//
// NOTE: the client id/secret here are the **Instagram app** credentials shown
// under "API setup with Instagram login" in the Meta app dashboard — NOT the
// parent Facebook app id/secret. (SOCIAL_META_CLIENT_ID / _SECRET)

import { BadBodyError, ReconnectError, RefreshTokenError, TransientProviderError, isTransientError } from '../errors.js';
import { assertPublicHttpUrl, providerFetch } from '../fetch.js';
import { num } from '../metrics-util.js';
import type {
  AuthTokenDetails,
  MetricsContext,
  PendingCheck,
  PostDetails,
  PostMetrics,
  PostResponse,
  ProviderId,
  ProviderPostContext,
  SocialConfig,
  SocialProvider,
} from '../types.js';

const AUTH = 'https://www.instagram.com/oauth/authorize';
const TOKEN = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';

// Without cover_url/thumb_offset Instagram uses frame 0 of the MP4, which is
// blank for reels that fade their content in. 1s lands on a settled frame.
export const DEFAULT_THUMB_OFFSET_MS = 1000;

// Prefix connect-flow failures with the step that failed — Meta's messages
// ("Unsupported request - method type: get") don't say which call rejected.
async function step<T>(label: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof TransientProviderError) throw new TransientProviderError(`${label}: ${err.message}`, err.detail);
    if (err instanceof BadBodyError) throw new BadBodyError(`${label}: ${err.message}`, err.detail);
    throw err;
  }
}

function thumbOffsetMs(settings: Record<string, unknown> | undefined): number {
  const value = Number(settings?.thumbOffsetMs);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_THUMB_OFFSET_MS;
}

/** Fixed reason code for a refused insights call, so list_social_accounts can
 *  tell the scheduler which accounts cannot report views and what to do. */
export function insightsFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const detail = (err as { detail?: string })?.detail ?? '';
  if (/personal|professional|business or creator|not a (business|creator)/i.test(`${message} ${detail}`)) return 'personal_account';
  if (err instanceof ReconnectError || /permission|scope|manage_insights|\(#10\)|OAuthException/i.test(`${message} ${detail}`)) return 'missing_permission';
  return `error: ${message.replace(/\s+/g, ' ').slice(0, 120)}`;
}

export interface AudioConfiguration {
  audio_id: string;
  audio_volume?: number;
  video_volume?: number;
}

export type AudioParse = { ok: true; value?: AudioConfiguration } | { ok: false; error: string };

/** settings.audio_configuration → the Graph API object. Absent/empty = no
 *  music; anything malformed is an error, never silently dropped. */
export function parseAudioConfiguration(settings: Record<string, unknown> | undefined): AudioParse {
  const raw = settings?.audio_configuration;
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'audio_configuration must be an object: { audio_id, audio_volume?, video_volume? }' };
  const cfg = raw as Record<string, unknown>;
  const id = typeof cfg.audio_id === 'number' ? String(cfg.audio_id) : cfg.audio_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id.trim())) {
    return { ok: false, error: 'audio_configuration.audio_id is required (an id from search_instagram_audio)' };
  }
  const value: AudioConfiguration = { audio_id: id.trim() };
  for (const key of ['audio_volume', 'video_volume'] as const) {
    if (cfg[key] === undefined || cfg[key] === null) continue;
    const n = cfg[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100) {
      return { ok: false, error: `audio_configuration.${key} must be an integer from 1 to 100` };
    }
    value[key] = n;
  }
  return { ok: true, value };
}

export const AUDIO_NEEDS_FACEBOOK_LOGIN =
  'Instagram music needs an account connected through Facebook Login (provider instagram_fb); Meta\'s Audio API is not supported on Instagram Login connections. Reconnect this account via Facebook Login, or remove audio_configuration.';

interface Container {
  creationId: string;
  kind: 'single' | 'carousel-child' | 'carousel';
  published: boolean;
}

export class InstagramProvider implements SocialProvider {
  identifier: ProviderId = 'instagram';
  name = 'Instagram';
  // manage_insights unlocks views/reach/saves/shares in fetchMetrics. Accounts
  // connected before it was requested keep working for publishing; they get
  // the basic counters only until the user reconnects.
  scopes = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'];

  /** Only Facebook Login connections can attach Audio API music. */
  protected supportsAudio = false;
  /** Graph host; the Facebook Login subclass points this at graph.facebook.com. */
  protected host = GRAPH;
  protected graphVersion = 'v21.0';
  protected clientId = '';
  protected clientSecret = '';

  configure(cfg: SocialConfig): void {
    this.graphVersion = cfg.instagram?.graphVersion ?? this.graphVersion;
    this.clientId = cfg.instagram?.clientId ?? '';
    this.clientSecret = cfg.instagram?.clientSecret ?? '';
  }

  /** Likes/comments come with instagram_business_basic; views/shares need the
   *  insights permission (instagram_business_manage_insights), so a refused
   *  insights call degrades to the basic counters instead of failing. */
  async fetchMetrics(ctx: MetricsContext): Promise<PostMetrics> {
    const media = await this.graph(`/${ctx.releaseId}`, { fields: 'like_count,comments_count', access_token: ctx.token });
    const metrics: PostMetrics = { likes: num(media.like_count), comments: num(media.comments_count) };
    try {
      const insights = await this.graph<{ data?: Array<{ name: string; values?: Array<{ value: unknown }>; total_value?: { value: unknown } }> }>(
        `/${ctx.releaseId}/insights`,
        { metric: 'views,reach,saved,shares', access_token: ctx.token },
      );
      const rows = insights.data ?? [];
      for (const row of rows) {
        const value = num(row.total_value?.value ?? row.values?.[0]?.value);
        if (row.name === 'views') metrics.views = value;
        if (row.name === 'reach') metrics.reach = value;
        if (row.name === 'saved') metrics.saves = value;
        if (row.name === 'shares') metrics.shares = value;
      }
      metrics.insightsStatus = rows.length ? 'ok' : 'no_data';
    } catch (err) {
      if (err instanceof RefreshTokenError || isTransientError(err)) throw err;
      metrics.insightsStatus = insightsFailureReason(err);
    }
    return metrics;
  }

  classify = (body: string, status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (status === 401) return 'refresh-token';
    try {
      const parsed = JSON.parse(body) as { error?: { code?: number; message?: string }; error_type?: string };
      const code = parsed?.error?.code;
      if (code === 190) return 'refresh-token'; // expired/invalid token
      if (code === 4 || code === 17 || code === 32) return 'retry'; // rate limits
      if (code === 10) return 'reconnect'; // permission revoked by user
      if (parsed?.error_type === 'OAuthException') return 'refresh-token'; // api.instagram.com style
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
      // Always show the account picker so a creator who is logged into the
      // wrong Instagram account can switch instead of silently reconnecting it.
      force_reauth: 'true',
    });
    return `${AUTH}?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    this.configure(cfg);
    if (!this.clientId || !this.clientSecret) throw new BadBodyError('Instagram app is not configured');

    // Instagram appends "#_" to the redirect; browsers drop fragments but a
    // code copied from a URL bar may carry it.
    const cleanCode = code.replace(/#_$/, '');

    // Short-lived user token (~1h) via the code exchange.
    const short = await step('code exchange', providerFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: cleanCode,
      }).toString(),
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>));
    if (!short?.access_token) {
      throw new BadBodyError(short?.error_message || short?.error?.message || 'Instagram did not return an access token');
    }

    // Immediately swap for a long-lived token (~60d).
    const long = await step('long-lived token exchange', this.graph<Record<string, any>>(`/access_token`, {
      grant_type: 'ig_exchange_token',
      client_secret: this.clientSecret,
      access_token: String(short.access_token),
    }, { versioned: false }));
    if (!long?.access_token) throw new BadBodyError(long?.error?.message || 'Instagram long-lived token exchange failed');

    return step('profile lookup', this.withUserInfo(String(long.access_token), Number(long.expires_in) || undefined));
  }

  async refreshToken(_cfg: SocialConfig, userToken: string): Promise<AuthTokenDetails> {
    // Long-lived tokens renew by refreshing themselves (must be ≥24h old and
    // not yet expired). Failure means the user must reconnect — there is no
    // refresh-token rotation on this platform.
    const renewed = await this.graph<Record<string, any>>(`/refresh_access_token`, {
      grant_type: 'ig_refresh_token',
      access_token: userToken,
    }, { versioned: false }).catch((err) => {
      if (err instanceof RefreshTokenError || isTransientError(err)) throw err;
      throw new RefreshTokenError('Instagram token renewal failed — please reconnect this account');
    });

    if (!renewed?.access_token) {
      throw new RefreshTokenError(renewed?.error?.message || 'Instagram token renewal failed — please reconnect this account');
    }
    return this.withUserInfo(String(renewed.access_token), Number(renewed.expires_in) || undefined);
  }

  checkValidity(post: PostDetails): string | true {
    if (!post.media?.length) return 'Instagram posts need at least one photo or video';
    if (post.media.length > 10) return 'Instagram carousels take at most 10 items';
    return this.audioProblem(post) ?? true;
  }

  /** Why settings.audio_configuration cannot be honoured, or undefined. */
  private audioProblem(post: PostDetails): string | undefined {
    const audio = parseAudioConfiguration(post.settings);
    if (!audio.ok) return audio.error;
    if (!audio.value) return undefined;
    if (post.media.length !== 1 || post.media[0].type !== 'video') return 'Instagram music (audio_configuration) only applies to a single-video Reel';
    return this.supportsAudio ? undefined : AUDIO_NEEDS_FACEBOOK_LOGIN;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const problem = this.audioProblem(ctx.post);
    if (problem) throw new BadBodyError(problem);
    const parsed = parseAudioConfiguration(ctx.post.settings);
    const audio = parsed.ok ? parsed.value : undefined;
    const igId = ctx.integration.internalId;
    const medias = ctx.post.media.map((m) => ({ ...m, url: assertPublicHttpUrl(m.url, 'media') }));
    const isCarousel = medias.length > 1;
    const containers: Container[] = [];

    for (const media of medias) {
      const params: Record<string, string> = { access_token: ctx.token };
      if (media.url.toLowerCase().includes('.mp4')) {
        params.video_url = media.url;
        params.media_type = isCarousel ? 'VIDEO' : 'REELS';
        if (!isCarousel) {
          // cover_url wins over thumb_offset when both are sent, so only one goes out.
          if (media.thumbnail) params.cover_url = assertPublicHttpUrl(media.thumbnail, 'cover image');
          else params.thumb_offset = String(thumbOffsetMs(ctx.post.settings));
          if (audio) params.audio_configuration = JSON.stringify(audio);
        }
      } else {
        params.image_url = media.url;
        if (isCarousel) params.media_type = 'IMAGE';
      }
      if (isCarousel) {
        params.is_carousel_item = 'true';
      } else {
        // Caption rides on the single container — Meta rejects captions on
        // carousel children (the caption goes on the CAROUSEL container).
        params.caption = ctx.post.message;
      }

      const created = await this.graph<{ id?: string }>(`/${igId}/media`, params, { method: 'POST' });
      if (!created.id) throw new BadBodyError('Instagram did not create the media container');
      containers.push({ creationId: String(created.id), kind: isCarousel ? 'carousel-child' : 'single', published: false });
    }

    if (isCarousel) {
      const created = await this.graph<{ id?: string }>(`/${igId}/media`, {
        access_token: ctx.token,
        media_type: 'CAROUSEL',
        children: containers.map((c) => c.creationId).join(','),
        caption: ctx.post.message,
      }, { method: 'POST' });
      if (!created.id) throw new BadBodyError('Instagram did not create the carousel container');
      containers.push({ creationId: String(created.id), kind: 'carousel', published: false });
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
      }, { method: 'POST' });
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

    const profile = ctx.integration.profile || '';
    const permalink = await this.graph<{ permalink?: string }>(`/${publishedIds[0]}`, {
      access_token: ctx.token,
      fields: 'permalink',
    })
      .then((r) => String(r.permalink ?? ''))
      .catch(() => '');

    return {
      status: 'completed',
      postId: publishedIds[publishedIds.length - 1],
      releaseUrl: permalink || (profile ? `https://www.instagram.com/${profile}/` : 'https://www.instagram.com/'),
    };
  }

  /** Resolve the professional account behind the token. `user_id` is the
   *  Instagram professional account id that /media and /media_publish take;
   *  `id` is the app-scoped user id (fallback only). */
  private async withUserInfo(accessToken: string, expiresIn?: number): Promise<AuthTokenDetails> {
    const me = await this.graph<Record<string, any>>(`/me`, {
      access_token: accessToken,
      fields: 'user_id,username,name,profile_picture_url,account_type',
    });
    const internalId = String(me?.user_id ?? me?.id ?? '');
    if (!internalId) throw new BadBodyError('No Instagram professional account found — switch the account to Business or Creator first');
    return {
      accessToken,
      refreshToken: accessToken, // the renewable long-lived token
      expiresIn: expiresIn ?? 60 * 24 * 3600,
      internalId,
      name: me.name ?? me.username ?? 'Instagram account',
      profile: String(me.username ?? internalId).replace(/^@/, ''),
      picture: me.profile_picture_url,
    };
  }

  protected async graph<T = Record<string, any>>(
    path: string,
    params: Record<string, string>,
    opts: { versioned?: boolean; method?: 'GET' | 'POST' } = {},
  ): Promise<T> {
    const base = opts.versioned === false ? this.host : `${this.host}/${this.graphVersion}`;
    const query = new URLSearchParams(params).toString();
    const response = opts.method === 'POST'
      ? await providerFetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: query,
          classify: this.classify,
        })
      : await providerFetch(`${base}${path}?${query}`, { classify: this.classify });
    return (await response.json()) as T;
  }
}
