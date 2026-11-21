import { afterEach, describe, expect, test } from 'bun:test';
import {
  blobClosed, extractInstagramShortcode, fetchCreatorReels, isInstagramUrl, normalizeReel,
  parseInstagramUsername, parseReelPage, parseReelsTab, postedAtFromPk, reelDurationSec, reelVideoUrls,
  type InstagramHttp,
} from './instagram-web.js';
import { proxyAdapter, runInstagramProxyScrape } from './proxy-adapter.js';
import { selectDownloadAdapter } from './index.js';
import { platformForVideoUrl } from '../media.js';
import { createSourceForWorkspace } from '../sources-service.js';

// Shapes copied from live @glowupmenclub pages (2026-11-21), trimmed to the
// fields the parser reads. Real pks, so postedAtFromPk is checked against
// the real taken_at.
const PK_PINNED = '3867142656099113403'; // taken_at 1775219465 (2026-04-03)
const PK_NEW = '3897000000000000000';
const PK_OLD = '3700000000000000000';

function sjs(body: unknown): string {
  return `<script type="application/json" nonce="n"  data-content-len="1" data-sjs>${JSON.stringify(body)}</script>`;
}

function relay(data: unknown): unknown {
  return { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_x', { __bbox: { complete: true, result: { data } } }]]] } }]]] };
}

function tabNode(code: string, pk: string, extra: Record<string, unknown> = {}) {
  return {
    node: {
      __typename: 'XIGPolarisVideoMedia', id: `POLARIS_${pk}`, pk, code, product_type: 'clips',
      play_count: 1000, like_count: 50, comment_count: 7, like_and_view_counts_disabled: false,
      clips_tab_pinned_user_ids: [], display_uri: `https://scontent.cdninstagram.com/${code}.jpg`,
      user: { pk: '58282347170', id: '58282347170' },
      ...extra,
    },
  };
}

function tabHtml(edges: unknown[], opts: { profileBlob?: boolean; hasNext?: boolean } = {}): string {
  const profile = opts.profileBlob === false ? '' : sjs(relay({
    user: { username: 'glowupmenclub', pk: '58282347170', follower_count: 138873, is_private: false },
  }));
  return '<!DOCTYPE html><html><head>'
    + '<meta property="og:description" content="139K Followers, 24 Following, 263 Posts - See Instagram photos" />'
    + '</head><body>'
    + sjs({ require: [['Unrelated', 'x', null, []]] })
    + profile
    + sjs(relay({
      xig_user_by_username: {
        pk: '58282347170',
        polaris_clips_connection: { edges, page_info: { end_cursor: 'AQH', has_next_page: opts.hasNext ?? true } },
      },
    }))
    + '</body></html>';
}

function reelHtml(code: string, media: Record<string, unknown>): string {
  return '<html><body>'
    + sjs(relay({ xig_polaris_media: { if_not_gated_logged_out: { code, ...media } } }))
    + '</body></html>';
}

const efg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const MEDIA = {
  pk: PK_PINNED,
  media_type: 2,
  product_type: 'clips',
  taken_at: 1775219465,
  like_count: 3,
  like_and_view_counts_disabled: true,
  comment_count: 8511,
  caption: { text: 'Your hair is damaged. Two tests prove it.' },
  user: { username: 'glowupmenclub' },
  image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/cover.jpg' }] },
  video_versions: [
    { type: 101, url: `https://scontent.cdninstagram.com/a.mp4?efg=${efg({ duration_s: 31 })}` },
    { type: 102, url: `https://scontent.cdninstagram.com/a.mp4?efg=${efg({ duration_s: 31 })}` },
  ],
  video_dash_manifest: '<MPD mediaPresentationDuration="PT31.486258S"></MPD>',
  clips_metadata: {
    music_info: null,
    original_sound_info: { audio_asset_id: '25424623180548032', original_audio_title: 'Original audio', ig_artist: { username: 'glowupmenclub' } },
  },
  ai_label_info: { attribution_label_text: 'AI content' },
};

function fakeHttp(pages: Record<string, Array<{ status: number; text: string }>>): InstagramHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getText(url) {
      calls.push(url);
      const queue = pages[url];
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      const r = next ?? { status: 404, text: '' };
      return { status: r.status, ok: r.status === 200, text: r.text, bytes: r.text.length };
    },
    async getBuffer() {
      throw new Error('not used');
    },
  };
}

describe('instagram identity helpers', () => {
  test('usernames from handles and URLs; reserved paths rejected', () => {
    expect(parseInstagramUsername('@GlowUpMenClub')).toBe('glowupmenclub');
    expect(parseInstagramUsername('https://www.instagram.com/forma.hairstyles/reels/')).toBe('forma.hairstyles');
    expect(parseInstagramUsername('https://www.instagram.com/popular/glowupmenclub/')).toBe('glowupmenclub');
    expect(parseInstagramUsername('https://www.instagram.com/reel/DWq2cG4jFm7/')).toBeNull();
    expect(parseInstagramUsername('not a handle!')).toBeNull();
  });

  test('shortcodes and URL routing', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/reel/DWq2cG4jFm7/')).toBe('DWq2cG4jFm7');
    expect(extractInstagramShortcode('https://www.instagram.com/glowupmenclub/reel/DfP1v_FvrYl/?igsh=x')).toBe('DfP1v_FvrYl');
    expect(extractInstagramShortcode('https://www.instagram.com/p/DV3X-zNiVo6/')).toBe('DV3X-zNiVo6');
    expect(isInstagramUrl('https://www.instagram.com/reel/DWq2cG4jFm7/')).toBe(true);
    expect(isInstagramUrl('https://www.tiktok.com/@a/video/1')).toBe(false);
    expect(platformForVideoUrl('https://www.instagram.com/reel/DWq2cG4jFm7/')).toBe('reels');
    expect(platformForVideoUrl('https://www.tiktok.com/@a/video/123456789')).toBe('tiktok');
  });

  test('media pk encodes the post time to within minutes', () => {
    const at = postedAtFromPk(PK_PINNED)!;
    expect(Math.abs(at.getTime() / 1000 - 1775219465)).toBeLessThan(15 * 60);
    expect(postedAtFromPk('3867142656099113403_58282347170')?.getTime()).toBe(at.getTime());
    expect(postedAtFromPk(null)).toBeNull();
    expect(postedAtFromPk('abc')).toBeNull();
  });

  test('blobClosed waits for the script holding the marker to end', () => {
    expect(blobClosed('<script>{"polaris_clips_connection":{', 'polaris_clips_connection')).toBe(false);
    expect(blobClosed('<script>{"polaris_clips_connection":{}}</script>', 'polaris_clips_connection')).toBe(true);
    expect(blobClosed('</script><script>{}', 'polaris_clips_connection')).toBe(false);
  });
});

describe('parseReelsTab', () => {
  test('reads Reels, pins, hidden like counts and the profile', () => {
    const page = parseReelsTab(tabHtml([
      tabNode('DWq2cG4jFm7', PK_PINNED, { play_count: 1673017, like_count: 3, like_and_view_counts_disabled: true, clips_tab_pinned_user_ids: ['58282347170'], comment_count: 8510 }),
      tabNode('DfMb_pYP_PK', PK_NEW, { play_count: 43928, like_count: 985 }),
      tabNode('DfMb_pYP_PK', PK_NEW),
    ]), 'glowupmenclub');
    expect(page.reels.map(r => r.code)).toEqual(['DWq2cG4jFm7', 'DfMb_pYP_PK']);
    expect(page.reels[0]).toMatchObject({ plays: 1673017, likes: null, comments: 8510, pinned: true, countsHidden: true });
    expect(page.reels[1]).toMatchObject({ plays: 43928, likes: 985, pinned: false });
    expect(page.profile).toEqual({ username: 'glowupmenclub', pk: '58282347170', followers: 138873, isPrivate: false });
    expect(page.hasNextPage).toBe(true);
  });

  test('falls back to og:description for followers', () => {
    const page = parseReelsTab(tabHtml([tabNode('DfMb_pYP_PK', PK_NEW)], { profileBlob: false }), 'glowupmenclub');
    expect(page.profile?.followers).toBe(139000);
  });
});

describe('parseReelPage + normalizeReel', () => {
  test('caption, exact date, duration, sound; hidden likes stay unknown', () => {
    const media = parseReelPage(reelHtml('DWq2cG4jFm7', MEDIA), 'DWq2cG4jFm7');
    expect(media?.code).toBe('DWq2cG4jFm7');
    expect(reelDurationSec(media)).toBe(31);
    expect(reelVideoUrls(media)).toHaveLength(1);

    const tab = parseReelsTab(tabHtml([
      tabNode('DWq2cG4jFm7', PK_PINNED, { play_count: 1673017, like_and_view_counts_disabled: true, comment_count: 8510 }),
    ]), 'glowupmenclub');
    const v = normalizeReel(tab.reels[0]!, media, tab.profile, 'glowupmenclub');
    expect(v).toMatchObject({
      platform: 'reels',
      externalId: 'DWq2cG4jFm7',
      url: 'https://www.instagram.com/reel/DWq2cG4jFm7/',
      thumbnailUrl: 'https://scontent.cdninstagram.com/cover.jpg',
      creatorHandle: 'glowupmenclub',
      creatorFollowers: 138873,
      caption: 'Your hair is damaged. Two tests prove it.',
      postedAt: new Date(1775219465 * 1000).toISOString(),
      views: 1673017,
      likes: 0,
      comments: 8511,
      durationSec: 31,
      sound: { id: '25424623180548032', title: 'Original audio', author: 'glowupmenclub' },
    });
    expect(v.raw).toMatchObject({ source: 'instagram-web', pinned: false, likesHidden: true, hydrated: true, aiLabel: 'AI content' });
    expect(JSON.stringify(v.raw).length).toBeLessThan(400);
  });

  test('duration from the efg tag when there is no manifest', () => {
    expect(reelDurationSec({ video_versions: MEDIA.video_versions })).toBe(31);
    expect(reelDurationSec(null)).toBeNull();
  });

  test('licensed track wins over original audio', () => {
    const tab = parseReelsTab(tabHtml([tabNode('DfMb_pYP_PK', PK_NEW)]), 'glowupmenclub');
    const v = normalizeReel(tab.reels[0]!, {
      clips_metadata: { music_info: { music_asset_info: { audio_asset_id: '9', title: 'Song', display_artist: 'Artist' } } },
    }, tab.profile, 'glowupmenclub');
    expect(v.sound).toEqual({ id: '9', title: 'Song', author: 'Artist' });
  });
});

describe('fetchCreatorReels', () => {
  const TAB = 'https://www.instagram.com/glowupmenclub/reels/';
  const reel = (c: string) => `https://www.instagram.com/reel/${c}/`;

  test('recency is applied before any Reel page is fetched', async () => {
    const http = fakeHttp({
      [TAB]: [{ status: 200, text: tabHtml([tabNode('NEWREEL01', PK_NEW), tabNode('OLDREEL01', PK_OLD)]) }],
      [reel('NEWREEL01')]: [{ status: 200, text: reelHtml('NEWREEL01', { ...MEDIA, pk: PK_NEW, taken_at: 1793500000 }) }],
    });
    const cutoff = postedAtFromPk(PK_NEW)!.getTime() - 86_400_000;
    const r = await fetchCreatorReels('@glowupmenclub', { limit: 12, postedAfter: new Date(cutoff) }, http);
    expect(r.items.map(i => i.externalId)).toEqual(['NEWREEL01']);
    expect(http.calls).toEqual([TAB, reel('NEWREEL01')]);
    expect(r.notices).toEqual([]);
  });

  test('login wall retried; hydrate cap leaves the rest tab-only', async () => {
    const http = fakeHttp({
      [TAB]: [
        { status: 200, text: '<html>login</html>' },
        { status: 200, text: tabHtml([tabNode('NEWREEL01', PK_NEW), tabNode('OLDREEL01', PK_OLD)]) },
      ],
      [reel('NEWREEL01')]: [{ status: 200, text: reelHtml('NEWREEL01', { ...MEDIA, pk: PK_NEW }) }],
    });
    const r = await fetchCreatorReels('glowupmenclub', { limit: 12, hydrate: 1 }, http);
    expect(http.calls).toEqual([TAB, TAB, reel('NEWREEL01')]);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.caption).toBe('Your hair is damaged. Two tests prove it.');
    expect(r.items[1]).toMatchObject({ externalId: 'OLDREEL01', caption: '', durationSec: null });
    expect(r.items[1]!.raw.hydrated).toBe(false);
    expect(r.notices.some(n => n.includes('latest 12 Reels'))).toBe(true);
  });

  test('unreachable tab and bad handles return notices, not throws', async () => {
    const walled = await fetchCreatorReels('glowupmenclub', { limit: 5 }, fakeHttp({}));
    expect(walled.items).toEqual([]);
    expect(walled.notices[0]).toContain('did not serve');

    const bad = await fetchCreatorReels('#hashtag', { limit: 5 }, fakeHttp({}));
    expect(bad.notices[0]).toContain('not an Instagram username');
  });
});

describe('proxy adapter wiring', () => {
  const saved = process.env.SCRAPER_PROXY_URL;
  afterEach(() => {
    if (saved == null) delete process.env.SCRAPER_PROXY_URL; else process.env.SCRAPER_PROXY_URL = saved;
  });

  test('proxy serves reels for scrape and download', () => {
    expect(proxyAdapter.supports('reels')).toBe(true);
    expect(proxyAdapter.supports('shorts')).toBe(false);
    process.env.SCRAPER_PROXY_URL = 'user:pass@gateway.example.com:8080';
    expect(selectDownloadAdapter('reels').name).toBe('proxy');
  });

  test('non-creator Reels sources answer with a notice and no traffic', async () => {
    const http = fakeHttp({});
    const r = await runInstagramProxyScrape(
      { workspaceId: 'w', sourceType: 'hashtag', query: '#glowup', limit: 5, platform: 'reels' },
      http,
    );
    expect(r.items).toEqual([]);
    expect(r.notices[0]).toContain('cannot be scraped without login');
    expect(http.calls).toEqual([]);
  });
});

describe('create_source for reels', () => {
  const ws = { id: 'ws-1' } as never;
  const base = { language: 'en', videoLimit: 12, refreshSchedule: 'manual' as const };

  test('hashtag and keyword are refused before any row is written', async () => {
    const r = await createSourceForWorkspace(ws, { ...base, platform: 'reels', sourceType: 'hashtag', query: '#glowup' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('Instagram hashtag sources cannot be scraped');
  });

  test('a creator query that is not a username is refused', async () => {
    const r = await createSourceForWorkspace(ws, { ...base, platform: 'reels', sourceType: 'creator', query: 'glow up men club' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('not an Instagram username');
  });

  test('shorts is still refused', async () => {
    const r = await createSourceForWorkspace(ws, { ...base, platform: 'shorts', sourceType: 'creator', query: '@x' });
    expect(r.ok).toBe(false);
  });
});
