// ---------------------------------------------------------------------------
// MCP App — the outlier gallery. docs/media-storage-plan.md §4.
//
// A `ui://` resource rendered inside the conversation (MCP Apps, SEP-1865).
// Phase 1 is what made this worth building: the cards read stored thumbnails
// rather than source-CDN URLs that expire within hours, and the key moments
// come from schema v3.
//
// Deliberately self-contained — inline CSS, inline JS, no external scripts.
// The host renders this in a sandboxed iframe under a deny-by-default CSP, so
// every origin has to be declared; the declared origins (resourceDomains in
// src/tools/gallery.ts) only back the direct-URL fallback rendering.
//
// Media delivery follows the ext-apps video-resource-server pattern. Inside
// an MCP host the page runs a minimal ui/initialize + resources/read
// handshake (mirroring the SDK's PostMessageTransport — ~80 lines instead of
// the 300KB client bundle) and loads each cover and each MP4 as a base64
// blob over the host channel, turning them into object URLs. That removes
// the CSP dependence entirely: covers and playback work even in hosts that
// ignore `_meta.ui.csp.resourceDomains`. Outside a host (the signed /gallery
// browser route) window.parent === window, the handshake is skipped and the
// direct thumb/media URLs render exactly as before.
//
// Filters (outlier threshold, min views, sort) and Prev/Next pagination run
// entirely client-side over the cards already inlined into the HTML — no
// fetch, so they work inside Claude's sandbox without connect-src. Load a
// larger pool server-side so filtering + paging still has material to show.
// ---------------------------------------------------------------------------

export interface GalleryCard {
  id: string;
  /** 1-based position in the pool this card was built from — stable across
   *  client-side re-sort/re-page, and what a caller means by "video 3". */
  index: number;
  creatorHandle: string;
  caption: string;
  url: string;
  thumbUrl: string | null;
  views: number;
  engagementRate: string;
  outlierScore: number | null;
  durationSec: number | null;
  /** Epoch ms the video was posted — drives the "newest" sort. */
  postedAt: number;
  /** Friendly key of the backend behind the most recent analysis, or null when
   *  the video has never been analysed — feeds the "Analyzed by" toolbar. */
  analyzedBy: 'openrouter' | null;
  /** Epoch ms the most recent analysis was created — drives "recently analyzed"
   *  ordering when an "Analyzed by" backend is selected. */
  analyzedAt: number | null;
  /** Signed URL for the stored MP4, null when nothing is stored (or it expired). */
  mediaUrl: string | null;
  /**
   * `covers://slashloop/{id}` — the stored TikTok cover as a base64-blob
   * resource read, null when no cover is stored. Lets the app embed covers
   * over the MCP channel instead of relying on img-src CSP.
   */
  coverUri: string | null;
  /**
   * `videos://slashloop/{id}` — the stored MP4 as a base64-blob resource read,
   * null when nothing is stored. Has the same underlying condition as
   * mediaUrl, plus the case where the object is stored but signing failed.
   */
  videoUri: string | null;
  /** Photo-carousel URLs when the TikTok is a slideshow (no MP4). */
  slideshowImages: string[];
  /** AI-recreated carousel URLs. */
  recreationImages: string[];
  /** True when this TikTok is a photo post — never offer MP4 download. */
  isSlideshow: boolean;
  /** Why this video couldn't be scraped by the fetch worker (Apify etc.), when
   *  it has no stored video — lets the card show an error icon + tooltip. */
  fetchError: { code: string; message: string } | null;
  /** True when this post is from the workspace's own TikTok (Source.isSelf
   *  or the same handle). Gallery shows a You badge. */
  isSelf: boolean;
  keyMoments: Array<{
    timestampSec: number;
    role: string;
    subjectAction: string;
    framing: string | null;
    lighting: string | null;
  }>;
}

/** Initial filter state baked into the HTML (tool args or resource query). */
export interface GalleryFilters {
  /** Minimum outlier score, 0 = any. */
  minOutlier?: number;
  /** Minimum views, 0 = any. */
  minViews?: number;
  /** Sort key for the visible set. */
  sortBy?: 'outlier_score' | 'views' | 'newest';
  /**
   * Initial "Analyzed by" backend for the toolbar ('' = any). Choosing a
   * backend shows only videos whose most recent analysis ran there, ordered
   * most-recently-analyzed first.
   */
  analyzedBy?: 'openrouter';
  /**
   * Thumbnail density in the Claude iframe:
   * large / medium / small grids, or list (smallest thumbs, one row each).
   */
  density?: 'large' | 'medium' | 'small' | 'list';
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function cardHtml(c: GalleryCard): string {
  const moments = c.keyMoments.length
    ? `<div class="moments">${c.keyMoments.map(m => `
        <button class="moment" data-video="${esc(c.id)}" data-t="${m.timestampSec}"
                title="${esc(m.subjectAction)}">
          <span class="role">${esc(m.role)}</span>
          <span class="t">${m.timestampSec.toFixed(1)}s</span>
        </button>`).join('')}</div>`
    : '';

  // The <video> is wrapped so host mode can lay a play overlay over it
  // without geometry guessing. preload="none" so a gallery of them costs
  // nothing until someone actually asks for one — egress is metered on this
  // plan. poster gives the collapsed player a face before anything loads.
  const fetchMsg = c.fetchError ? `${c.fetchError.message} (${c.fetchError.code})` : null;
  const player = c.mediaUrl
    ? `<div class="player-wrap"><video id="v-${esc(c.id)}" class="player" preload="none" controls playsinline
              src="${esc(c.mediaUrl)}"${c.thumbUrl ? ` poster="${esc(c.thumbUrl)}"` : ''}${c.videoUri ? ` data-video-uri="${esc(c.videoUri)}"` : ''}></video></div>`
    : fetchMsg
      ? `<p class="nomedia nomedia-fetch">⛔ Could not scrape this video — ${esc(fetchMsg)}. Frames unavailable.</p>`
      : `<p class="nomedia">No stored video — expired or never analysed. Frames unavailable.</p>`;

  // Cover: direct stored URL for the no-host fallback, plus data-cover-uri so
  // host mode can swap in the blob read (the only source when the public
  // thumb origin is missing from the host's CSP).
  const coverAttrs = c.coverUri ? ` data-cover-uri="${esc(c.coverUri)}"` : '';
  const thumb = c.thumbUrl
    ? `<img class="thumb" src="${esc(c.thumbUrl)}" alt="" loading="lazy"${coverAttrs}/>`
    : `<div class="thumb placeholder"${coverAttrs}></div>`;

  const score = c.outlierScore ?? 0;
  // data-* drives client-side filters (no network).
  return `
  <article class="card"
           data-score="${score}"
           data-views="${c.views}"
           data-posted="${c.postedAt}"
           data-analyzed-by="${esc(c.analyzedBy ?? '')}"
           data-analyzed-at="${c.analyzedAt ?? ''}"
           data-has-media="${c.mediaUrl ? '1' : '0'}"
           data-fetch-error="${c.fetchError ? esc(c.fetchError.code) : ''}"
           data-handle="${esc(c.creatorHandle.toLowerCase())}">
    <span class="index-badge" title="Reference this as &quot;video ${c.index}&quot;">${c.index}</span>
    ${thumb}
    <div class="body">
      <div class="meta">
        <strong>@${esc(c.creatorHandle)}</strong>
        ${c.isSelf ? '<span class="self-badge">You</span>' : ''}
        <span>${compact(c.views)} views</span>
        <span>${esc(c.engagementRate)} eng</span>
        ${c.outlierScore != null ? `<span class="score-badge">${c.outlierScore.toFixed(1)}x</span>` : ''}
        ${c.durationSec != null ? `<span>${c.durationSec}s</span>` : ''}
        ${c.fetchError ? `<span class="fetch-error" title="Could not be scraped — ${esc(fetchMsg)}" aria-label="scrape error">⛔</span>` : ''}
      </div>
      <p class="caption">${esc(c.caption) || '<em>no caption</em>'}</p>
      ${player}
      ${moments}
      <a class="src" href="${esc(c.url)}" target="_blank" rel="noreferrer">open on TikTok</a>
    </div>
  </article>`;
}

function selectedAttr(current: number | string, value: number | string): string {
  return String(current) === String(value) ? ' selected' : '';
}

/** Default cards per page for the medium grid (client-side only). */
const PAGE_SIZE_MEDIUM = 12;

function toolbarHtml(filters: GalleryFilters): string {
  const minOutlier = filters.minOutlier ?? 0;
  const minViews = filters.minViews ?? 0;
  const sortBy = filters.sortBy ?? 'outlier_score';
  const analyzedBy = filters.analyzedBy ?? '';
  const density = filters.density ?? 'medium';

  return `
<header class="toolbar" role="region" aria-label="Gallery filters">
  <div class="filters">
    <label class="field">
      <span class="field-label">Outlier score</span>
      <select id="f-outlier" aria-label="Minimum outlier score">
        <option value="0"${selectedAttr(minOutlier, 0)}>Any</option>
        <option value="2"${selectedAttr(minOutlier, 2)}>≥ 2×</option>
        <option value="5"${selectedAttr(minOutlier, 5)}>≥ 5×</option>
        <option value="10"${selectedAttr(minOutlier, 10)}>≥ 10×</option>
        <option value="25"${selectedAttr(minOutlier, 25)}>≥ 25×</option>
        <option value="50"${selectedAttr(minOutlier, 50)}>≥ 50×</option>
        <option value="100"${selectedAttr(minOutlier, 100)}>≥ 100×</option>
      </select>
    </label>
    <label class="field">
      <span class="field-label">Min views</span>
      <select id="f-views" aria-label="Minimum views">
        <option value="0"${selectedAttr(minViews, 0)}>Any</option>
        <option value="10000"${selectedAttr(minViews, 10000)}>≥ 10K</option>
        <option value="100000"${selectedAttr(minViews, 100000)}>≥ 100K</option>
        <option value="1000000"${selectedAttr(minViews, 1000000)}>≥ 1M</option>
        <option value="10000000"${selectedAttr(minViews, 10000000)}>≥ 10M</option>
      </select>
    </label>
    <label class="field">
      <span class="field-label">Sort</span>
      <select id="f-sort" aria-label="Sort cards">
        <option value="outlier_score"${selectedAttr(sortBy, 'outlier_score')}>Outlier score</option>
        <option value="views"${selectedAttr(sortBy, 'views')}>Most views</option>
        <option value="newest"${selectedAttr(sortBy, 'newest')}>Newest</option>
      </select>
    </label>
    <label class="field">
      <span class="field-label">Analyzed by</span>
      <select id="f-analyzed" aria-label="Analysis backend">
        <option value=""${selectedAttr(analyzedBy, '')}>Any</option>
        <option value="openrouter"${selectedAttr(analyzedBy, 'openrouter')}>OpenRouter</option>
      </select>
    </label>
    <label class="field">
      <span class="field-label">Thumbnails</span>
      <select id="f-density" aria-label="Thumbnail size and layout">
        <option value="large"${selectedAttr(density, 'large')}>Large</option>
        <option value="medium"${selectedAttr(density, 'medium')}>Medium</option>
        <option value="small"${selectedAttr(density, 'small')}>Small</option>
        <option value="list"${selectedAttr(density, 'list')}>List (smallest)</option>
      </select>
    </label>
    <label class="field check">
      <input type="checkbox" id="f-media" />
      <span class="field-label">Has stored video</span>
    </label>
  </div>
  <div class="pager" role="navigation" aria-label="Gallery pages">
    <button type="button" class="page-btn" id="f-prev" aria-label="Previous page">← Prev</button>
    <p class="count" id="f-count" aria-live="polite"></p>
    <button type="button" class="page-btn" id="f-next" aria-label="Next page">Next →</button>
  </div>
</header>`;
}

export function renderGallery(
  cards: GalleryCard[],
  note?: string,
  filters: GalleryFilters = {},
): string {
  const body = cards.length
    ? cards.map(cardHtml).join('')
    : `<p class="empty" id="empty-pool">No videos yet. Track a source and run <code>refresh_source</code>.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>slashloop — outliers</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 14%, transparent); }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 12px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end;
             justify-content: space-between; margin-bottom: 12px;
             padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .field.check { flex-direction: row; align-items: center; gap: 6px; padding-bottom: 2px; }
  .field-label { opacity: .75; font-weight: 500; }
  select { font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--line);
           border-radius: 8px; background: transparent; color: inherit; min-width: 7.5rem;
           max-width: 100%; }
  select:focus, .field.check input:focus { outline: 2px solid color-mix(in srgb, currentColor 35%, transparent);
           outline-offset: 1px; }
  .pager { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .page-btn { font: inherit; font-size: 13px; padding: 5px 12px; border: 1px solid var(--line);
              border-radius: 8px; background: none; color: inherit; cursor: pointer; }
  .page-btn:hover:not(:disabled) { border-color: currentColor; }
  .page-btn:disabled { opacity: .35; cursor: not-allowed; }
  .page-btn:focus { outline: 2px solid color-mix(in srgb, currentColor 35%, transparent); outline-offset: 1px; }
  .count { margin: 0; font-size: 12px; opacity: .7; white-space: nowrap; min-width: 9rem; text-align: center; }

  /* ---- density: medium (default) ---- */
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card { position: relative; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .card[hidden] { display: none !important; }
  .index-badge { position: absolute; top: 6px; left: 6px; z-index: 1; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: 999px; background: rgba(0,0,0,.65); color: #fff; font-size: 10px;
    font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1; }
  .density-list .index-badge { position: static; margin-left: 6px; align-self: center; }
  .thumb { width: 100%; aspect-ratio: 9/16; object-fit: cover; display: block; background: var(--line); }
  .thumb.placeholder { display: grid; place-items: center; }
  .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; opacity: .8; }
  .score-badge { font-weight: 600; opacity: 1; }
  .self-badge { font-weight: 700; opacity: 1; color: #0F7B6C; }
  .fetch-error { cursor: help; font-size: 13px; line-height: 1; color: #ff5c5c; }
  .nomedia-fetch { color: #ff5c5c; opacity: .85; }
  .caption { margin: 0; font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .player-wrap { position: relative; }
  .player { width: 100%; border-radius: 6px; background: #000; }
  /* Host mode only: sits over the player until the blob resource read lands.
     The glyph makes the click affordance obvious while src is stripped. */
  .play-overlay { position: absolute; inset: 0; display: grid; place-items: center;
                  cursor: pointer; background: rgba(0,0,0,.35); border-radius: 6px; min-height: 120px; }
  .play-overlay .glyph { font-size: 34px; color: #fff; line-height: 1;
                         text-shadow: 0 1px 6px rgba(0,0,0,.6); pointer-events: none; }
  .nomedia { margin: 0; font-size: 12px; opacity: .6; }
  .moments { display: flex; flex-wrap: wrap; gap: 6px; }
  .moment { font: inherit; font-size: 11px; padding: 3px 7px; border: 1px solid var(--line);
            border-radius: 999px; background: none; color: inherit; cursor: pointer; display: flex; gap: 5px; }
  .moment:hover { border-color: currentColor; }
  .moment .t { opacity: .6; }
  .src { font-size: 12px; opacity: .7; }

  /* large thumbs — fewer columns, bigger cover */
  .density-large .grid { gap: 14px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .density-large .body { padding: 12px; gap: 10px; }
  .density-large .caption { font-size: 14px; -webkit-line-clamp: 3; }

  /* small thumbs — denser grid */
  .density-small .grid { gap: 8px; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .density-small .body { padding: 6px; gap: 4px; }
  .density-small .meta { gap: 4px 6px; font-size: 11px; }
  .density-small .caption { font-size: 11px; -webkit-line-clamp: 1; }
  .density-small .nomedia,
  .density-small .moments,
  .density-small .player-wrap { display: none; }
  .density-small .src { font-size: 11px; }

  /* list — smallest thumbs, one row per video */
  .density-list .grid { display: flex; flex-direction: column; gap: 6px; }
  .density-list .card { flex-direction: row; align-items: stretch; border-radius: 8px; }
  .density-list .thumb { width: 48px; min-width: 48px; max-width: 48px; aspect-ratio: 9/16;
                         height: auto; max-height: 72px; align-self: center; margin-left: 6px;
                         border-radius: 4px; }
  .density-list .body { padding: 6px 10px; gap: 2px; flex: 1; justify-content: center; }
  .density-list .meta { gap: 4px 8px; font-size: 12px; }
  .density-list .caption { font-size: 12px; -webkit-line-clamp: 1; }
  .density-list .nomedia,
  .density-list .moments,
  .density-list .player-wrap { display: none; }
  .density-list .src { font-size: 11px; }

  .empty, .note { opacity: .7; }
  .note { font-size: 12px; margin: 0 0 10px; }
  .fetch-banner { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 10px;
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
    background: color-mix(in srgb, currentColor 6%, transparent); font-size: 12px; }
  .fetch-banner[hidden] { display: none; }
  .fetch-banner strong { font-weight: 600; }
  .card.fetch-eligible { border-color: color-mix(in srgb, currentColor 40%, transparent); position: relative; }
  .card.fetch-eligible .thumb { outline: 2px solid color-mix(in srgb, currentColor 45%, transparent); outline-offset: -2px; }
  .card.fetch-eligible::after { content: 'fetch ≥50×'; position: absolute; top: 6px; right: 6px;
    font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
    background: color-mix(in srgb, currentColor 18%, transparent); border: 1px solid var(--line); }
  .empty-filter { display: none; opacity: .7; margin: 24px 0; text-align: center; }
  .empty-filter.show { display: block; }
</style></head>
<body class="density-${esc(filters.density ?? 'medium')}">
${note ? `<p class="note">${esc(note)}</p>` : ''}
${cards.length ? toolbarHtml(filters) : ''}
<div class="fetch-banner" id="fetch-banner" hidden>
  <strong><span class="fetch-count">0</span> outliers ≥50× have no stored video.</strong>
  To play &amp; scrub them here, ask: “fetch videos for outliers ≥50×”.
</div>
<div class="grid" id="grid">${body}</div>
<p class="empty-filter" id="empty-filter">No videos match these filters. Lower the outlier threshold or min views.</p>
<script>
(function () {
  var PAGE_SIZES = { large: 6, medium: ${PAGE_SIZE_MEDIUM}, small: 24, list: 24 };
  var grid = document.getElementById('grid');
  var outlierEl = document.getElementById('f-outlier');
  var viewsEl = document.getElementById('f-views');
  var sortEl = document.getElementById('f-sort');
  var densityEl = document.getElementById('f-density');
  var mediaEl = document.getElementById('f-media');
  var analyzedEl = document.getElementById('f-analyzed');
  var countEl = document.getElementById('f-count');
  var emptyEl = document.getElementById('empty-filter');
  var prevEl = document.getElementById('f-prev');
  var nextEl = document.getElementById('f-next');
  var bannerEl = document.getElementById('fetch-banner');
  var FETCH_THRESHOLD = 50;
  if (!grid || !outlierEl) return;

  var page = 0;

  function pageSize() {
    var d = (densityEl && densityEl.value) || 'medium';
    return PAGE_SIZES[d] || PAGE_SIZES.medium;
  }

  function setDensity(d) {
    var body = document.body;
    body.className = body.className
      .replace(/\\bdensity-\\w+/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
    body.classList.add('density-' + (d || 'medium'));
  }

  function allCards() {
    return Array.prototype.slice.call(grid.querySelectorAll('.card'));
  }

  function matches(card, minScore, minViews, needMedia, analyzedBy) {
    var score = parseFloat(card.getAttribute('data-score')) || 0;
    var views = parseInt(card.getAttribute('data-views'), 10) || 0;
    var hasMedia = card.getAttribute('data-has-media') === '1';
    if (analyzedBy) {
      // data-analyzed-by is the friendly backend key; "" means never analyzed.
      var ab = card.getAttribute('data-analyzed-by') || '';
      if (ab.indexOf(analyzedBy) !== 0) return false;
    }
    return score >= minScore && views >= minViews && (!needMedia || hasMedia);
  }

  function sortCards(list, sortBy) {
    return list.slice().sort(function (a, b) {
      var av = parseFloat(a.getAttribute('data-score')) || 0;
      var bv = parseFloat(b.getAttribute('data-score')) || 0;
      var aw = parseInt(a.getAttribute('data-views'), 10) || 0;
      var bw = parseInt(b.getAttribute('data-views'), 10) || 0;
      if (sortBy === 'analyzed') {
        // Most recently analyzed first — drives the "Analyzed by" filter.
        var aa = parseInt(a.getAttribute('data-analyzed-at'), 10) || 0;
        var ba = parseInt(b.getAttribute('data-analyzed-at'), 10) || 0;
        return ba - aa || bv - av;
      }
      if (sortBy === 'views') return bw - aw || bv - av;
      if (sortBy === 'newest') {
        var ap = parseInt(a.getAttribute('data-posted'), 10) || 0;
        var bp = parseInt(b.getAttribute('data-posted'), 10) || 0;
        return bp - ap || bv - av;
      }
      return bv - av || bw - aw;
    });
  }

  function apply(resetPage) {
    if (resetPage) page = 0;

    var minScore = parseFloat(outlierEl.value) || 0;
    var minViews = parseInt(viewsEl && viewsEl.value, 10) || 0;
    var analyzedBy = (analyzedEl && analyzedEl.value) || '';
    // "Analyzed by" is a one-control filter: picking a backend both narrows the
    // set and reorders it by recency (same as the site's Gallery page), so the
    // explicit sort select is ignored while it's active.
    var sortBy = analyzedBy ? 'analyzed' : (sortEl && sortEl.value) || 'outlier_score';
    var density = (densityEl && densityEl.value) || 'medium';
    var needMedia = mediaEl && mediaEl.checked;
    var ps = pageSize();
    var list = allCards();

    setDensity(density);

    // Partition: matching first (sorted), then non-matching.
    var matched = [];
    var rest = [];
    list.forEach(function (card) {
      if (matches(card, minScore, minViews, needMedia, analyzedBy)) matched.push(card);
      else rest.push(card);
    });
    matched = sortCards(matched, sortBy);

    // Tag fetch-eligible cards (outlier >= threshold, no stored video) and show
    // a banner so the caller can offer to download them. The banner count
    // respects the active filter (eligible within matched); the tag goes on
    // every eligible card so it appears whenever that card is paged into view.
    allCards().forEach(function (card) {
      var isElig = (parseFloat(card.getAttribute('data-score')) || 0) >= FETCH_THRESHOLD
        && card.getAttribute('data-has-media') !== '1';
      card.classList.toggle('fetch-eligible', isElig);
    });
    var eligibleShown = matched.filter(function (card) {
      return card.classList.contains('fetch-eligible');
    }).length;
    if (bannerEl) {
      bannerEl.hidden = eligibleShown === 0;
      if (eligibleShown > 0) {
        var c = bannerEl.querySelector('.fetch-count');
        if (c) c.textContent = String(eligibleShown);
      }
    }

    var totalPages = Math.max(1, Math.ceil(matched.length / ps) || 1);
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    var start = page * ps;
    var end = start + ps;

    // Hide everyone, then show only this page of matches. Re-append so DOM order
    // matches sort (matched page slice first).
    list.forEach(function (card) { card.hidden = true; });
    matched.forEach(function (card, i) {
      card.hidden = !(i >= start && i < end);
      grid.appendChild(card);
    });
    rest.forEach(function (card) { grid.appendChild(card); });

    var shown = matched.length === 0 ? 0 : Math.min(end, matched.length) - start;
    var from = matched.length === 0 ? 0 : start + 1;
    var to = matched.length === 0 ? 0 : start + shown;

    if (countEl) {
      if (matched.length === 0) {
        countEl.textContent = '0 of ' + list.length + ' match';
      } else {
        countEl.textContent =
          from + '–' + to + ' of ' + matched.length +
          ' · p.' + (page + 1) + '/' + totalPages;
      }
    }
    if (prevEl) prevEl.disabled = page <= 0 || matched.length === 0;
    if (nextEl) nextEl.disabled = page >= totalPages - 1 || matched.length === 0;

    if (emptyEl) {
      if (matched.length === 0 && list.length > 0) emptyEl.classList.add('show');
      else emptyEl.classList.remove('show');
    }
  }

  function onFilterChange() { apply(true); }

  outlierEl.addEventListener('change', onFilterChange);
  if (viewsEl) viewsEl.addEventListener('change', onFilterChange);
  if (sortEl) sortEl.addEventListener('change', onFilterChange);
  if (densityEl) densityEl.addEventListener('change', onFilterChange);
  if (mediaEl) mediaEl.addEventListener('change', onFilterChange);
  if (analyzedEl) analyzedEl.addEventListener('change', onFilterChange);
  if (prevEl) prevEl.addEventListener('click', function () { page -= 1; apply(false); });
  if (nextEl) nextEl.addEventListener('click', function () { page += 1; apply(false); });
  apply(true);

  // ── MCP Apps host link (minimal client) ──
  // Mirrors @modelcontextprotocol/ext-apps' PostMessageTransport + App.connect()
  // for exactly what this page needs: the ui/initialize handshake and proxied
  // resources/read calls (covers + MP4s as base64 blobs — the ext-apps
  // video-resource-server pattern). A full SDK bundle is ~300KB per gallery
  // render; this block is the whole client. Any failure leaves the fallback
  // rendering (direct thumb/media URLs) untouched.
  var MCP = (function () {
    if (window.parent === window) {
      // Browser route (signed /gallery link, preview script): not framed, so
      // there is no host to handshake with — never start a timeout.
      return {
        ready: function () { return Promise.resolve(false); },
        canReadResources: function () { return false; },
        readResource: null,
      };
    }
    var nextId = 1;
    var pending = {};
    var initPromise = null;
    var canRead = false;

    function send(msg) { window.parent.postMessage(msg, '*'); }

    function request(method, params, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        var timer = setTimeout(function () {
          delete pending[id];
          reject(new Error(method + ' timed out'));
        }, timeoutMs || 20000);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        send({ jsonrpc: '2.0', id: id, method: method, params: params });
      });
    }

    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent) return;
      var d = ev.data;
      if (!d || d.jsonrpc !== '2.0') return;
      if (d.method != null && d.id != null) {
        // Host→app requests: answer ping, decline anything else so the host
        // never hangs on a view that implements no app-side handlers.
        if (d.method === 'ping') send({ jsonrpc: '2.0', id: d.id, result: {} });
        else send({ jsonrpc: '2.0', id: d.id, error: { code: -32601, message: 'Not implemented: ' + d.method } });
        return;
      }
      if (d.id == null) return; // notifications carry no id — nothing pending
      var p = pending[d.id];
      if (!p) return;
      clearTimeout(p.timer);
      delete pending[d.id];
      if (d.error) p.reject(new Error(d.error.message || 'request failed'));
      else p.resolve(d.result);
    });

    function ready() {
      if (initPromise) return initPromise;
      initPromise = request('ui/initialize', {
        appInfo: { name: 'slashloop-gallery', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      }, 5000).then(function (res) {
        // resources/read proxying is opt-in on the host side; without it the
        // blob pattern is unreachable and direct URLs are the only path.
        canRead = Boolean(res && res.hostCapabilities && res.hostCapabilities.serverResources);
        send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        return canRead;
      }, function () { return false; });
      return initPromise;
    }

    return {
      ready: ready,
      canReadResources: function () { return canRead; },
      readResource: function (uri) { return request('resources/read', { uri: uri }); },
    };
  })();

  function resourceObjectUrl(res) {
    var c = res && res.contents && res.contents[0];
    if (!c || !c.blob) return null;
    var bin = atob(c.blob);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: c.mimeType || 'application/octet-stream' }));
  }

  function removeOverlay(v) {
    var wrap = v.parentNode;
    var o = wrap && wrap.querySelector('.play-overlay');
    if (o) o.remove();
  }

  /** Load an MP4 through the host channel and point the player at the blob. */
  function loadViaHost(v) {
    if (v.dataset.hostLoaded === '1') return Promise.resolve(true);
    if (v.dataset.hostLoading === '1') return v._hostPromise || Promise.resolve(false);
    var uri = v.dataset.videoUri;
    if (!uri || !MCP.canReadResources()) return Promise.resolve(false);
    v.dataset.hostLoading = '1';
    v._hostPromise = MCP.readResource(uri).then(function (res) {
      var url = resourceObjectUrl(res);
      if (!url) throw new Error('resource read returned no blob');
      v.src = url;
      v.dataset.hostLoaded = '1';
      v.dataset.hostLoading = '0';
      removeOverlay(v);
      return true;
    }).catch(function (err) {
      v.dataset.hostLoading = '0';
      // Restore the signed URL — hosts that honour resourceDomains can still
      // stream it directly even when the blob path failed.
      if (v.dataset.fallbackSrc) v.src = v.dataset.fallbackSrc;
      throw err;
    });
    return v._hostPromise;
  }

  function attachPlayOverlay(v) {
    var wrap = v.parentNode;
    if (!wrap || wrap.querySelector('.play-overlay')) return;
    var o = document.createElement('div');
    o.className = 'play-overlay';
    o.setAttribute('role', 'button');
    o.setAttribute('aria-label', 'Play — loads through the conversation');
    o.title = 'Play — loads through the conversation';
    var g = document.createElement('span');
    g.className = 'glyph';
    g.textContent = '▶';
    o.appendChild(g);
    o.addEventListener('click', function () {
      loadViaHost(v).then(function (ok) {
        if (ok) v.play().catch(function () {});
      }).catch(function () {
        // Blob path failed; the signed URL (if restored) takes over.
        removeOverlay(v);
        v.play().catch(function () {});
      });
    });
    wrap.appendChild(o);
  }

  /** Swap covers to blob reads as their cards scroll into view. */
  function setupCoverLoader() {
    var els = grid.querySelectorAll('[data-cover-uri]');
    if (!els.length) return;
    var cache = {};
    function load(el) {
      var uri = el.dataset.coverUri;
      if (!uri || el.dataset.coverState === '1') return;
      el.dataset.coverState = '1';
      MCP.readResource(uri).then(function (res) {
        var url = resourceObjectUrl(res);
        if (!url) throw new Error('no cover blob');
        cache[uri] = url;
        var img = document.createElement('img');
        img.className = 'thumb';
        img.alt = '';
        img.src = url;
        el.replaceWith(img);
      }).catch(function () {
        // Keep whatever was there (direct URL or placeholder).
        el.dataset.coverState = '0';
      });
    }
    if (typeof IntersectionObserver === 'undefined') {
      Array.prototype.forEach.call(els, load);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        load(en.target);
      });
    }, { rootMargin: '200px' });
    Array.prototype.forEach.call(els, function (el) { io.observe(el); });
  }

  function activateHostMode() {
    // Video: strip the direct src (kept as fallback) and stack a play overlay
    // on every player so the first play loads through resources/read.
    allCards().forEach(function (card) {
      var v = card.querySelector('video.player');
      if (!v || !v.dataset.videoUri) return;
      var src = v.getAttribute('src');
      if (src) {
        v.dataset.fallbackSrc = src;
        v.removeAttribute('src');
      }
      attachPlayOverlay(v);
    });
    setupCoverLoader();
  }

  MCP.ready().then(function (ok) {
    if (ok && MCP.canReadResources()) activateHostMode();
  });

  // Key-moment seek: one source per video, seek without re-fetch. In host
  // mode the first seek rides the same blob load as play.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.moment') : null;
    if (!btn) return;
    var v = document.getElementById('v-' + btn.dataset.video);
    if (!v) return;
    var t = parseFloat(btn.dataset.t) || 0;
    var go = function () { try { v.currentTime = t; v.play(); } catch (err) {} };
    var whenReady = function () {
      if (v.readyState >= 1) go();
      else v.addEventListener('loadedmetadata', go, { once: true });
    };
    if (v.dataset.videoUri && v.dataset.hostLoaded !== '1' && MCP.canReadResources()) {
      loadViaHost(v).then(function (ok) {
        if (ok) whenReady();
        else { v.load(); whenReady(); }
      }).catch(function () { whenReady(); });
      return;
    }
    whenReady();
    if (v.readyState < 1) v.load();
  });
})();
</script>
</body></html>`;
}
