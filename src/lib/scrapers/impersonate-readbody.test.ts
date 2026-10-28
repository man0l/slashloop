import { describe, expect, test } from 'bun:test';
import { readBody } from './impersonate-http.js';
import { extractRehydrationJson, pageBlobComplete } from './tiktok-web.js';

function streamed(parts: string[]): { res: Response; pulled: () => number; cancelled: () => boolean } {
  const enc = new TextEncoder();
  let i = 0;
  let pulledBytes = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i >= parts.length) { ctl.close(); return; }
      const chunk = enc.encode(parts[i++]!);
      pulledBytes += chunk.byteLength;
      ctl.enqueue(chunk);
    },
    cancel() { wasCancelled = true; },
  }, { highWaterMark: 0 });
  return { res: new Response(body), pulled: () => pulledBytes, cancelled: () => wasCancelled };
}

function videoPage(tailChunks: number): string[] {
  const blob = JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id: '1', stats: { diggCount: 7 } } } } } });
  const head = `<html><head></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${blob}</script>`;
  return [head.slice(0, 40), head.slice(40), ...Array.from({ length: tailChunks }, () => 'x'.repeat(32 * 1024))];
}

describe('impit readBody', () => {
  test('stops reading once the rehydration blob is complete', async () => {
    const full = videoPage(8);
    const fullBytes = full.reduce((n, p) => n + p.length, 0);
    const { res, pulled, cancelled } = streamed(full);
    const out = await readBody(res, pageBlobComplete);
    expect(out.stopped).toBe(true);
    expect(cancelled()).toBe(true);
    expect(extractRehydrationJson(out.raw)).not.toBeNull();
    expect(out.bytes).toBe(pulled());
    expect(out.bytes).toBeLessThan(fullBytes / 20);
  });

  test('reads the whole body when the blob never completes', async () => {
    const parts = ['<html>', 'x'.repeat(50_000), '</html>'];
    const { res } = streamed(parts);
    const out = await readBody(res, pageBlobComplete);
    expect(out.stopped).toBe(false);
    expect(out.bytes).toBe(parts.reduce((n, p) => n + p.length, 0));
  });

  test('without stopWhen it behaves like res.text()', async () => {
    const out = await readBody(new Response('hello'));
    expect(out).toEqual({ raw: 'hello', bytes: 5, stopped: false });
  });
});
