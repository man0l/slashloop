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
// every origin has to be declared; declaring only Supabase keeps that surface
// to one entry and means a bundler is never needed.
//
// §4.3, the playback spike: `resourceDomains` maps to media-src as well as
// img-src (per the extension's own spec types), so a <video> pointing at a
// signed Supabase URL *should* play inline. That is the open question this
// gallery exists to answer — Claude's host has a track record of dropping
// declared CSP fields, and there is no way to know but to look.
// ---------------------------------------------------------------------------

export interface GalleryCard {
  id: string;
  creatorHandle: string;
  caption: string;
  url: string;
  thumbUrl: string | null;
  views: number;
  engagementRate: string;
  outlierScore: number | null;
  durationSec: number | null;
  /** Signed URL for the stored MP4, null when nothing is stored (or it expired). */
  mediaUrl: string | null;
  keyMoments: Array<{
    timestampSec: number;
    role: string;
    subjectAction: string;
    framing: string | null;
    lighting: string | null;
  }>;
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

  // The <video> is the spike. preload="none" so a gallery of them costs nothing
  // until someone actually asks for one — egress is metered on this plan.
  const player = c.mediaUrl
    ? `<video id="v-${esc(c.id)}" class="player" preload="none" controls playsinline
              src="${esc(c.mediaUrl)}"></video>`
    : `<p class="nomedia">No stored video — expired or never analysed. Frames unavailable.</p>`;

  return `
  <article class="card">
    ${c.thumbUrl ? `<img class="thumb" src="${esc(c.thumbUrl)}" alt="" loading="lazy"/>`
                 : `<div class="thumb placeholder"></div>`}
    <div class="body">
      <div class="meta">
        <strong>@${esc(c.creatorHandle)}</strong>
        <span>${compact(c.views)} views</span>
        <span>${esc(c.engagementRate)} eng</span>
        ${c.outlierScore != null ? `<span>${c.outlierScore.toFixed(1)}x</span>` : ''}
        ${c.durationSec != null ? `<span>${c.durationSec}s</span>` : ''}
      </div>
      <p class="caption">${esc(c.caption) || '<em>no caption</em>'}</p>
      ${player}
      ${moments}
      <a class="src" href="${esc(c.url)}" target="_blank" rel="noreferrer">open on TikTok</a>
    </div>
  </article>`;
}

export function renderGallery(cards: GalleryCard[], note?: string): string {
  const body = cards.length
    ? cards.map(cardHtml).join('')
    : `<p class="empty">No videos yet. Track a source and run <code>refresh_source</code>.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>slashloop — outliers</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 14%, transparent); }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; padding: 12px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
  .thumb { width: 100%; aspect-ratio: 9/16; object-fit: cover; display: block; background: var(--line); }
  .thumb.placeholder { display: grid; place-items: center; }
  .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; opacity: .8; }
  .caption { margin: 0; font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .player { width: 100%; border-radius: 6px; background: #000; }
  .nomedia { margin: 0; font-size: 12px; opacity: .6; }
  .moments { display: flex; flex-wrap: wrap; gap: 6px; }
  .moment { font: inherit; font-size: 11px; padding: 3px 7px; border: 1px solid var(--line);
            border-radius: 999px; background: none; color: inherit; cursor: pointer; display: flex; gap: 5px; }
  .moment:hover { border-color: currentColor; }
  .moment .t { opacity: .6; }
  .src { font-size: 12px; opacity: .7; }
  .empty, .note { opacity: .7; }
  .note { font-size: 12px; margin: 0 0 10px; }
</style></head>
<body>
${note ? `<p class="note">${esc(note)}</p>` : ''}
<div class="grid">${body}</div>
<script>
  // Seeking is the whole point of the key-moment chips: one signed URL, one
  // fragment per moment. currentTime is set directly rather than reloading with
  // #t= so an already-buffered video does not re-fetch.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.moment') : null;
    if (!btn) return;
    var v = document.getElementById('v-' + btn.dataset.video);
    if (!v) return;
    var t = parseFloat(btn.dataset.t) || 0;
    var go = function () { try { v.currentTime = t; v.play(); } catch (err) {} };
    if (v.readyState >= 1) go();
    else { v.addEventListener('loadedmetadata', go, { once: true }); v.load(); }
  });
</script>
</body></html>`;
}
