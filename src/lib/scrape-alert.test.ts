import { describe, expect, test, afterEach } from 'bun:test';
import { isScrapeOutageError, renderScrapeAlert, rearmCooldownSeconds, SCRAPE_ALERT_KINDS } from './scrape-alert.js';

// The Aug-2026 Proxy-Cheap outage, verbatim from the worker logs — the vendor
// kept status ACTIVE while the connect IP/port went null, so every fetch and
// refresh died with this exact text.
const PROXY_OUTAGE = `Failed to connect to the server.
Reason: hyper_util::client::legacy::Error(
    Connect,
    ConnectFailed(
        ConnectError(
            "tcp connect error",
            18.157.115.243:8080,
            Os {
                code: 111,
                kind: ConnectionRefused,
                message: "ConnectionRefused",
            },
        ),
    ),
)`;

describe('SCRAPE_ALERT_KINDS', () => {
  test('covers the kinds that scrape TikTok, not AI or thumb work', () => {
    expect([...SCRAPE_ALERT_KINDS].sort()).toEqual(['fetch', 'refresh']);
  });
});

describe('rearmCooldownSeconds', () => {
  afterEach(() => {
    delete process.env.SCRAPE_ALERT_REARM_COOLDOWN_HOURS;
  });

  test('defaults to 6h', () => {
    delete process.env.SCRAPE_ALERT_REARM_COOLDOWN_HOURS;
    expect(rearmCooldownSeconds()).toBe(6 * 3600);
  });

  test('honours a positive env override', () => {
    process.env.SCRAPE_ALERT_REARM_COOLDOWN_HOURS = '12';
    expect(rearmCooldownSeconds()).toBe(12 * 3600);
  });

  test('falls back to the default on junk or non-positive values', () => {
    for (const junk of ['abc', '0', '-3', 'NaN']) {
      process.env.SCRAPE_ALERT_REARM_COOLDOWN_HOURS = junk;
      expect(rearmCooldownSeconds()).toBe(6 * 3600);
    }
  });
});

describe('isScrapeOutageError', () => {
  test('proxy/network failures alert', () => {
    expect(isScrapeOutageError(PROXY_OUTAGE)).toBe(true);
    expect(isScrapeOutageError('Failed to connect to the server.')).toBe(true);
    expect(isScrapeOutageError('request timed out after 30000ms')).toBe(true);
  });

  test('infrastructure-flavored Apify failures alert', () => {
    expect(isScrapeOutageError('Apify monthly spend cap reached (5000 cents)')).toBe(true);
    expect(isScrapeOutageError('APIFY_API_KEY is not set')).toBe(true);
    expect(isScrapeOutageError('Apify actor run failed: ACTOR.RUN.TIMEOUT')).toBe(true);
    expect(isScrapeOutageError('TikTok CDN download failed after 3 tries')).toBe(true);
  });

  test('per-video content noise stays silent', () => {
    expect(isScrapeOutageError('Apify actor returned no items for the URL')).toBe(false);
    expect(isScrapeOutageError('This TikTok is a photo/slideshow, not a video')).toBe(false);
    expect(isScrapeOutageError('No playable URL on the watch page')).toBe(false);
    expect(isScrapeOutageError('Downloaded file too small (4 KB) to be a video')).toBe(false);
    expect(isScrapeOutageError('$0.00 balance for video — requires at least $1.00')).toBe(false);
  });

  test('unclassifiable messages alert — novel failure modes must surface', () => {
    expect(isScrapeOutageError('something completely novel happened')).toBe(true);
  });

  test('empty messages never alert', () => {
    expect(isScrapeOutageError('')).toBe(false);
    expect(isScrapeOutageError('   ')).toBe(false);
  });
});

describe('renderScrapeAlert', () => {
  test('names the kind and carries the raw error + classifier hint', () => {
    const { subject, text } = renderScrapeAlert('fetch', PROXY_OUTAGE);
    expect(subject).toBe('[slashloop] scraping is failing — fetch jobs');
    expect(text).toContain('fetch jobs');
    expect(text).toContain('tcp connect error');
    expect(text).toContain('re-arm'); // explains the one-email rule
  });

  test('spend-cap failures render the actionable hint', () => {
    const { text } = renderScrapeAlert('refresh', 'Apify monthly spend cap reached (5000 cents)');
    expect(text).toContain('Raise the cap or wait for next month');
  });

  test('html escapes markup in the error so alerts cannot inject', () => {
    const { html } = renderScrapeAlert('fetch', '<script>alert("xss")</script> boom');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('truncates very long errors', () => {
    const { text } = renderScrapeAlert('fetch', 'x'.repeat(5000));
    expect(text.length).toBeLessThan(1000);
  });
});
