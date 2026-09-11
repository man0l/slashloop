// Cloudflare Worker entry — fetch (all HTTP routes) + scheduled (crons).
//
// Replaces three hosting pieces at once:
//   • Vercel functions (api/*)        → this fetch handler, via src/cf/router.ts
//   • Vercel Cron (daily-only)        → the 0 3 / 0 9 triggers below
//   • Supabase pg_cron + pg_net queue wake (supabase/migrations/*_pgcron_*)
//     → the */1 trigger poking the same /api/jobs/analyze drain logic
//
// Crons authenticate internally with the same CRON_SECRET the HTTP routes
// expect, by dispatching through the router — one auth path, no shadow logic.

import { ensureStore, type Env } from './env.js';
import { route } from './router.js';
import { createOAuthProvider } from './oauth.js';
import { runWithWaitUntil } from './wait-until.js';

// OAuthProvider owns fetch: /mcp (apiHandlers) + /authorize, /token,
// /register and the OAuth metadata endpoints; everything else falls through
// to the existing router via defaultHandler. Scheduled crons bypass the
// provider (it has no scheduled hook) and keep dispatching through the
// router with CRON_SECRET, as before.
const oauth = createOAuthProvider(async (request, env, ctx) => {
  // Pin inside the defaultHandler too: OAuthProvider may invoke this in a
  // nested context where the outer fetch ALS does not apply.
  return runWithWaitUntil((p) => { ctx.waitUntil(p); }, async () => {
    await ensureStore(env, ctx);
    return route(request);
  });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ALS must wrap the whole fetch so Prisma init / db-turn / cache fills
    // can pin work with ctx.waitUntil when the client aborts mid-request.
    return runWithWaitUntil((p) => { ctx.waitUntil(p); }, () => oauth.fetch(request, env, ctx));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runWithWaitUntil((p) => { ctx.waitUntil(p); }, async () => {
      // Register the store first — every drain/sweep touches the DB.
      await ensureStore(env, ctx);

      const cron = event.cron;
      // Real triggers carry their expression; wrangler's local
      // /cdn-cgi/local/scheduled endpoint sends an empty string — default that
      // to the drain (the most frequent trigger) so the path stays testable.
      const path =
        cron === '*/1 * * * *' || cron === '' ? '/api/jobs/analyze'
        : cron === '0 3 * * *' ? '/api/cron/media-retention'
        : cron === '0 9 * * 1' ? '/api/cron/digest'
        : null;
      if (!path) {
        console.warn(`[worker] unknown cron: ${cron}`);
        return;
      }

      const secret = process.env.CRON_SECRET ?? '';
      // Method per handler: the drain only accepts POST (its GET explains the
      // 401/405 contract), while both crons are GET-only — dispatching them as
      // POST would 405 every scheduled digest/retention run through the router.
      const method = path === '/api/jobs/analyze' ? 'POST' : 'GET';
      const request = new Request(`https://internal${path}`, {
        method,
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      });

      // Await inside runWithWaitUntil so ALS stays live for the drain. The
      // extra ctx.waitUntil is belt-and-suspenders if the scheduler tears
      // down the handler before the promise settles.
      const ran = route(request)
        .then(async (res) => {
          const body = await res.text();
          console.log(`[worker] cron ${cron} ${path} → ${res.status} ${body.slice(0, 500)}`);
        })
        .catch((err) => {
          console.error(`[worker] cron ${cron} ${path} failed: ${(err as Error).message}`);
        });
      ctx.waitUntil(ran);
      await ran;
    });
  },
} satisfies ExportedHandler<Env>;
