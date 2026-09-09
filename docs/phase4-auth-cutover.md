# Phase 4 auth cutover: Supabase → native Google identity

Live state at write time: D1 `slashloop` is the live DB. `User`
(id/email/createdAt/updatedAt, + `googleSub` from `0003`) holds the ~6
migrated Supabase users; `Workspace.ownerId` holds Supabase subs (~11
workspaces). Supabase is untouched by everything below until the deletion
checklist (§6), which is explicitly out of scope.

## 1. End state

```
browser ──/authorize──▶ Worker ──OAuth──▶ Google ──callback──▶ src/cf/google.ts
                                                        │ (google agent owns)
                                                        ▼
                                              account-link.ensureNativeUser()
                                              1st login: User.googleSub +=
                                                 `google:<sub>`, Workspace.ownerId
                                                 supa-sub → `google:<sub>` (atomic)
                                                        │
MCP client ──Bearer (provider token)──▶ /mcp ──runWithUser(`google:<sub>`)
                                              ──requireWorkspace() (unchanged)
```

- Identity source of truth: Google (`sub`), namespaced as `google:<sub>`.
- `User.id` for migrated rows stays the Supabase sub forever (stable PK);
  `User.googleSub` is the link. Natively created rows use `google:<sub>`
  for both. `Workspace.ownerId` moves to `google:<sub>` at first login.
- `ensureNativeUser()` never creates workspaces (that stays in
  `requireWorkspace()`) and never touches Supabase.

## 2. Dual-accept window

`ACCEPT_SUPABASE_JWT` (planned flag, enforced at the two Supabase verify
call sites: `resolveExternalToken` in `src/cf/oauth.ts` and `POST` in
`src/cf/mcp.ts`):

- `=1` (window open): accept provider-issued (Google) tokens AND Supabase
  JWTs. Unlinked users keep working exactly as today — their rows are only
  touched the moment THEY log in with Google.
- `=0` (window closed): Google tokens only; Supabase JWTs get the existing
  401 `invalid_token` shape.

Semantics note: after a user links, their workspaces live under
`google:<sub>`. Their OLD Supabase JWT still authenticates during the
window but resolves to no workspace (a fresh empty one would auto-create
on tool use) — linked users must use Google login from then on. Verify
"old session still valid" (§4) with an UNLINKED account only.

## 3. Cutover sequence

1. Apply the link column: `wrangler d1 migrations apply slashloop --remote`
   (`prisma/d1-migrations/0003_user_google_sub.sql`). Backfill-free:
   existing rows start `googleSub = NULL`. Confirm:
   `SELECT count(*) FROM User WHERE googleSub IS NULL;` → 6.
2. Google Cloud console: create/confirm the OAuth client, register the
   callback redirect URI the google agent's module serves
   (`<origin>/oauth/google/callback` unless `src/cf/google.ts` says
   otherwise — confirm the exact path with that agent before saving).
3. `wrangler secret put GOOGLE_CLIENT_ID`, `wrangler secret put
   GOOGLE_CLIENT_SECRET` (exact names per `src/cf/google.ts`; confirm with
   the google agent), plus `ACCEPT_SUPABASE_JWT=1`.
4. Deploy the Worker. Smoke: `GET /health` 200; existing Supabase MCP
   session still lists tools (window open).
5. Per-user first-login linking: each of the ~6 users logs in with Google
   once. Each login atomically attaches `googleSub` + moves ALL of that
   user's `Workspace.ownerId` values (a multi-workspace owner moves
   together — never split, never duplicated).
6. Verify per user: `SELECT id, email, googleSub FROM User;` — every row
   has `googleSub` set; `SELECT ownerId, count(*) FROM Workspace GROUP BY
   ownerId;` — no Supabase-sub `ownerId` remains, total still 11; each user
   sees all their sources/videos/credits in the app.
7. Verification e2e: (a) fresh Google login → `whoami`/usage resolves to
   the moved workspaces; (b) an UNLINKED user's Supabase JWT still works
   during the window (do (b) before that user links).
8. Close the window: set `ACCEPT_SUPABASE_JWT=0`, redeploy, confirm a
   Supabase JWT now gets 401 `invalid_token` and Google sessions are
   unaffected. Soak before §6.

## 4. Rollback (window open or after close — Supabase is untouched)

Credential rollback is a flag flip: set `ACCEPT_SUPABASE_JWT=1` and
redeploy — Supabase JWTs authenticate again immediately.

Data rollback is needed for already-linked users, because their
workspaces moved to `google:<sub>` and an old-sub session won't resolve
them. Reverse the transfer per linked row (D1, one user at a time):

```sql
UPDATE "Workspace" SET "ownerId" = '<supabase-sub>', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "ownerId" = '<google-sub>';
UPDATE "User" SET "googleSub" = NULL, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = '<supabase-sub>';
```

(`<supabase-sub>` = `User.id`, `<google-sub>` = `User.googleSub` for that
row.) Unlinked users need nothing — their rows were never touched.

## 5. What is deliberately NOT changing here

Runtime request paths are frozen: `api/*`, `src/tools/*`, `src/worker/*`,
`src/cf/worker.ts`, `src/cf/mcp.ts`, `wrangler.jsonc`, `package.json`.
The `User` model has no Postgres table (rows are derived from `auth.users`
at D1-copy time), so no `supabase/migrations/` change ships with this —
`schema.prisma`/`schema.sqlite.prisma` carry the client type only.

## 6. Supabase DELETION checklist — OUT OF SCOPE, gated on user approval

Do NOT execute any of this without explicit user sign-off. Preconditions:

- [ ] All 6 `User` rows have `googleSub` set; no `Workspace.ownerId` is a
      Supabase sub; count is still 11.
- [ ] `ACCEPT_SUPABASE_JWT=0` has soaked (suggested: ≥7 days) with zero
      auth-related incidents.
- [ ] Fresh D1 backup/export taken and verified readable.
- [ ] Supabase project first DISABLED (not deleted); wait one full billing/
      cron cycle; confirm nothing (VPS, scripts, dashboards) still reads it.
- [ ] Only then: delete the Supabase project, remove `SUPABASE_URL` /
      related secrets, and retire the `verifySupabaseJwt` call sites
      (`src/cf/oauth.ts`, `src/cf/mcp.ts`) plus `remote/auth.ts` in a
      follow-up change.
