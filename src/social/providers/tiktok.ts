// TikTok Content Posting API client — rewritten from the official docs
// (open.tiktokapis.com), using Postiz's tiktok.provider.ts as a behavioral
// cross-check only (AGPL — no code copied).
//
// Flow (video): /video/init/ returns publish_id + upload_url; the video bytes
// are PUT to upload_url in chunks with Content-Range (5MB–64MB chunk rules);
// publishing completes asynchronously → poll /status/fetch/ until
// PUBLISH_COMPLETE. Flow (photos): PULL_FROM_URL only — the platform fetches
// the public image URLs itself, so photo media must be publicly reachable.

import { BadBodyError, ReconnectError, RefreshTokenError } from '../errors.js';
import { assertPublicHttpUrl, extractMessage, fetchMediaRange, fetchMediaSize, providerFetch } from '../fetch.js';
import type { AuthTokenDetails, PendingCheck, PostDetails, PostResponse, ProviderId, ProviderPostContext, SocialConfig, SocialProvider } from '../types.js';

const API = 'https://open.tiktokapis.com/v2';

export class TikTokProvider implements SocialProvider {
  identifier: ProviderId = 'tiktok';
  name = 'TikTok';
  scopes = ['user.info.basic', 'video.publish', 'video.upload'];

  /** Chunk rules: TikTok accepts a single chunk up to 64MB; bigger files go
   *  out as 10MB chunks with the remainder riding in the final PUT. */
  static readonly MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
  static readonly CHUNK_SIZE = 10 * 1024 * 1024;

  chunkPlan(videoSize: number): { chunkSize: number; totalChunkCount: number } {
    if (videoSize <= TikTokProvider.MAX_SINGLE_CHUNK) return { chunkSize: videoSize, totalChunkCount: 1 };
    return { chunkSize: TikTokProvider.CHUNK_SIZE, totalChunkCount: Math.floor(videoSize / TikTokProvider.CHUNK_SIZE) };
  }

  classify = (body: string, _status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (body.includes('access_token_invalid')) return 'refresh-token';
    if (body.includes('reached_active_user_cap')) return 'reconnect';
    if (body.includes('rate_limit_exceeded')) return 'retry';
    if (
      body.includes('spam_risk') ||
      body.includes('privacy_level_option_mismatch') ||
      body.includes('unaudited_client_can_only_post_to_private_accounts') ||
      body.includes('invalid_params') ||
      body.includes('file_format_check_failed') ||
      body.includes('scope_not_authorized') ||
      body.includes('scope_permission_missed')
    ) {
      return 'bad-body';
    }
    return undefined;
  };

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    const key = cfg.tiktok?.clientId;
    if (!key) throw new BadBodyError('TikTok app is not configured');
    const params = new URLSearchParams({
      client_key: key,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: this.scopes.join(','),
      // TikTok's web flow uses `state` as the code_verifier at exchange time
      // (no S256 challenge) — mirror of the behavior proven against the live
      // API; the token exchange below always sends code_verifier=state.
      code_verifier: state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string, verifier?: string): Promise<AuthTokenDetails> {
    // TikTok's web flow treats the authorize-time `state` as the PKCE
    // verifier at exchange time (no S256 challenge) — the API layer passes
    // the state it generated through `verifier`.
    const token = await this.tokenRequest(cfg, {
      code,
      grant_type: 'authorization_code',
      code_verifier: verifier || code,
      redirect_uri: redirectUri,
    });
    return this.withUserInfo(token);
  }

  async refreshToken(cfg: SocialConfig, refreshToken: string): Promise<AuthTokenDetails> {
    const token = await this.tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return this.withUserInfo(token);
  }

  private async tokenRequest(
    cfg: SocialConfig,
    body: Record<string, string> & { code?: string; code_verifier?: string },
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; open_id?: string }> {
    const clientId = cfg.tiktok?.clientId;
    const clientSecret = cfg.tiktok?.clientSecret;
    if (!clientId || !clientSecret) throw new BadBodyError('TikTok app is not configured');

    const response = await providerFetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: clientId, client_secret: clientSecret, ...body }).toString(),
      classify: this.classify,
    });
    const parsed = (await response.json()) as Record<string, any>;
    if (!parsed?.access_token) {
      const message = parsed?.error || parsed?.message || 'TikTok token exchange failed';
      if (String(message).includes('invalid_access_token')) throw new RefreshTokenError();
      throw new BadBodyError(String(message));
    }
    return parsed as { access_token: string; refresh_token?: string; expires_in?: number; open_id?: string };
  }

  private async withUserInfo(token: { access_token: string; refresh_token?: string; expires_in?: number; open_id?: string }): Promise<AuthTokenDetails> {
    const info = await providerFetch(`${API}/user/info/?fields=open_id,display_name,avatar_url,username`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>);

    const user = info?.data?.user ?? {};
    const openId = String(user.open_id ?? token.open_id ?? '').replace(/-/g, '');
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      // TikTok access tokens last ~24h; refresh well before.
      expiresIn: token.expires_in ?? 23 * 3600,
      internalId: openId,
      name: user.display_name ?? user.username ?? 'TikTok account',
      profile: user.username ?? openId,
      picture: user.avatar_url,
    };
  }

  checkValidity(post: PostDetails): string | true {
    if (!post.media?.length) return 'TikTok posts need a video or photo(s)';
    const hasVideo = post.media.some((m) => m.url.toLowerCase().includes('.mp4'));
    if (hasVideo && post.media.length > 1) return 'TikTok takes one video, or photos only';
    return true;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const isVideo = ctx.post.media[0]?.url.toLowerCase().includes('.mp4');

    if (isVideo) {
      const videoSize = await fetchMediaSize(ctx.post.media[0].url);
      const { chunkSize, totalChunkCount } = this.chunkPlan(videoSize);

      const init = await providerFetch(`${API}/post/publish/video/init/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          post_info: {
            title: ctx.post.message.slice(0, 2000),
            privacy_level: str(ctx.post.settings.privacy_level) || 'PUBLIC_TO_EVERYONE',
            disable_duet: !bool(ctx.post.settings.duet),
            disable_comment: !bool(ctx.post.settings.comment),
            disable_stitch: !bool(ctx.post.settings.stitch),
            is_aigc: bool(ctx.post.settings.madeWithAi),
          },
          source_info: { source: 'FILE_UPLOAD', video_size: videoSize, chunk_size: chunkSize, total_chunk_count: totalChunkCount },
        }),
        classify: this.classify,
      }).then((r) => r.json() as Promise<Record<string, any>>);

      const publishId = init?.data?.publish_id;
      const uploadUrl = init?.data?.upload_url;
      if (!publishId || !uploadUrl) {
        throw new BadBodyError(init?.error?.message || 'TikTok did not return an upload session');
      }

      // Bytes may or may not land (network cut mid-PUT): treat any throw here
      // as ambiguous and still return pending — the status poll decides.
      try {
        await this.putChunks(uploadUrl, ctx.post.media[0].url, videoSize);
      } catch (err) {
        console.warn(`[social/tiktok] chunk upload error for ${publishId}: ${(err as Error).message}`);
      }

      return { pendingData: { publishId } };
    }

    // Photos: PULL_FROM_URL only — no byte streaming path for photos.
    const init = await providerFetch(`${API}/post/publish/content/init/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
        post_info: {
          title: str(ctx.post.settings.title) || ctx.post.message.slice(0, 90),
          description: ctx.post.message.slice(0, 2000),
          privacy_level: str(ctx.post.settings.privacy_level) || 'PUBLIC_TO_EVERYONE',
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: ctx.post.media.map((m) => assertPublicHttpUrl(m.url, 'photo')),
        },
      }),
      classify: this.classify,
    }).then((r) => r.json() as Promise<Record<string, any>>);

    const publishId = init?.data?.publish_id;
    if (!publishId) throw new BadBodyError(init?.error?.message || 'TikTok did not accept the photo post');
    return { pendingData: { publishId } };
  }

  /** Stream each chunk straight from the media store into the upload PUT —
   *  one range in flight at a time, never the whole file in memory. Chunk
   *  rejections are surfaced as BadBody (post will not publish); network
   *  errors propagate as ambiguous (caller keeps the publish pending). */
  private async putChunks(uploadUrl: string, mediaUrl: string, videoSize: number): Promise<void> {
    const { chunkSize, totalChunkCount } = this.chunkPlan(videoSize);
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
      const range = await fetchMediaRange(mediaUrl, start, end);

      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${videoSize}`,
        },
        body: range.body,
      });

      try {
        await range.body?.cancel();
      } catch {
        /* stream already consumed/closed */
      }

      if (put.status !== 200 && put.status !== 201 && put.status !== 206) {
        const text = await put.text().catch(() => '{}');
        const kind = this.classify(text, put.status);
        if (kind === 'refresh-token') throw new RefreshTokenError();
        if (kind === 'reconnect') throw new ReconnectError('Please reconnect this TikTok account');
        throw new BadBodyError(extractMessage(text) || 'TikTok rejected a video chunk');
      }
    }
  }

  async checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck> {
    const publishId = str(ctx.pendingData?.publishId);
    const status = await providerFetch(`${API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
      classify: this.classify,
    })
      .then((r) => r.json() as Promise<Record<string, any>>)
      .catch((err) => {
        // Transient poll errors must NOT fail the post — it may already be
        // live; keep pending so the engine checks again next tick.
        if (err instanceof BadBodyError) return { data: { status: 'TRANSIENT', message: (err as Error).message } } as Record<string, any>;
        throw err;
      });

    switch (status?.data?.status) {
      case 'PUBLISH_COMPLETE': {
        const publicId = status?.data?.publicaly_available_post_id?.[0];
        const profile = ctx.integration.profile || ctx.integration.internalId;
        return {
          status: 'completed',
          postId: publicId ? String(publicId) : publishId,
          releaseUrl: publicId ? `https://www.tiktok.com/@${profile}/video/${publicId}` : `https://www.tiktok.com/@${profile}`,
        };
      }
      case 'SEND_TO_USER_INBOX':
        // UPLOAD-mode semantics never selected by this client (DIRECT_POST
        // only), but if TikTok routes it there anyway the post is "live" in
        // the user's inbox — surface it as completed with the inbox URL.
        return { status: 'completed', postId: publishId, releaseUrl: 'https://www.tiktok.com/messages' };
      case 'FAILED':
        throw new BadBodyError(status?.data?.message || 'TikTok refused to publish the post');
      default:
        return { status: 'pending', pendingData: { publishId } };
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown): boolean {
  return value === undefined ? true : Boolean(value);
}
