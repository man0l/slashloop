// ---------------------------------------------------------------------------
// Local gallery preview — open the MCP App HTML without Claude.
//
// Uses the same buildCards/renderGallery path as show_gallery, against the
// local/default workspace (no JWT). Write HTML to disk and optionally serve it.
//
// Usage:
//   bun src/scripts/preview_gallery.ts
//   bun src/scripts/preview_gallery.ts --sourceId <uuid>
//   bun src/scripts/preview_gallery.ts --serve
//   bun src/scripts/preview_gallery.ts --serve --port 8790 --open
//
// Thumbs/video only load in the browser if they point at origins the page can
// reach (stored Supabase public/signed URLs). TikTok CDN fallbacks may 403.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { runWithUser } from '../context.js';
import { buildGalleryHtml } from '../tools/gallery.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const sourceId = argValue('--sourceId');
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const serve = hasFlag('--serve');
  const openBrowser = hasFlag('--open') || serve;
  const port = Number(argValue('--port') ?? 8790);

  // Local/default workspace (stdio path): no OAuth user.
  const { html, cards, note, cspOrigin } = await runWithUser(null, () =>
    buildGalleryHtml({ sourceId, limit }),
  );

  const outDir = resolve(process.cwd(), '.preview');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, 'gallery.html');
  writeFileSync(outFile, html, 'utf8');

  console.log(`[preview_gallery] wrote ${outFile}`);
  console.log(`[preview_gallery] cards=${cards.length}`
    + (sourceId ? ` sourceId=${sourceId}` : '')
    + (note ? `\n[preview_gallery] note: ${note}` : ''));
  console.log(`[preview_gallery] cspOrigin=${cspOrigin ?? '(none — thumbs may fail if not stored)'}`);
  if (cards.length) {
    console.log('[preview_gallery] top by outlier score:');
    for (const c of cards.slice(0, 8)) {
      const score = c.outlierScore == null ? '—' : `${c.outlierScore.toFixed(1)}x`;
      console.log(`  ${score.padStart(6)}  @${c.creatorHandle}  ${c.views} views  ${c.caption.slice(0, 50)}`);
    }
  }

  if (!serve) {
    console.log('\nOpen the file in a browser, or re-run with --serve --open');
    console.log(`  file:///${outFile.replace(/\\/g, '/')}`);
    return;
  }

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/gallery.html' || req.url?.startsWith('/gallery')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Dev-only: allow any image/media origin so CDN fallbacks can load
        // outside the Claude sandbox. Production MCP App still uses CSP.
        'Content-Security-Policy': [
          "default-src 'none'",
          "img-src * data: blob:",
          "media-src * blob:",
          "style-src 'unsafe-inline'",
          "script-src 'unsafe-inline'",
          "base-uri 'none'",
        ].join('; '),
      });
      res.end(html);
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolveListen) => {
    server.listen(port, () => resolveListen());
  });

  const url = `http://127.0.0.1:${port}/`;
  console.log(`[preview_gallery] serving ${url}  (Ctrl+C to stop)`);

  if (openBrowser) {
    const { exec } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd);
  }
}

main().catch((err) => {
  console.error('[preview_gallery] failed:', err);
  process.exit(1);
});
