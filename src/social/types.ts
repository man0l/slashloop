// Social post scheduler library (src/social/) — public types.
//
// Design reference: Postiz's provider contract (docs/postiz-reuse-research.md
// in slashloop-site), re-implemented from the platforms' official APIs. The
// library boundary: NOTHING here reads process.env or reaches for global
// singletons — every entry point takes its config/bindings as arguments, so
// the module stays liftable into an npm package or its own worker later.
//
// Publishing lifecycle (per provider):
//   postPending()    starts the possibly-irreversible upload, returns
//                    { status:'pending', pendingData } — callers persist
//                    pendingData in social_posts.pending_data.
//   checkPostStatus() asks the platform for the truth (poll while 'pending').
//   finalizePost()    performs the remaining mutations (stream the YouTube
//                    bytes, publish IG containers, set thumbnails) — guarded
//                    so a retry can never duplicate a post.

export type ProviderId = 'tiktok' | 'youtube' | 'instagram';

export interface MediaContent {
  type: 'image' | 'video';
  /** Publicly reachable URL (R2 public route or external). TikTok photos and
   *  every Instagram container are pulled from this URL by the platform. */
  url: string;
  alt?: string;
  thumbnail?: string;
  /** true = pending metadata scrub (re-captured before publishing); the
   *  engine replaces url + clears the flag as it processes each item. */
  scrub?: boolean;
}

export interface PostDetails {
  message: string;
  settings: Record<string, unknown>;
  media: MediaContent[];
}

export type PendingData = Record<string, unknown>;

/** postPending result: always 'pending' — the engine polls from here. */
export interface PostResponse {
  pendingData: PendingData;
}

export type PendingCheck =
  | { status: 'pending'; pendingData: PendingData }
  | { status: 'ready'; pendingData: PendingData }
  | { status: 'completed'; postId: string; releaseUrl: string };

export interface AuthTokenDetails {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until expiry (platform-reported); the store converts to an epoch. */
  expiresIn?: number;
  internalId: string;
  name: string;
  profile: string;
  picture?: string;
}

/** Everything a provider method may need. `post` is the DB row reduced to
 *  what providers touch — no SQL types leak into this module. */
export interface ProviderPostContext {
  token: string;
  post: PostDetails & { id: string };
  integration: { internalId: string; profile: string };
  pendingData?: PendingData;
}

export interface SocialProvider {
  identifier: ProviderId;
  name: string;
  scopes: string[];
  /** Registry calls this once per construction with the full config; providers
   *  needing app credentials at post-time (Instagram's graph version) store
   *  what they need here instead of threading cfg through every method. */
  configure?(cfg: SocialConfig): void;
  generateAuthUrl(cfg: SocialConfig, redirectUri: string, state: string): Promise<string>;
  authenticate(cfg: SocialConfig, code: string, redirectUri: string, verifier?: string): Promise<AuthTokenDetails>;
  refreshToken(cfg: SocialConfig, refreshToken: string): Promise<AuthTokenDetails>;
  /** Returns true or a human-readable reason the post is invalid for this platform. */
  checkValidity(post: PostDetails): string | true;
  postPending(ctx: ProviderPostContext): Promise<PostResponse>;
  checkPostStatus(ctx: ProviderPostContext): Promise<PendingCheck>;
  finalizePost?(ctx: ProviderPostContext): Promise<PendingCheck>;
}

export interface SocialConfig {
  tiktok?: { clientId: string; clientSecret: string };
  youtube?: { clientId: string; clientSecret: string };
  instagram?: { clientId: string; clientSecret: string; graphVersion?: string };
  /** Cloudflare Stream credentials for the metadata scrub (video re-encode).
   *  Absent = video scrubbing fails fast with a setup message. */
  scrub?: { accountId: string; token: string };
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: () => number;
}

export interface SocialIntegrationRow {
  id: string;
  owner_id: string;
  provider: ProviderId;
  internal_id: string;
  profile: string | null;
  name: string | null;
  picture: string | null;
  token: string;
  refresh_token: string | null;
  token_expires_at: number | null;
  refresh_needed: number;
  disabled: number;
  error: string | null;
}

export interface SocialPostRow {
  id: string;
  group_id: string;
  owner_id: string;
  integration_id: string;
  provider: ProviderId;
  state: 'QUEUE' | 'PROCESSING' | 'PUBLISHED' | 'ERROR' | 'DRAFT' | 'SCRUB';
  publish_date: number;
  content: string;
  settings: string | null;
  media: string | null;
  pending_data: string | null;
  release_id: string | null;
  release_url: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}
