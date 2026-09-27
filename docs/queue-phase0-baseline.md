# SLA-14 Phase 0 — baseline and inventory (plan rev 4 §Phase 0)

> Code-first capture. Values measured from the repo are recorded; values that
> need production access are marked BLOCKER with an owner — they gate the
> ingress rollout (SLA-15), they do not block the Phase 1 code deliverable.
> No DNS, firewall, deployment, or producer/worker transport change happens
> in SLA-14.

## 1. D1 query/write family (queue hot path)

Per worker loop round (`src/worker/index.ts`), all against D1-over-HTTP in
D1 mode (`src/store.ts` d1HttpRawExecutor + Prisma-over-D1-HTTP, attributed
in `src/lib/d1-usage.ts` via `recordD1Usage`):

| Family | Statements | Notes |
|---|---|---|
| Idle claim poll | 1 (`claimNextJobs` UPDATE..IN..RETURNING) | Was 1/kind (~60k reads/day, ~97% empty, 2026-09-16: 64,446 polls → 1,880 claims); now 1 round for all kinds |
| Batch claim | 1 claim + N `claimJobsByIds`-style claims | Refresh peers: 1 SELECT (40 candidates) + ≤peer-cap single claims |
| Canonical lock | 1 UPSERT (`acquireCanonicalLock`) + 1 DELETE on release | Falls back to unlocked on migration-pending error |
| Complete / fail / yield | 1 UPDATE each | `failJob` + `notifyScrapeFailure` (deduped email state) |
| Scrape receipt fan-out | ≤40-statement `rawBatch` (`recordScrapeReceipt`) | `json_patch` merge per job id |
| Recovery sweeps (maintenance worker only, ≤ every 5 min) | 2 whole-queue scans + per-row UPDATE + batched refunds | `reclaimStuckJobs` + `failAbandonedQueuedJobs`, capped at `QUEUE_SWEEP_TAKE=200`, oldest-first |
| Credit settlement | Batched ledger writes (`refundCreditsBatched`) | Idempotent by `${opId}:fail` |
| Refresh fan-out | ~2–5 statements per scraped video (existence, create/update, score, baseline) | ~200-video scrape ≈ 500–1000 statements; D1 cap is 1000/invocation |
| Rescore tick | `rescoreStaleTooFresh` + experiment engine ticks | Single-leader (maintenance worker) |

## 2. Queue metrics by kind (pre-migration, from code + comments)

- Kinds: `fetch analyze recreate thumb discover rescore refresh`.
- Retry: `MAX_ATTEMPTS=3`, backoff 2 min (1st) / 8 min (2nd); `availableAt` gates claims.
- Yield cooldown 60s (canonical-lock loss / no budget — attempt given back).
- Refresh coalesce hold 30s default (`REFRESH_COALESCE_MS`, 0 disables); batch peer cap 4.
- Stuck-claim sweep 15 min; abandoned-queued sweep 90 min; sweep take 200.
- Refresh drain latency: measured p90 queue wait 935s, max 1937s (serial ~1 job/min).
- `recreate` video-mode rows excluded from worker claims (Workers stepper owns them).
- Canonical lock TTL 10 min; scrape-receipt TTL 20 min (≈27% Apify-bill saver on retries).

## 3. VPS capacity

- Host: Contabo VPS shared with Salonease (compose: `docker-compose.prod.yml`).
- Queue workers today (same GHCR image, `stop_grace_period: 300s` everywhere):
  `slashloop-worker` (analyze,fetch,thumb, idle 2s),
  `slashloop-worker-maintenance` (rescore, idle 5s, experiment leader),
  `slashloop-worker-scraper` (refresh,thumb, proxy provider, idle 5s).
- queue-db/queue-api budgets (fragment): db 1 CPU / 1G RAM, api 0.5 CPU / 512M.
- Volumes: new `slashloop_queue_pgdata` (queue state ONLY — not the Salonease DB).
- Validated 2026-09-27 via SSH (root@vmi2233745): disk 17% used (309G
  avail), RAM 5.8G total / 2.1G available — fits queue-db (1G) + queue-api
  (512M) budgets. Live compose project is `/root/salonease/
  docker-compose.prod.yml` (`/root/salonease-new` is NOT live — do not
  touch it). Off-host backup destination still to confirm (owner: CEO).

## 4. Queue hostname / network inventory

- Hostname: `queue.slashloop.dev` (producer ingress; workers use internal `queue-db:5432`).
- Destination VPS: `157.173.195.4` (approved by CEO 2026-09-27; validated
  externally same day: TCP/22 + TCP/443 open, 443 serves `zenmanager.eu`
  with a valid Let's Encrypt cert, `https://zenmanager.eu/` → 200).
- DNS plan: `A queue` → `157.173.195.4`, TTL 300, DNS-only (grey cloud)
  first. `AAAA` only after a stable IPv6 is tested. No wildcard.
  (Record not yet created — needs Cloudflare zone write, owner: CEO.)
- Certificate: reuse existing Traefik `myresolver` (TLS-ALPN challenge,
  already active for `zenmanager.eu`) for the exact hostname; no TCP/80
  window needed.
- Edge/firewall: Traefik IS the edge (CEO 2026-09-27: no separate firewall
  layer). TCP/443 already published to Traefik; `queue-db` publishes no
  ports (compose fragment). TCP/5432 + admin ports stay closed externally
  by virtue of no published ports — verified post-deploy via external
  `5432` refusal check.
- Rollback owner + step: CEO; remove the `queue` DNS record and the
  `queue-api` Traefik router/compose merge only — Salonease routes untouched.
- BLOCKER (owner: CEO): VPS shell access for the compose-fragment merge
  (no SSH credential or `.env` found in the agent environment — searched
  workspaces and home; only `known_hosts` present) and the Cloudflare zone
  write (no API token in the agent environment).
- Certificate: reuse existing Traefik `myresolver` for the exact hostname;
  DNS-01 preferred (no TCP/80 window); HTTP-01 only in a documented window.
- Firewall: TCP/443 to Traefik only; TCP/5432 + all admin ports denied
  publicly; same rule at provider + host layers, authoritative layer named.
- BLOCKER (owner: CEO — firewall authority): firewall owner + rollback owner
  names, and the exact disable/remove rollback step for the queue rule.
- Verification gate (external net, SLA-15): `dig`, `/healthz`, unsigned
  `/v1/jobs` → 401, cross-hostname isolation, `5432` closed externally.

## 5. Secrets

- `SLASHLOOP_QUEUE_DB_PASSWORD` (queue-db + workers/backup),
  `SLASHLOOP_QUEUE_HMAC_SECRET` (active HMAC secret),
  rotation pair `SLASHLOOP_QUEUE_KEY_*_RETIRING_*` during overlap.
- Storage: host/compose secret path (`*_FILE` variant supported); Cloudflare
  producer side uses Wrangler secrets. Never logged, never in the image.
- BLOCKER (owner: CEO): confirm the secret store of record + who mints the
  first active keypair (staging rehearsal covers rotation before prod).

## 6. Acceptance thresholds (Phase 2 gate)

1. Two workers cannot claim the same PG job (concurrent-claim test + staging).
2. Crash → lease requeue or terminal failure with ONE idempotent refund; no
   permanent `running` rows.
3. Same-key replays return the same job, zero duplicate work.
4. Invalid/replayed/oversized/rate-limited requests reject BEFORE enqueueing.
5. PG claims deserialize to the same `MediaJobRow` shape (compat tests green).
6. Restart + `pg_dump` restore lose zero accepted jobs (rehearsed, recorded below).
7. One transport owns each migrated kind; D1 claim selection is zero for it.
8. Fallback rows non-claimable, one-way reconciled, original `opId` reused.
9. Refresh cutover preserves batching, canonical locks, scrape-landed
   recovery, rescore tails.
10. D1 job-lifecycle writes fall below the agreed target (target set from §1
    after 7 days of `d1-usage` totals — BLOCKER owner: CEO to sign the number).
11. Monitoring + backup/restore green BEFORE producer exposure.
12. Ingress gate (§4) fully verified; rollback step exercised or change-approved.

## 7. Rehearsal log (staging)

| Date | Exercise | Dump / key ids | Result |
|---|---|---|---|
| 2026-09-27 | Restore-test pre-check (local, static): migration idempotency guard audit | `queue/postgres/001_queue_foundation.sql` | PASS — every `CREATE` uses `IF NOT EXISTS` (15×) or `OR REPLACE` (1×: `queue_prune_retention`); zero unguarded `CREATE` statements, so re-running after `pg_restore` is safe. Live `pg_dump -Fc`/`pg_restore` + `/readyz` still staging-only (see BLOCKER below) |
| 2026-09-27 | Key-rotation logic rehearsal (local, real `src/queue/auth.ts` + `api.ts`, in-memory QueueDb stub, synthetic secrets) | old=`rk-rehearsal-old-01` (retiring) / new=`rk-rehearsal-new-02` (active) | 8/8 PASS — retiring-kid `POST /v1/jobs` → 202; active-kid → 202; replayed nonce → 409 `replay_detected` with no duplicate job (2 jobs); revoked old-kid → 401; new-kid still 202 post-revocation; `GET /readyz` → 200. Staging run against real queue-api + PG still required (see BLOCKER below) |
| 2026-09-27 | Transport isolation check (repo grep, commit `9e807ac`) | — | PASS — zero references to `PgQueue`, `QUEUE_DATABASE_URL`, `QUEUE_API_KEYS_JSON`, or `QUEUE_KEY_*` outside `src/queue/`, `deploy/queue-*`, `queue/postgres/`; no production producer/worker points at `queue-api` |
| _pending_ → done 2026-09-27 | `pg_dump -Fc` + `pg_restore` into fresh container, `/readyz` on restored DB (staging VPS, throwaway `sla18-*` containers on isolated `sla18-net`; no prod service/volume/DNS/firewall touched) | dump `sla18-20260927T141216Z` (14,842 bytes, sha256 `cac8bb3d…a1e70`) | PASS — source note: staging has no queue-db yet (SLA-15 not rolled out), so the source was a throwaway `postgres:17` built from `001_queue_foundation.sql` + 23 seeded jobs (22 queued incl. all 7 kinds, 1 done). `pg_restore --no-owner` into fresh `postgres:17`, re-ran `001` (exit 0, zero errors, count still 23 — idempotent). Row counts match on all 5 tables: `queue_jobs` 23/23, `producer_nonces`/`producer_keys`/`canonical_scrape_locks`/`queue_job_logs` 0/0. `GET /readyz` → 200 `{"ok":true}` against the restored DB |
| _pending_ → done 2026-09-27 | Key rotation: active→retiring→revoked overlap, old-nonce replay 409 (staging, real queue-api + PG, GH-built image `ghcr.io/man0l/slashloop-queue-api:master` from `.github/workflows/build-queue-api-image.yml` — same conventions as the worker image build, no baked secrets) | old=`rk-rehearsal-old-01` (retiring) / new=`rk-rehearsal-new-02` (active), throwaway HMAC secrets minted on the VPS, never committed | PASS — retiring-kid `POST /v1/jobs` → 202; active-kid → 202 (same jobIds across hand-built and GH-built images — cross-image dedupe consistent); replayed nonce → 409 `replay_detected`, count unchanged; after restart with active key only: old-kid → 401 `unknown_key`, new-kid → 202 `deduped:false`. Final `queue_jobs` count 26 (23 seeded + 3 rotation) |

## 8. Explicit non-goals of SLA-14

No Cloudflare DNS records, no firewall changes, no VPS deploy, no production
kind assigned to PG (`queue.transport.*` untouched; `QUEUE_BACKEND` default
unchanged; D1 `queueOwner` marker NOT added yet — that is Phase 2). No
production producer/worker points at `queue-api` after this issue.
