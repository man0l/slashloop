import { afterEach, describe, expect, test } from 'bun:test';
import {
  COVER_URI_TEMPLATE,
  VIDEO_URI_TEMPLATE,
  coverResourceUri,
  resourceDomains,
  videoResourceUri,
} from './gallery.js';
import { renderGallery, type GalleryCard } from '../ui/gallery.js';

// ── env save/restore (media.test.ts pattern) ──────────────────────────────

const ENV_KEYS = [
  'R2_THUMB_PUBLIC_BASE',
  'R2_PUBLIC_BASE',
  'PUBLIC_URL',
  'SUPABASE_URL',
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── resource URIs ──────────────────────────────────────────────────────────

describe('cover/video resource URIs', () => {
  test('templates and concrete URIs agree on scheme + variable', () => {
    expect(COVER_URI_TEMPLATE).toBe('covers://slashloop/{videoId}');
    expect(VIDEO_URI_TEMPLATE).toBe('videos://slashloop/{videoId}');
    expect(coverResourceUri('vid-1')).toBe('covers://slashloop/vid-1');
    expect(videoResourceUri('vid-1')).toBe('videos://slashloop/vid-1');
  });
});

// ── resourceDomains ────────────────────────────────────────────────────────

describe('resourceDomains', () => {
  test('covers the R2 public base and the worker origin, deduped', () => {
    process.env.R2_THUMB_PUBLIC_BASE = 'https://pub-abc.r2.dev/';
    process.env.PUBLIC_URL = 'https://mcp.slashloop.dev';
    delete process.env.R2_PUBLIC_BASE;
    delete process.env.SUPABASE_URL;
    expect(resourceDomains()).toEqual(['https://pub-abc.r2.dev', 'https://mcp.slashloop.dev']);
  });

  test('empty env yields no declared origins (blob reads carry the page)', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(resourceDomains()).toEqual([]);
  });

  test('unparseable values are skipped, not fatal', () => {
    process.env.R2_THUMB_PUBLIC_BASE = 'not a url';
    process.env.PUBLIC_URL = 'https://mcp.slashloop.dev';
    delete process.env.SUPABASE_URL;
    expect(resourceDomains()).toEqual(['https://mcp.slashloop.dev']);
  });

  test('R2_PUBLIC_BASE fallback wins only when the thumb base is unset', () => {
    delete process.env.R2_THUMB_PUBLIC_BASE;
    process.env.R2_PUBLIC_BASE = 'https://fallback.example.com';
    process.env.PUBLIC_URL = 'https://mcp.slashloop.dev';
    expect(resourceDomains()).toEqual(['https://fallback.example.com', 'https://mcp.slashloop.dev']);
  });
});

// ── rendered app markup ────────────────────────────────────────────────────

function fakeCard(overrides: Partial<GalleryCard> = {}): GalleryCard {
  return {
    id: 'vid-1',
    index: 1,
    creatorHandle: 'maker',
    caption: 'hello',
    url: 'https://www.tiktok.com/@maker/video/1',
    thumbUrl: 'https://thumbs.example.com/w/vid-1.jpg',
    views: 1000,
    engagementRate: '5.0%',
    outlierScore: 7.5,
    durationSec: 30,
    postedAt: 1_700_000_000_000,
    analyzedBy: null,
    analyzedAt: null,
    mediaUrl: 'https://mcp.slashloop.dev/media/w/vid-1.mp4?t=tok',
    coverUri: 'covers://slashloop/vid-1',
    videoUri: 'videos://slashloop/vid-1',
    slideshowImages: [],
    recreationImages: [],
    isSlideshow: false,
    fetchError: null,
    isSelf: false,
    keyMoments: [],
    ...overrides,
  };
}

describe('renderGallery media wiring', () => {
  test('cards carry data-cover-uri and the player carries data-video-uri', () => {
    const html = renderGallery([fakeCard()], undefined, {});
    expect(html).toContain('data-cover-uri="covers://slashloop/vid-1"');
    expect(html).toContain('data-video-uri="videos://slashloop/vid-1"');
    expect(html).toContain('class="player-wrap"');
    expect(html).toContain('poster="https://thumbs.example.com/w/vid-1.jpg"');
  });

  test('cover-less cards expose the placeholder as the blob-read target', () => {
    const html = renderGallery([fakeCard({ thumbUrl: null })], undefined, {});
    expect(html).toContain('<div class="thumb placeholder" data-cover-uri="covers://slashloop/vid-1">');
    expect(html).not.toContain('<img class="thumb"');
  });

  test('cards without stored media declare no resource URIs', () => {
    const html = renderGallery(
      [fakeCard({ mediaUrl: null, coverUri: null, videoUri: null, thumbUrl: null })],
      undefined,
      {},
    );
    // The page script legitimately mentions the attribute names; the `="`
    // form only appears on real card attributes.
    expect(html).not.toContain('data-cover-uri="');
    expect(html).not.toContain('data-video-uri="');
  });
});
