import { describe, expect, test } from 'bun:test';
import { digestSubject, renderDigestText, renderDigestHtml, type DigestPayload, type DigestSection } from './digest.js';

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
    },
    {
      videoId: 'v2', creator: '<script>alert("xss")</script>', platform: 'tiktok', source: 'sauna',
      url: 'https://tiktok.com/@x/video/2', views: 12_000,
      outlierScore: 27, scoreType: 'estimated', hasAnalysis: true, postedAt: '2026-08-20T10:00:00.000Z',
    },
  ],
  ideas: { overdue: 1, dueThisWeek: 2, unscheduled: 4 },
  creditsRemaining: 187,
};

const quiet: DigestPayload = { ...payload, newOutliersCount: 0, actualNewCount: 0 };
const one: DigestSection[] = [{ name: 'Default', payload }];
const two: DigestSection[] = [{ name: 'Default', payload }, { name: 'Mewing niche', payload: quiet }];

describe('digestSubject', () => {
  test('aggregates counts across workspaces', () => {
    expect(digestSubject(one)).toBe('Slashloop weekly — 3 breakout videos');
    const doubled: DigestSection[] = [one[0], { name: 'W2', payload }];
    expect(digestSubject(doubled)).toBe('Slashloop weekly — 6 breakout videos');
    expect(digestSubject(doubled)).toContain('breakout video');
  });

  test('quiet-week variant', () => {
    expect(digestSubject([{ name: 'X', payload: quiet }]))
      .toBe('Slashloop weekly — nothing new this week');
    expect(digestSubject([])).toBe('Slashloop weekly — nothing new this week');
  });
});

describe('renderDigestText', () => {
  const text = renderDigestText(one);

  test('speaks plainly about the multiplier', () => {
    expect(text).toContain('@app_dev_anna — 686× their usual views');
    expect(text).not.toContain('outlier(s)');
    expect(text).not.toContain('baseline');
  });

  test('lists urls and nudges analysis for unanalyzed entries', () => {
    expect(text).toContain('https://tiktok.com/@app_dev_anna/video/1');
    expect(text).toContain('1 not broken down yet');
  });

  test('links the email settings page', () => {
    expect(text).toContain('/settings/email');
  });

  test('multi-workspace digests get headers and skip quiet sections', () => {
    const combined = renderDigestText(two);
    expect(combined).toContain('== Default ==');
    // "Mewing niche" is quiet (0 new) — header must not appear.
    expect(combined).not.toContain('== Mewing niche ==');
  });
});

describe('renderDigestHtml', () => {
  const html = renderDigestHtml(one);

  test('escapes scraped creator handles', () => {
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  test('mobile-first: viewport meta, single column, tap-sized settings link', () => {
    expect(html).toContain('width=device-width');
    expect(html).toContain('@media(max-width:480px)');
    expect(html).toContain('/settings/email');
    expect(html).not.toContain('<table');
  });

  test('multi-workspace digests show per-workspace headers only for loud ones', () => {
    const combined = renderDigestHtml(two);
    expect(combined).toContain('>Default</h3>');
    expect(combined).not.toContain('Mewing niche');
  });
});
