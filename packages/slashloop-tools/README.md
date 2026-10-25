# slashloop-tools

Public free tools served at `https://slashloop.dev/tools/*` by their own Cloudflare Worker, on the route `slashloop.dev/tools*` in front of the Vercel-hosted marketing site. A bug or cost spike here cannot touch the paid product.

## Hard rule: never call TikTok from this Worker

This Worker never fetches `tiktok.com` or its CDN. Only the VPS job worker fetches from TikTok, and a `GET` request never triggers a scrape. See SLA-1042 (feasibility).

## How it works

- `bun run build` renders every page in the registry (`src/pages/index.ts`) to static HTML in `dist/tools/<path>/index.html`, plus `404.html` and `pages.json`, and copies `public/` into `dist/tools/`.
- Static files are served by Workers Assets (`not_found_handling: "404-page"`, so unknown `/tools/...` paths return a real HTTP 404 with `dist/tools/404.html`).
- `src/worker.ts` runs first only for `/tools/api/*` and `/tools/sitemap.xml`. The sitemap is built from `pages.json` plus the KV key `sitemap:dynamic` (JSON array of `{loc, lastmod}`, used by later issues; entries outside `https://slashloop.dev/tools/` are dropped).
- Bindings: `TOOLS_CACHE` (KV), `TOOLS_DB` (D1, migrations in `migrations/`).

## Add a page

1. Put logic in an optional module, for example `src/calc/<name>.ts`, with its own tests.
2. Add an entry to `PAGES` in `src/pages/index.ts`: `{ path, title, description, category, render, changefreq? }`. `render()` should call `renderPage({ path, title, description, body, cta })` from `src/layout.ts`.
3. Every indexable page needs a real title, meta description and canonical URL (the layout emits the canonical from `path`). Use `noindex: true` for pages that must not be indexed.
4. Use "TikTok" and "Instagram" descriptively only: no logos. The footer carries "Not affiliated with TikTok or Meta."
5. `bun test` checks that every registry page builds and has a title, description and canonical tag. The page appears in `/tools/sitemap.xml` automatically.

## Develop and test

```sh
bun install
bun test
bunx tsc --noEmit
bun run dev        # build + wrangler dev
```

## Deploy

CI deploys on every push to `master` that touches `packages/slashloop-tools/**` (`.github/workflows/deploy-tools.yml`). Manual deploy:

```sh
export CLOUDFLARE_API_TOKEN=$CF_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$CF_ACCOUNT_ID
bunx wrangler d1 migrations apply slashloop-tools --remote
bun run deploy
```

Rollback: `bunx wrangler rollback`, or remove the `slashloop.dev/tools*` route in the Cloudflare dashboard to hand all traffic back to the site.
