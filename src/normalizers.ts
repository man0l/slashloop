// ---------------------------------------------------------------------------
// Video Normalization Layer
// Maps raw scraper outputs from TikTok, Instagram Reels, and YouTube Shorts
// into a shared NormalizedVideo interface.
// ---------------------------------------------------------------------------

export interface NormalizedVideo {
  platform: 'tiktok' | 'reels' | 'shorts';
  externalId: string;
  url: string;
  /** Source-CDN cover URL. Signed and short-lived on TikTok/IG; stable on YouTube. */
  thumbnailUrl: string;
  /**
   * Apify key-value-store URL for the cover image, when the actor was asked to
   * download it (`shouldDownloadCovers`). Public, unsigned, and not
   * referer-gated — always prefer this over `thumbnailUrl` for ingest.
   * Null when the actor didn't return one (the field is documented as
   * sometimes empty), in which case the source CDN is the only option.
   */
  coverDownloadUrl: string | null;
  creatorHandle: string;
  creatorFollowers: number | null;
  caption: string;
  postedAt: string; // ISO
  views: number;
  likes: number;
  comments: number;
  shares: number | null;
  saves: number | null;
  durationSec: number | null;
  transcript: string | null;
  transcriptSource: 'captions' | 'asr' | 'none';
  raw: any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInt(val: any): number {
  if (val == null) return 0;
  const n = typeof val === 'string' ? parseInt(val.replace(/,/g, ''), 10) : Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * Pick the Apify-hosted cover image out of an actor's `mediaUrls`.
 *
 * With `shouldDownloadCovers` the actor copies the cover into its key-value
 * store and lists the KV URL here. `mediaUrls` can hold BOTH the cover and the
 * MP4 when video download is also on, and the order isn't guaranteed — so
 * discriminate on the file extension rather than taking [0]. Anything not on
 * an Apify host is ignored: a TikTok CDN URL leaking in here would defeat the
 * point of asking Apify to download it.
 */
function pickApifyCoverUrl(raw: any): string | null {
  const urls: unknown[] = Array.isArray(raw?.mediaUrls) ? raw.mediaUrls : [];
  for (const u of urls) {
    if (typeof u !== 'string') continue;
    if (!/^https?:\/\/[^/]*\bapify\.com\//i.test(u)) continue;
    if (/\.(jpe?g|png|webp|heic)(\?|$)/i.test(u)) return u;
  }
  return null;
}

function toFloat(val: any): number {
  if (val == null) return 0;
  const n = typeof val === 'string' ? parseFloat(val.replace(/,/g, '')) : Number(val);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function unixToISO(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function parseDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  // Handle ISO 8601 duration like "PT30S", "PT1M15S", "PT0H1M30S"
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = toInt(match[1]);
  const m = toInt(match[2]);
  const s = toInt(match[3]);
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// TikTok Normalizer
// ---------------------------------------------------------------------------

export function normalizeTikTok(raw: any): NormalizedVideo {
  // clockworks/tiktok-scraper output shape: id, text, createTimeISO,
  // webVideoUrl, diggCount/playCount/etc. at the top level, plus nested
  // authorMeta and videoMeta objects. Fall back to the older TikAPI-style
  // author/stats/video shape in case of a future actor change.
  const id = raw.id || raw.videoId || raw.item_id || '';
  const author = raw.authorMeta || raw.author || {};
  const stats = raw.stats || {};
  const video = raw.videoMeta || raw.video || {};

  return {
    platform: 'tiktok',
    externalId: String(id),
    url: raw.webVideoUrl || `https://www.tiktok.com/@${author.name || author.uniqueId || author.username || 'unknown'}/video/${id}`,
    thumbnailUrl: video.coverUrl || video.originalCoverUrl || video.cover || video.originCover || raw.thumbnailUrl || '',
    coverDownloadUrl: pickApifyCoverUrl(raw),
    creatorHandle: author.name || author.uniqueId || author.username || author.nickName || author.nickname || 'unknown',
    creatorFollowers: author.fans != null ? toInt(author.fans) : (author.followerCount != null ? toInt(author.followerCount) : null),
    caption: raw.text || raw.desc || raw.title || '',
    postedAt: raw.createTimeISO || (raw.createTime ? unixToISO(raw.createTime) : new Date().toISOString()),
    views: toInt(raw.playCount ?? stats.playCount),
    likes: toInt(raw.diggCount ?? stats.diggCount ?? stats.heartCount),
    comments: toInt(raw.commentCount ?? stats.commentCount),
    shares: toInt(raw.shareCount ?? stats.shareCount) || null,
    saves: toInt(raw.collectCount ?? stats.collectCount) || null,
    durationSec: video.duration ? toInt(video.duration) : null,
    transcript: null,
    transcriptSource: 'none',
    raw,
  };
}

// ---------------------------------------------------------------------------
// Instagram Reels Normalizer
// ---------------------------------------------------------------------------

export function normalizeReels(raw: any): NormalizedVideo {
  const id = raw.id || raw.pk || raw.code || '';
  const user = raw.user || raw.owner || {};

  return {
    platform: 'reels',
    externalId: String(id),
    url: `https://www.instagram.com/reel/${id}/`,
    thumbnailUrl: raw.thumbnailUrl || raw.displayUrl || raw.imageVersions2?.candidates?.[0]?.url || '',
    // No scraper feeds this normalizer yet — see docs/media-storage-plan.md §0.3.
    coverDownloadUrl: pickApifyCoverUrl(raw),
    creatorHandle: raw.username || user.username || 'unknown',
    creatorFollowers: (raw.followerCount ?? user.followerCount ?? user.follower_count) != null
      ? toInt(raw.followerCount ?? user.followerCount ?? user.follower_count)
      : null,
    caption: raw.caption || raw.text || raw.title || (raw.edge_media_to_caption?.edges?.[0]?.node?.text) || '',
    postedAt: raw.timestamp
      ? unixToISO(raw.timestamp)
      : raw.takenAt
        ? unixToISO(raw.takenAt)
        : new Date().toISOString(),
    views: toInt(raw.viewCount || raw.playCount || raw.videoViewCount),
    likes: toInt(raw.likeCount || raw.likes),
    comments: toInt(raw.commentCount || raw.comments),
    shares: toInt(raw.shareCount) || null,
    saves: toInt(raw.saveCount || raw.savedCount) || null,
    durationSec: raw.videoDuration != null ? toFloat(raw.videoDuration) : null,
    transcript: null,
    transcriptSource: 'none',
    raw,
  };
}

// ---------------------------------------------------------------------------
// YouTube Shorts Normalizer
// ---------------------------------------------------------------------------

export function normalizeShorts(raw: any): NormalizedVideo {
  const id = raw.id || raw.videoId || raw.videoId?.videoId || '';
  const snippet = raw.snippet || {};
  const stats = raw.statistics || {};

  return {
    platform: 'shorts',
    externalId: String(id),
    url: `https://www.youtube.com/shorts/${id}`,
    thumbnailUrl: snippet.thumbnails?.maxres?.url
      || snippet.thumbnails?.high?.url
      || snippet.thumbnails?.medium?.url
      || snippet.thumbnails?.default?.url
      || '',
    // YouTube covers come from i.ytimg.com, which is stable and hotlinkable —
    // there is nothing to download into a KV store.
    coverDownloadUrl: null,
    creatorHandle: raw.channelTitle || snippet.channelTitle || raw.channel || 'unknown',
    creatorFollowers: raw.subscriberCount != null ? toInt(raw.subscriberCount) : null,
    caption: [snippet.title, snippet.description].filter(Boolean).join('\n\n'),
    postedAt: snippet.publishedAt || raw.publishedAt || new Date().toISOString(),
    views: toInt(stats.viewCount || raw.viewCount),
    likes: toInt(stats.likeCount || raw.likeCount),
    comments: toInt(stats.commentCount || raw.commentCount),
    shares: null,
    saves: null,
    durationSec: parseDuration(raw.duration || snippet.duration || raw.contentDetails?.duration),
    transcript: null,
    transcriptSource: 'none',
    raw,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function normalizeVideo(platform: string, raw: any): NormalizedVideo {
  switch (platform) {
    case 'tiktok':
      return normalizeTikTok(raw);
    case 'reels':
    case 'instagram':
      return normalizeReels(raw);
    case 'shorts':
    case 'youtube':
      return normalizeShorts(raw);
    default:
      throw new Error(`Unknown platform for normalization: ${platform}`);
  }
}