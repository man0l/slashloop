import { describe, expect, test } from 'bun:test';
import { digestSubject, renderDigestText, renderDigestHtml, videoLink, type DigestPayload, type DigestSection } from './digest.js';

const payload: DigestPayload = {
  generatedAt: '2026-08-24T09:00:00.000Z',
  since: '2026-08-17T09:00:00.000Z',
  totalVideos: 246,
  newOutliersCount: 3,
  actualNewCount: 2,
  topOutliers: [
    {
      videoId: 'v1', creator: 'app_dev_anna', platform: 'tiktok', source: '#buildinpublic',
      url: 'https://tiktok.com/@app_dev_anna/video/1', views: 482_000,
      outlierScore: 686, scoreType: 'actual', hasAnalysis: false, postedAt: '2026-08-19T10:00:00.000Z',
      thumbUrl: 'https://cdn.example.com/thumb/v1.jpg',
    },
    {
      videoId: 'v2', creator: '<script>alert("xss")</script>', platform: 'tiktok', source: 'sauna',
      url: 'https://tiktok.com/@x/video/2', views: 12_000,
      outlierScore: 27, scoreType: 'estimated', hasAnalysis: true, postedAt: '2026-08-20T10:00:00.000Z',
      thumbUrl: null,
    },
  ],
  ideas: { overdue: 1, dueThisWeek: 2, unscheduled: 4 },
  creditsRemaining: 187,
};

const quiet: DigestPayload = { ...payload, newOutliersCount: 0, actualNewCount: 0 };
const one: DigestSection[] = [{ name: 'Default', payload }];
const two: DigestSection[] = [{ name: 'Default', payload }, { name: 'Mewing niche', payload: quiet }];

describe('videoLink', () => {
  test('deep-links into the app gallery, never TikTok', () => {
    expect(videoLink('v1')).toMatch(/\/gallery\?video=v1$/);
    expect(videoLink('v1')).not.toContain('tiktok.com');
  });
});

describe('digestSubject', () => {
  test('aggregates counts across workspaces', () => {
    expect(digestSubject(one)).toBe('Slashloop weekly — 3 taking off');
    const doubled: DigestSection[] = [one[0], { name: 'W2', payload }];
    expect(digestSubject(doubled)).toBe('Slashloop weekly — 6 taking off');
  });

  test('quiet-week variant', () => {
    expect(digestSubject([{ name: 'X', payload: quiet }]))
      .toBe('Slashloop weekly — nothing new this week');
    expect(digestSubject([])).toBe('Slashloop weekly — nothing new this week');
  });
});

describe('renderDigestText', () => {
  const text = renderDigestText(one);

  test('bare numbers only — no explanatory phrases', () => {
    expect(text).toContain('@app_dev_anna — 686× · 482K views');
    expect(text).not.toContain('usual');
    expect(text).not.toContain('analyzed');
    expect(text).not.toContain('baseline');
    expect(text).not.toContain('breakdown');
  });

  test('links into the app per video, never to tiktok', () => {
    expect(text).toContain('/gallery?video=v1');
    expect(text).not.toContain('tiktok.com');
  });

  test('settings link is present', () => {
    expect(text).toContain('/settings/email');
  });

  test('multi-workspace digests get headers and skip quiet sections', () => {
    const combined = renderDigestText(two);
    expect(combined).toContain('== Default ==');
    expect(combined).not.toContain('== Mewing niche ==');
  });
});

describe('renderDigestHtml', () => {
  const html = renderDigestHtml(one);

  test('escapes scraped creator handles and thumb urls', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  test('shows the thumbnail when stored, placeholder when not', () => {
    expect(html).toContain('<img src="https://cdn.example.com/thumb/v1.jpg"');
    expect(html).toContain('width="64" height="114"');
  });

  test('every link goes to slashloop, none to tiktok', () => {
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).not.toContain('tiktok.com');
    expect(html).toContain('/gallery?video=v1');
  });

  test('mobile-first: viewport meta, single column, plain settings text link', () => {
    expect(html).toContain('width=device-width');
    expect(html).toContain('@media(max-width:480px)');
    expect(html).toContain('/settings/email');
    // No button chrome on the settings link.
    expect(html).not.toContain('border:1px solid #ddd;border-radius:8px;font-size:14px');
  });

  test('multi-workspace digests show per-workspace headers only for loud ones', () => {
    const combined = renderDigestHtml(two);
    expect(combined).toContain('>Default</h3>');
    expect(combined).not.toContain('Mewing niche');
  });
});
