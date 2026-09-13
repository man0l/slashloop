// YouTube Data API v3 client — rewritten from the official docs
// (developers.google.com/youtube), Postiz's youtube.provider.ts used as a
// behavioral cross-check only (AGPL — no code copied).
//
// Flow: start a resumable upload session (nothing exists on the channel
// until the last byte) → persist the session URI in pending_data → the
// engine's finalizePost streams the bytes in 5MB chunks (256KB-aligned),
// probing the session first so a retry resumes at the exact offset the
// session reports — a repeated finalize can therefore never duplicate a
// video. Access tokens last ~1h, so the engine refreshes before posting
// when token_expires_at is near.

import { BadBodyError } from '../errors.js';
import { fetchMediaRange, fetchMediaSize, providerFetch } from '../fetch.js';
import type { AuthTokenDetails, PendingCheck, PostDetails, PostResponse, ProviderId, ProviderPostContext, SocialConfig, SocialProvider } from '../types.js';

const OAUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API = 'https://www.googleapis.com/youtube/v3';

export class YouTubeProvider implements SocialProvider {
  identifier: ProviderId = 'youtube';
  name = 'YouTube';
  scopes = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

  /** 5MB = 20 × 256KB — Google requires chunk sizes aligned to 256KB. */
  static readonly CHUNK_SIZE = 5 * 1024 * 1024;
  /** One finalize call uploads at most this long before handing back to the
   *  engine (pendingData.uploadedBytes makes the resume exact). Keeps a big
   *  video from monopolizing the shared cron tick. */
  static readonly UPLOAD_BATCH_MS = 60_000;

  classify = (body: string, status: number): 'refresh-token' | 'reconnect' | 'bad-body' | 'retry' | undefined => {
    if (status === 401 || body.includes('invalid_grant') || body.includes('invalid_credentials')) return 'refresh-token';
    if (body.includes('uploadLimitExceeded')) return 'bad-body';
    if (status === 429 || status >= 500) return 'retry';
    return undefined;
  };

  async generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string> {
    if (!cfg.youtube?.clientId) throw new BadBodyError('YouTube app is not configured');
    const params = new URLSearchParams({
      client_id: cfg.youtube.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `${OAUTH}?${params.toString()}`;
  }

  async authenticate(cfg: SocialConfig, code: string, redirectUri: string): Promise<AuthTokenDetails> {
    const token = await this.tokenRequest(cfg, { code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    return this.withChannelInfo(token);
  }

  async refreshToken(cfg: SocialConfig, refreshToken: string): Promise<AuthTokenDetails> {
    const token = await this.tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return this.withChannelInfo(token, refreshToken);
  }

  private async tokenRequest(cfg: SocialConfig, body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const clientId = cfg.youtube?.clientId;
    const clientSecret = cfg.youtube?.clientSecret;
    if (!clientId || !clientSecret) throw new BadBodyError('YouTube app is not configured');

    const response = await providerFetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }).toString(),
      classify: this.classify,
    });
    const parsed = (await response.json()) as Record<string, any>;
    if (!parsed?.access_token) throw new BadBodyError(parsed?.error_description || parsed?.error || 'Google token exchange failed');
    return parsed as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  private async withChannelInfo(token: { access_token: string; refresh_token?: string; expires_in?: number }, existingRefresh?: string): Promise<AuthTokenDetails> {
    const channel = await providerFetch(`${API}/channels?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      classify: this.classify,
    })
      .then((r) => r.json() as Promise<Record<string, any>>)
      .catch(() => ({} as Record<string, any>));

    const item = channel?.items?.[0];
    const snippet = item?.snippet ?? {};
    const internalId = String(item?.id ?? '');
    if (!internalId) throw new BadBodyError('No YouTube channel found for this Google account');

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? existingRefresh,
      expiresIn: token.expires_in ?? 3600,
      internalId,
      name: snippet.title ?? 'YouTube channel',
      profile: snippet.customUrl ?? internalId,
      picture: snippet.thumbnails?.default?.url,
    };
  }

  checkValidity(post: PostDetails): string | true {
    if (post.media.length !== 1 || !post.media[0].url.toLowerCase().includes('.mp4')) {
      return 'YouTube posts take exactly one video';
    }
    return true;
  }

  async postPending(ctx: ProviderPostContext): Promise<PostResponse> {
    const media = ctx.post.media[0];
    const videoSize = await fetchMediaSize(media.url);

    const title = str(ctx.post.settings.title) || ctx.post.message.slice(0, 100);
    const session = await providerFetch(`${UPLOAD}?uploadType=resumable&part=snippet,status&notifySubscribers=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(videoSize),
      },
      body: JSON.stringify({
        snippet: {
          title,
          description: ctx.post.message.slice(0, 5000),
          ...(Array.isArray(ctx.post.settings.tags) && ctx.post.settings.tags.length ? { tags: (ctx.post.settings.tags as string[]).slice(0, 15) } : {}),
        },
        status: {
          privacyStatus: str(ctx.post.settings.privacy) || 'public',
          selfDeclaredMadeForKids: Boolean(ctx.post.settings.madeForKids),
        },
      }),
      classify: this.classify,
    });

    const uploadUri = session.headers.get('location');
    if (!uploadUri) throw new BadBodyError('Could not start the YouTube upload session');

    return { pendingData: { uploadUri, videoSize, uploadedBytes: 0, thumbnail: media.thumbnail ?? '', videoId: null } };
  }

  async checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck> {
    const uploadUri = str(ctx.pendingData?.uploadUri);
    const videoSize = num(ctx.pendingData?.videoSize);

    // Probe the session: 200 → video exists (upload done), 308 → still
    // missing bytes (Range header says how many landed). A transient probe
    // failure must not fail the post — it may already be complete; keep
    // pending so the engine checks again next tick.
    let probe: { videoId: string } | { uploadedBytes: number };
    try {
      probe = await this.probeSession(ctx.token, uploadUri, videoSize);
    } catch (err) {
      // Only an expired session is a definite failure; every other probe
      // error (5xx, lost contact) is transient — the video may already be
      // complete, so keep pending and let the engine check again next tick.
      if (err instanceof BadBodyError && String(err.message).includes('expired')) throw err;
      if (err instanceof BadBodyError) return { status: 'pending', pendingData: { ...ctx.pendingData } };
      throw err;
    }

    if ('videoId' in probe) {
      if (ctx.pendingData?.thumbnail) {
        return { status: 'ready', pendingData: { ...ctx.pendingData, videoId: probe.videoId } };
      }
      return { status: 'completed', postId: probe.videoId, releaseUrl: `https://www.youtube.com/watch?v=${probe.videoId}` };
    }

    if (probe.uploadedBytes >= videoSize) {
      // All bytes accepted but no video resource yet — treat as still
      // processing; the next probe will return the video.
      return { status: 'pending', pendingData: { ...ctx.pendingData, uploadedBytes: probe.uploadedBytes } };
    }

    return { status: 'ready', pendingData: { ...ctx.pendingData, uploadedBytes: probe.uploadedBytes } };
  }

  async finalizePost(ctx: ProviderPostContext): Promise<PendingCheck> {
    const uploadUri = str(ctx.pendingData?.uploadUri);
    const videoSize = num(ctx.pendingData?.videoSize);
    const media = ctx.post.media[0];

    // Ask the session for the truth before sending anything — a previous run
    // may have died mid-chunk, or completed without reporting.
    const probe = await this.probeSession(ctx.token, uploadUri, videoSize);
    let uploaded = 'videoId' in probe ? videoSize : probe.uploadedBytes;
    const started = Date.now();

    while (uploaded < videoSize) {
      if (Date.now() - started > YouTubeProvider.UPLOAD_BATCH_MS) {
        return { status: 'pending', pendingData: { ...ctx.pendingData, uploadedBytes: uploaded } };
      }

      const end = Math.min(uploaded + YouTubeProvider.CHUNK_SIZE, videoSize) - 1;
      const range = await fetchMediaRange(media.url, uploaded, end);
      const put = await fetch(uploadUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${uploaded}-${end}/${videoSize}`,
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - uploaded + 1),
        },
        body: range.body,
      });
      try {
        await range.body?.cancel();
      } catch {
        /* stream already consumed */
      }

      if (put.status === 200 || put.status === 201) {
        const body = (await put.json().catch(() => ({}))) as Record<string, any>;
        const videoId = String(body?.id ?? '');
        uploaded = videoSize;

        if (ctx.pendingData?.thumbnail) {
          await this.setThumbnail(ctx.token, videoId, String(ctx.pendingData.thumbnail)).catch(() => {
            /* thumbnail is idempotent-best-effort; video is live either way */
          });
        }
        return { status: 'completed', postId: videoId, releaseUrl: `https://www.youtube.com/watch?v=${videoId}` };
      }

      if (put.status === 308) {
        const rangeHeader = put.headers.get('range');
        uploaded = rangeHeader ? Number(rangeHeader.split('-')[1]) + 1 : end + 1;
        continue;
      }

      const text = await put.text().catch(() => '{}');
      if (this.classify(text, put.status) === 'retry') {
        // Session stays resumable — hand back to the engine and resume later.
        return { status: 'pending', pendingData: { ...ctx.pendingData, uploadedBytes: uploaded } };
      }
      throw new BadBodyError(`YouTube upload failed (${put.status})`);
    }

    // Everything already landed on a previous run: probe again for the id.
    const finalProbe = await this.probeSession(ctx.token, uploadUri, videoSize);
    if ('videoId' in finalProbe) {
      return { status: 'completed', postId: finalProbe.videoId, releaseUrl: `https://www.youtube.com/watch?v=${finalProbe.videoId}` };
    }
    return { status: 'pending', pendingData: { ...ctx.pendingData, uploadedBytes: finalProbe.uploadedBytes } };
  }

  // PUT with a `Content-Range: bytes STAR/N` header and no body — the
  // session reports either the finished video (200 + id) or the received
  // byte count (308 + Range). 404/410 = session expired → definite failure,
  // not retryable.
  private async probeSession(token: string, uploadUri: string, videoSize: number): Promise<{ videoId: string } | { uploadedBytes: number }> {
    const probe = await fetch(uploadUri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes */${videoSize}`, 'Content-Length': '0' },
    }).catch(() => {
      throw new BadBodyError('Lost contact with the YouTube upload session');
    });

    if (probe.status === 200 || probe.status === 201) {
      const body = (await probe.json().catch(() => ({}))) as Record<string, any>;
      const videoId = String(body?.id ?? '');
      if (!videoId) throw new BadBodyError('YouTube session completed without a video id');
      return { videoId };
    }

    if (probe.status === 308) {
      const rangeHeader = probe.headers.get('range');
      return { uploadedBytes: rangeHeader ? Number(rangeHeader.split('-')[1]) + 1 : 0 };
    }

    if (probe.status === 404 || probe.status === 410) {
      throw new BadBodyError('The upload session expired before the video was uploaded');
    }

    throw new BadBodyError(`YouTube upload status check failed (${probe.status})`);
  }

  private async setThumbnail(token: string, videoId: string, thumbnailUrl: string): Promise<void> {
    const thumb = await fetch(thumbnailUrl);
    if (!thumb.ok || !thumb.body) return;
    await fetch(`${API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': thumb.headers.get('content-type') ?? 'image/jpeg' },
      body: thumb.body,
    });
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
