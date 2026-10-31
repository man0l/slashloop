import { afterEach, describe, expect, test } from 'bun:test';
import { isSiteUrl, setSiteBinding, siteAwareFetch } from './site-fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setSiteBinding(undefined);
});

describe('siteAwareFetch', () => {
  test('slashloop.dev URLs go through the SITE binding, never the global fetch', async () => {
    const via: string[] = [];
    setSiteBinding({ fetch: (async (u: string) => { via.push(`site:${u}`); return new Response('x'); }) as unknown as typeof fetch });
    globalThis.fetch = (async (u: string) => { via.push(`global:${u}`); return new Response('x'); }) as unknown as typeof fetch;
    await siteAwareFetch('https://slashloop.dev/media/a.png');
    await siteAwareFetch('https://cdn.example.com/b.png');
    expect(via).toEqual(['site:https://slashloop.dev/media/a.png', 'global:https://cdn.example.com/b.png']);
  });

  test('falls back to global fetch when no binding is registered', async () => {
    let hit = '';
    globalThis.fetch = (async (u: string) => { hit = u; return new Response('x'); }) as unknown as typeof fetch;
    await siteAwareFetch('https://slashloop.dev/a.png');
    expect(hit).toBe('https://slashloop.dev/a.png');
  });

  test('host match is exact', () => {
    expect(isSiteUrl('https://www.slashloop.dev/x')).toBe(true);
    expect(isSiteUrl('https://evil-slashloop.dev/x')).toBe(false);
    expect(isSiteUrl('https://slashloop.dev.evil.com/x')).toBe(false);
  });
});
