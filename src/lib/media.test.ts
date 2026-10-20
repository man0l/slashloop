import { afterEach, describe, expect, test } from 'bun:test';
import { experimentSourceKeys, hasExperimentSlides, mediaDownloadView, resolveRecreationUrls, resolveSlideshowUrls, resolveThumbUrl, slideshowIsHydrated, slideshowTargetFromNormalized } from './media.js';

const TIKTOK_COVER =
  'https://p19-common-sign.tiktokcdn-us.com/tos-useast8-p-0068-tx2/x~tplv-tiktokx-origin.image';

const ENV_KEYS = [
  'R2_THUMB_PUBLIC_BASE',
  'R2_PUBLIC_BASE',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveThumbUrl', () => {
  test('uses R2 public base + thumbKey even without write credentials', () => {
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    process.env.R2_THUMB_PUBLIC_BASE = 'https://pub-thumbs.r2.dev';

    expect(resolveThumbUrl({
      thumbKey: 'ws-1/vid-1.jpg',
      thumbnailUrl: TIKTOK_COVER,
    })).toBe('https://pub-thumbs.r2.dev/ws-1/vid-1.jpg');
  });

  test('never hotlinks a TikTok CDN cover when there is no stored copy', () => {
    delete process.env.R2_THUMB_PUBLIC_BASE;
    delete process.env.R2_PUBLIC_BASE;
    expect(resolveThumbUrl({ thumbKey: null, thumbnailUrl: TIKTOK_COVER })).toBeNull();
  });

  test('still falls back to stable non-TikTok hosts (YouTube)', () => {
    delete process.env.R2_THUMB_PUBLIC_BASE;
    delete process.env.R2_PUBLIC_BASE;
    const yt = 'https://i.ytimg.com/vi/abc/hqdefault.jpg';
    expect(resolveThumbUrl({ thumbKey: null, thumbnailUrl: yt })).toBe(yt);
  });
});

describe('resolveSlideshowUrls', () => {
  test('prefers stored R2 keys over leftover TikTok CDN URLs', () => {
    process.env.R2_THUMB_PUBLIC_BASE = 'https://pub-thumbs.r2.dev';
    const raw = JSON.stringify({
      slideshowKeys: ['ws-1/vid-1/slides/00.jpg', 'ws-1/vid-1/slides/01.jpg'],
      slideshowImages: [TIKTOK_COVER],
    });
    expect(resolveSlideshowUrls(raw)).toEqual([
      'https://pub-thumbs.r2.dev/ws-1/vid-1/slides/00.jpg',
      'https://pub-thumbs.r2.dev/ws-1/vid-1/slides/01.jpg',
    ]);
  });

  test('does not emit scrape-time CDN URLs — gallery only renders stored R2 keys', () => {
    delete process.env.R2_THUMB_PUBLIC_BASE;
    delete process.env.R2_PUBLIC_BASE;
    const raw = JSON.stringify({ slideshowImages: [TIKTOK_COVER, 'https://cdn.example/ok.jpg'] });
    expect(resolveSlideshowUrls(raw)).toEqual([]);
  });
});

describe('slideshowTargetFromNormalized', () => {
  test('picks slide URLs off a scraped photo post for ingest', () => {
    expect(slideshowTargetFromNormalized('vid-1', {
      postKind: 'slideshow',
      slideshowImages: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    })).toEqual({
      videoId: 'vid-1',
      urls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    });
    expect(slideshowTargetFromNormalized('vid-1', { videoMeta: { originalCoverUrl: 'https://cdn.example/c.jpg' } })).toBeNull();
  });

  test('photomode cover alone is not an ingest target — watch page hydrates the carousel', () => {
    const cover = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast2a-i-photomode-euttp/x~tplv-photomode-zoomcover.jpeg';
    expect(slideshowTargetFromNormalized('vid-1', {
      postKind: 'slideshow',
      videoMeta: { originalCoverUrl: cover, duration: 0 },
    })).toBeNull();
  });
});

describe('resolveRecreationUrls', () => {
  test('emits public R2 URLs for stored recreation keys', () => {
    process.env.R2_THUMB_PUBLIC_BASE = 'https://pub-thumbs.r2.dev';
    const raw = JSON.stringify({
      recreationKeys: ['ws-1/vid-1/recreate/00.jpg', 'ws-1/vid-1/recreate/01.jpg'],
    });
    expect(resolveRecreationUrls(raw)).toEqual([
      'https://pub-thumbs.r2.dev/ws-1/vid-1/recreate/00.jpg',
      'https://pub-thumbs.r2.dev/ws-1/vid-1/recreate/01.jpg',
    ]);
  });
});

describe('experimentSourceKeys', () => {
  test('prefers the recreated deck over the original carousel', () => {
    const raw = JSON.stringify({
      slideshowKeys: ['ws/v/slides/00.jpg'],
      recreationKeys: ['ws/v/recreate/00.jpg', 'ws/v/recreate/01.jpg'],
    });
    expect(experimentSourceKeys(raw)).toEqual(['ws/v/recreate/00.jpg', 'ws/v/recreate/01.jpg']);
    expect(hasExperimentSlides(raw)).toBe(true);
  });
  test('falls back to the original carousel and rejects plain videos', () => {
    expect(experimentSourceKeys(JSON.stringify({ slideshowKeys: ['ws/v/slides/00.jpg'] }))).toEqual(['ws/v/slides/00.jpg']);
    expect(hasExperimentSlides(JSON.stringify({ slideshowKeys: ['ws/v/slides/00.jpg'] }))).toBe(true);
    expect(hasExperimentSlides('{}')).toBe(false);
    expect(hasExperimentSlides(null)).toBe(false);
  });
});

describe('slideshowIsHydrated', () => {
  test('2+ stored keys from scrape-time imagePost count as complete', () => {
    expect(slideshowIsHydrated(JSON.stringify({
      slideshowKeys: ['ws/v/slides/00.jpg', 'ws/v/slides/01.jpg'],
    }))).toBe(true);
  });

  test('a single stored key is complete only after the watch-page hydrate stamp', () => {
    expect(slideshowIsHydrated(JSON.stringify({
      slideshowKeys: ['ws/v/slides/00.jpg'],
    }))).toBe(false);
    expect(slideshowIsHydrated(JSON.stringify({
      slideshowKeys: ['ws/v/slides/00.jpg'],
      slideshowHydrated: true,
    }))).toBe(true);
  });
});

describe('mediaDownloadView', () => {
  const plainVideo = { mediaStatus: 'stored', durationSec: 21, rawJson: null, thumbnailUrl: null };

  test('stored video exposes the signed MP4 link with its lifetime', () => {
    const v = mediaDownloadView(plainVideo, { url: 'https://media.example/v.mp4?t=abc' });
    expect(v.status).toBe('stored');
    expect(v.url).toBe('https://media.example/v.mp4?t=abc');
    expect(v.expiresInSec).toBeGreaterThan(0);
    expect(v.reason).toBeNull();
    expect(v.next).toBeNull();
  });

  test('not-yet-stored video points at fetch_videos rather than analysis', () => {
    const v = mediaDownloadView({ ...plainVideo, mediaStatus: 'none' }, { url: null, reason: 'media_not_stored' });
    expect(v).toMatchObject({ status: 'none', url: null, reason: 'media_not_stored' });
    expect(v.next).toContain('fetch_videos');
    expect(v.next).not.toContain('analyze_video');
  });

  test('expired media is recoverable through fetch_videos too', () => {
    const v = mediaDownloadView({ ...plainVideo, mediaStatus: 'expired' }, { url: null, reason: 'media_expired' });
    expect(v.reason).toBe('media_expired');
    expect(v.next).toContain('fetch_videos');
  });

  test('signing failure is reported without a misleading next step', () => {
    const v = mediaDownloadView(plainVideo, { url: null, reason: 'sign_failed' });
    expect(v).toMatchObject({ url: null, reason: 'sign_failed', next: null });
  });

  test('photo posts have no MP4', () => {
    const v = mediaDownloadView({ ...plainVideo, mediaStatus: 'slideshow' }, { url: null });
    expect(v).toMatchObject({ url: null, reason: 'photo_post' });
  });
});
