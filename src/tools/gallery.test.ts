import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  COVER_URI_TEMPLATE,
  VIDEO_URI_TEMPLATE,
  coverResourceUri,
  resourceDomains,
  videoResourceUri,
} from './gallery.js';
import { renderGallery, type GalleryCard } from '../ui/gallery.js';
import { editInstructions } from './experiments.js';
import { Create } from '../experiments/schema.js';

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
    // The file-level save/restore only snapshots env once: when the whole
    // suite runs, an EARLIER test file (loaded before this one) may leave
    // SUPABASE_URL set in this process — pin every input like the test above.
    delete process.env.SUPABASE_URL;
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
    experimentEligible: false,
    fetchError: null,
    isSelf: false,
    keyMoments: [],
    ...overrides,
  };
}

describe('experiment selection', () => {
  test('a video with a finished Recreate deck is selectable for experiments', () => {
    const html = renderGallery(
      [fakeCard({
        isSlideshow: false,
        experimentEligible: true,
        recreationImages: ['https://thumbs.example.com/w/vid-1/recreate/00.jpg', 'https://thumbs.example.com/w/vid-1/recreate/01.jpg'],
      })],
      undefined,
      {},
    );
    expect(html).toContain('data-is-slideshow="1"');
    expect(html).toContain('data-slide-count="2"');
    expect(html).toContain('data-select-video="vid-1"');
  });

  test('plain videos stay unselectable for experiments', () => {
    const html = renderGallery([fakeCard()], undefined, {});
    expect(html).toContain('data-is-slideshow="0"');
    expect(html).toContain('data-slide-count="0"');
    expect(html).not.toContain('data-select-video="vid-1"');
  });
});

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

// ── SLA-431: the edit wizard must emit the exact copy structurally ──────────
//
// The wizard's inline script runs in a sandboxed iframe and cannot call a module
// helper, so buildPayload() cannot be invoked from a unit test. These are
// source-level guards, the same shape as the data-slide-count guard above: they
// fail if the emission sites are deleted or renamed. Without them the F1 defect
// (prose-only copy, so the pin never engages on the product's own path) can
// return unnoticed while every behavioural test still passes.
// The inline script is emitted through a TypeScript template literal, so a
// source-level look at gallery.ts is not what the browser receives. Template
// escapes are resolved before serving: a real newline written inside a
// single-quoted JS string survives into the served script as a SyntaxError and
// stops EVERY handler on the page from registering, leaving the gallery inert
// while the TypeScript still compiles and every source guard still passes.
// So parse the SERVED script, not the source.
describe('served page script parses', () => {
  test('the inline script the browser receives is syntactically valid', () => {
    const html = renderGallery([fakeCard({ isSlideshow: true, experimentEligible: true })], undefined, {});
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    // Parseability alone is not the intent: deleting the separator outright
    // still parses, and the label silently loses its line break. The served
    // script must carry the ESCAPE, which JS reads as the newline.
    expect(script).toContain("tool:\\n'");
  });
});

test('served character edit payload keeps copy and matches the MCP instructions', () => {
  const html = renderGallery([fakeCard({ isSlideshow: true, experimentEligible: true })], undefined, {});
  expect(html).toContain('<option value="character">Character</option>');
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const fields: Record<string, string> = {
    'edit-variable': 'character', 'edit-character': ' Short blond hair ', 'edit-lang': 'English',
    // Stale copy inputs must never ride on a character edit.
    'edit-hook': 'Stale replacement text', 'edit-ov-2': '',
  };
  const build = script.slice(script.indexOf('function buildPayload()'), script.indexOf('// sourceSlides is display-only'));
  const payload = new Function('selCards', 'selected', 'mode', 'str', build + '; return buildPayload();')(
    () => [{ getAttribute: () => '3' }], ['vid-1'], 'edit', (id: string) => (fields[id] ?? '').trim(),
  );
  expect(payload.instructions).toEqual(editInstructions(undefined, [], 'English', { variables: ['character'], character: 'Short blond hair' }));
  expect(payload.instructions).not.toHaveProperty('copyOverrides');
  const { surveyMode, ...rest } = payload;
  expect(Create.safeParse({ workspaceId: 'w1', idempotencyKey: 'gallery:character', ...rest }).success).toBe(true);
  // Run the served host/chat conversion too, so it cannot silently fall back to hook edits.
  const conversion = script.slice(script.indexOf('var chatPayload;'), script.indexOf("document.getElementById('exp-host-payload').textContent"));
  const chat = new Function('mode', 'p', 'str', conversion + '; return chatPayload;')('edit', payload, (id: string) => (fields[id] ?? '').trim());
  expect(chat).toMatchObject({ mode: 'edit', variables: ['character'], character: 'Short blond hair', videoIds: ['vid-1'] });
  expect(chat).not.toHaveProperty('hook');
  expect(chat).not.toHaveProperty('overlayTexts');
  expect(chat).not.toHaveProperty('instructions');
});

describe('edit-mode payload emission (source guards)', () => {
  const source = readFileSync(new URL('../ui/gallery.ts', import.meta.url), 'utf8');

  test('the edit payload carries structured copyOverrides next to the prose', () => {
    // Exact values keyed by 0-based slide index, including explicit blanks.
    expect(source).toContain("var copyOverrides = { '0': hook };");
    expect(source).toContain('copyOverrides[String(k + 1)] = t;');
    expect(source).toContain('copyOverrides: copyOverrides,');
    // Bounded by the clamped slideCount, ONCE, before either carrier is built.
    // A long deck still shows a box per source slide, but a key per box — or a
    // prose line per box — would exceed a cap and be refused at create time.
    expect(source).toContain('overlays = overlays.slice(0, Math.min(overlays.length, Math.max(0, slideCount - 1)));');
    // The slice must come BEFORE the prose lines are built, or direction stays
    // unbounded and a 10-slide deck fails on the 2000-char field instead.
    const slice = source.indexOf('overlays = overlays.slice(0,');
    const lines = source.indexOf('var lines = [\'Slide 1 (hook)');
    const keys = source.indexOf('copyOverrides[String(k + 1)] = t;');
    expect(slice).toBeGreaterThan(-1);
    expect(lines).toBeGreaterThan(slice);
    expect(keys).toBeGreaterThan(slice);
  });

  test('review-only data never rides on the payload object', () => {
    // Should-fix 4: create mode builds the host/chat box with
    // Object.assign({}, p), so a property attached to p for display is pasted
    // out as a create_experiment parameter that does not exist.
    expect(source).toContain('function reviewHtml(p, sourceSlides)');
    expect(source).toContain('reviewHtml(p, srcSlides)');
    expect(source).not.toContain('p.sourceSlides');
  });

  test('the not-rendered row reads correctly for a single dropped slide', () => {
    // Should-fix 5: a 9-photo deck is the most likely trigger and is the bottom
    // of the clamped range, so "Slides 9-9" is the common case, not an edge one.
    expect(source).toContain("sourceSlides === p.slideCount + 1 ? 'Slide ' : 'Slides '");
  });

  test('the host/chat payload is a real edit call, not a prose-only create', () => {
    // Deleting surveyMode alone left the pasted call with no mode, so it fell
    // through to create mode and the requested copy was never pinned.
    expect(source).toContain("mode: 'edit', videoIds: p.videoIds,");
    expect(source).toContain('hook: ov[\'0\'], overlayTexts: ovs');
    // The overlay list is rebuilt positionally, which is the only shape
    // overlayTexts can express.
    expect(source).toContain('for (var k = 1; ov[String(k)] !== undefined; k++) ovs.push(ov[String(k)]);');
  });
});
