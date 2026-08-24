import { describe, expect, test } from 'bun:test';
import { digestSubject, renderDigestText, renderDigestHtml, type DigestPayload } from './digest.js';

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

describe('digestSubject', () => {
  test('leads with counts when there are outliers', () => {
    expect(digestSubject(payload)).toBe('Slashloop weekly — 3 new outliers, 2 verified');
  });

  test('quiet-week variant', () => {
    expect(digestSubject({ ...payload, newOutliersCount: 0, actualNewCount: 0 }))
      .toBe('Slashloop weekly — quiet week in your niches');
  });
});

describe('renderDigestText', () => {
  const text = renderDigestText(payload);

  test('lists ranked outliers with scores and urls', () => {
    expect(text).toContain('@app_dev_anna — 686× actual');
    expect(text).toContain('https://tiktok.com/@app_dev_anna/video/1');
  });

  test('nudges analysis for unanalyzed entries', () => {
    expect(text).toContain('1 of these are not analyzed yet');
  });

  test('reports the posting queue', () => {
    expect(text).toContain('1 overdue');
    expect(text).toContain('"what should I post today?"');
  });

  test('escapes scraped creator handles in HTML', () => {
    const html = renderDigestHtml(payload);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});
