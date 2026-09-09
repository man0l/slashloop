# Cutover verification matrix

Run top to bottom on the **Worker domain** (preview first, then custom domain).
Any hard-gate failure → rollback per `docs/cf-full-backend-plan.md` §5.
`CRON_SECRET` bearer is required for the job/cron endpoints; MCP endpoints need a
Supabase JWT (step-1 auth).

## 1. Liveness

- [ ] `GET /health` → 200 `{ ok: true, service: 'slashloop', … }` (preview + custom domain).
- [ ] `GET /` → same health payload (vercel.json `/` → health port).

## 2. Well-known metadata

- [ ] `GET /.well-known/oauth-protected-resource` → 200, `resource` = `<origin>/mcp`,
      `authorization_servers` = [`<SUPABASE_URL>/auth/v1`] (step 1; cf. `remote/mcp-server.ts`).
- [ ] Origin rule: `PUBLIC_URL` wins, else request origin (same rule as `api/mcp.ts` / `src/cf/router.ts`).

## 3. 401 semantics (MCP)

- [ ] `POST /mcp` with no token → 401 `{ error: 'invalid_token' }` + `WWW-Authenticate`
      containing `resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- [ ] `POST /mcp` with bad token → same 401 (no 500, no handshake hang).
- [ ] `GET /mcp` → 405 (`Allow: POST`).

## 4. MCP handshake + whoami + tenant isolation

- [ ] MCP Inspector against `<origin>/mcp` with a real JWT: `initialize` → tools list (55).
- [ ] `whoami`/usage call resolves to the JWT `sub` workspace (`get_usage` returns caller data).
- [ ] Tenant isolation: user A's `list_sources` shows no rows owned by user B
      (JWT `sub` scoping via `runWithUser` → `requireWorkspace()`).

## 5. Queue: claim-exactly-once + sweeps

- [ ] `POST /api/jobs/analyze` without bearer → 401; with `CRON_SECRET` → 200 with
      `{ reclaimed, rescoredStale, processed, … }` shape.
- [ ] Enqueue one `analyze_video` (gemini-text or small native): exactly one claim,
      no double-processing with the VPS worker stopped; stuck-claim reclaim path sane
      (`reclaimStuckJobs` runs before claim).
- [ ] With VPS on D1 creds: Worker drain + VPS do not double-claim (VPS owns long
      refresh/rescore; `WORKER_URL`/`WORKER_ACTIVE` gate respected).
- [ ] `rescoreStaleTooFresh` runs in exactly one place (Worker drain when VPS inactive,
      else `vps_worker_owns_this`).

## 6. Stripe test-mode e2e

- [ ] `STRIPE_MODE=test`: create test Checkout → webhook to
      `<worker-domain>/api/stripe/webhook` → signature verifies with
      `STRIPE_TEST_WEBHOOK_SECRET` → credits granted (ledger row), `get_usage` reflects it.
- [ ] Duplicate delivery of the same event id → idempotent (single grant).
- [ ] Only then repeat the webhook-URL flip for live.

## 7. Media round-trip + retention

- [ ] Thumb/MP4 persist path writes via R2 bindings; gallery/feed renders without
      expired CDN URLs (`/thumbs/*`, `/media/*` on the Worker).
- [ ] Retention sweep dry-run scoping correct (per-workspace days, plan caps,
      `RETENTION_DAYS_MAX=90` ceiling); no sweep deletes outside its workspace.
      Live `0 3` trigger stays off until this passes.

## 8. Digest dry-run + cron re-enable order

- [ ] `POST /api/cron/digest` with `CRON_SECRET` builds + stores digest; `get_digest`
      serves it; email sends only with `RESEND_API_KEY` set.
- [ ] Re-enable order: `*/1` drain → observe one cycle → `0 3` retention →
      `0 9 * * 1` digest. Then unschedule pg_cron `drain-analyze-jobs`, then remove
      Vercel Crons (`vercel.json` + dashboard).
- [ ] Date binding sanity: D1 ISO-text dates parse under `julianday()` (migration
      `--verify` already asserts this; re-check after final copy).

## 9. Rollback trigger

- [ ] Any hard gate above fails, or first-hour error rate / credit-spend anomaly →
      roll back (clients → Vercel, webhook → `https://mcp.slashloop.dev/api/stripe/webhook`,
      VPS → `DATABASE_URL`, Vercel Crons on, Worker crons off).
- [ ] Rollback is lossy for post-flip D1 writes (accepted; keep the soak short).
