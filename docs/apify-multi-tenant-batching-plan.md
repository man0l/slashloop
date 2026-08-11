# Multi-tenant Apify batching plan

**Goal:** One Apify actor run can serve many workspaces (tenants) that track the same TikTok creator/hashtag/keyword, so we pay **once per unique query**, not once per tenant.

**Status:** Phase A implemented and **hardened** (see §9 and §14). Incremental "new outliers" refresh is in `src/lib/refresh-policy.ts`. An audit (§12) found 15 gaps in the first cut; **12 are now fixed**, and the remainder are Phase B/C design work tracked in §12.

**Merged with `master` @ `0a32167`.** The queue no longer drains on Vercel: refresh jobs run on a long-lived VPS worker (`src/worker/index.ts`, `WORKER_KINDS`). Batching is built for that topology — a claim-side coalescing window and a cross-container lease, not a per-invocation grouping. §13 covers feasibility, §14 records exactly what shipped.

---

## 1. Why batching pays off

| Today | After batching |
|---|---|
| 10 workspaces track `@buildingwithliz_` → **10** actor starts + 10× results | **1** actor start + 1× results, fan-out into 10 workspaces |
| PPE: `$0.001` start + `$0.003`/result each | Same PPE **once**, split or absorbed by platform COGS |

Observed: ~$7 of tiktok-scraper spend in 7 days, many runs are the same handles/hashtags re-pulled per workspace and re-pulled when already known.

Batching does **not** remove per-workspace product isolation (credits, retention, gallery). It only de-duplicates the **network scrape**.

---

## 2. Concepts

### Tenant model (already in product)

- **User** = Supabase auth `ownerId`
- **Workspace** = billing + data boundary (`Workspace`, credits, plan, retention)
- **Source** = per-workspace track of `(platform, sourceType, query)`

### New shared layer (proposed)

| Entity | Role |
|---|---|
| **CanonicalQuery** | Global key: `platform + sourceType + normalizedQuery` (strip `@`/`#`, lower-case) |
| **ScrapeLease / ScrapeBatch** | One Apify run for a CanonicalQuery at time T, with input plan (limit, postedAfter) |
| **ScrapeResult cache** | Normalized video payloads (or externalIds + stats) from that run, short TTL |
| **WorkspaceSource link** | Existing `Source` rows subscribe to a CanonicalQuery |

Normalization must match `SuggestionDismissal` / create_source rules so the same handle never appears as two keys. **This invariant is currently violated — see gap G8.** `src/lib/canonical-query.ts` is the one implementation that new code must use.

---

## 3. Architecture (phased)

### 3.0 Execution topology (as of `master` @ `0a32167`)

Batching assumptions changed when the queue moved off Vercel. Current shape:

| Runner | Claims | Budget | Runs `rescoreStaleTooFresh` |
|---|---|---|---|
| VPS video worker (`WORKER_KINDS=analyze,fetch`) | analyze, fetch | none (long-lived loop) | no |
| VPS maintenance worker (`WORKER_KINDS=refresh,rescore`) | **refresh**, rescore | none | yes, every `WORKER_RESCORE_EVERY` iterations |
| Vercel `POST /api/jobs/analyze` | **nothing** while `WORKER_URL` is set | 45s reserve | **yes, every minute** |

Both runners call the same `processClaimedJob`, so batching is implemented once and applies to both. Three consequences for this plan:

1. **The coalescing window collapsed (G22).** Phase A was designed against a per-minute Vercel drain, where a minute of enqueues piled up and one drain could group them. The VPS loop idles `WORKER_IDLE_MS` (default 3s) and claims a refresh the moment it appears, so by the time peers are queued the leader has usually already scraped. In-process coalescing now only fires on a genuine backlog (a `refresh_due_sources` burst enqueuing many rows at once). **This is the strongest argument for moving to Phase B**, whose TTL cache coalesces across *time* rather than within one claim.
2. **Multi-instance is real, not hypothetical.** `WORKER_KINDS` exists precisely so several containers run from one image. Two maintenance workers can each lead a batch for the *same* canonical query at the same time: `claimNextJob`/`claimJobsByIds` use `FOR UPDATE SKIP LOCKED` so no *job* is double-claimed, but nothing stops two concurrent Apify runs for the same query. The DB lease (Phase B) and the unique index (G7) are now prerequisites, not niceties.
3. **The budget guard is mostly dead code on the real path.** `deadlineMs` is undefined on the VPS worker, so `peerCap` is the full `REFRESH_BATCH_PEER_CAP` and no refresh is ever requeued for lack of budget. Fan-out timeouts are now a Vercel-fallback-only concern (`WORKER_URL` unset).

### Phase A — coalesced batching on the shared job switch ✅ shipped

**When:** the shared job switch `processClaimedJob` (`src/worker/process-job.ts`) handles a `refresh` job — on the VPS maintenance worker in production, on Vercel only when no VPS worker is active.

1. **Hold**: a queued refresh is not claimable until it is `REFRESH_COALESCE_MS` old (default 30s), so peers for the same query accumulate instead of each being claimed 3s after enqueue. Enforced inside `claimNextJob`, so every runner obeys it.
2. **Lease**: the leader takes `CanonicalScrapeLock` for `canonicalKey(platform, sourceType, query)`. A second container that wants the same query requeues instead of starting a second Apify run.
3. **Claim peers**: queued refresh jobs with the same canonical key, up to `REFRESH_BATCH_PEER_CAP` (env-tunable), skipping expired deadlines and deduping by `sourceId`. A time-boxed caller scales the cap down by `REFRESH_FANOUT_MS_PER_PEER`.
4. **Union plan**: `limit = max(plan.limit)`; `postedAfter = min(watermarks)` for creators, and only when *every* member has one (any bootstrap member widens to no filter).
5. **One** `scrapeSource` call, authorised against `PLATFORM_WORKSPACE_ID` when set so no tenant's spend cap pays for other tenants.
6. **Fan-out**: per subscriber, `applyScrapeItems` re-applies that source's own `postedAfter`, bulk-checks existing videos in one query, and treats a unique-violation as an update. Credits settle per workspace on **new videos only**; Apify cents are split pro-rata across `RefreshRun` rows plus a `scrape_share` `UsageLog` row each.
7. **Settle**: each job completes or fails independently; a pre-auth is refunded only when its job terminally fails.

**Pros:** No result cache to invalidate; one code path for both runners; safe across containers.
**Cons:** Coalescing is still bounded by the hold window — two workspaces refreshing the same creator 10 minutes apart still pay twice. That is what Phase B's TTL cache fixes, and it is the remaining structural saving.

### Phase B — DB-backed scrape lease (correct multi-instance)

```
CanonicalScrape
  id, platform, sourceType, queryNorm
  status: queued | running | done | failed
  planJson: { limit, postedAfter }
  apifyRunId, costCents
  resultJson or resultDatasetRef
  startedAt, finishedAt, expiresAt

CanonicalScrapeSubscriber
  scrapeId, workspaceId, sourceId, mediaJobId
  status
```

1. `enqueueRefreshJob` → also upsert "want scrape for canonical key".
2. Leader worker takes lease (`UPDATE … WHERE status=queued … FOR UPDATE SKIP LOCKED`).
3. Runs Apify once, writes results.
4. Fan-out workers (or same worker) apply results per subscriber and settle credits.

**TTL:** Cache results 15–60 minutes so a second workspace refreshing the same creator within the window **reuses** without Apify.

**Why this is now step 1, not step 5.** With refresh running on a continuously-draining VPS worker (§3.0), in-process coalescing almost never has peers to coalesce, and two maintenance containers can scrape the same query concurrently. The lease does both jobs Phase A cannot: it de-duplicates *across time* (TTL reuse, so a workspace refreshing `@foo` 20 minutes after another pays nothing) and *across processes* (one lease holder per canonical query). On the current topology Phase B is where essentially all of the savings live.

**Cache-hit rule (was undefined — gap G11).** A cached scrape may serve a new subscriber **only if its plan is a superset** of what that subscriber needs:

```
reusable = cached.limit >= need.limit
        && (cached.postedAfter == null || (need.postedAfter != null && cached.postedAfter <= need.postedAfter))
        && cached.finishedAt > now - TTL
```

A cached `limit=5, postedAfter=yesterday` run must **not** serve a bootstrap subscriber needing `limit=20, postedAfter=null`; that subscriber re-scrapes and its (wider) result becomes the new cache entry.

**Lease recovery.** `CanonicalScrape` needs `attempts` and a stuck-lease sweep on the same cadence as `reclaimStuckJobs` (`running` older than `STUCK_AFTER_MINUTES` → `queued`, or `failed` past `MAX_ATTEMPTS`). Without it a killed leader blocks every subscriber of that query until TTL.

**Single source of truth for pre-auth.** Credits stay on `MediaJob.opId` / `MediaJob.preAuthCredits`. `CanonicalScrapeSubscriber` must **not** carry its own `creditsPreAuth` copy — `reclaimStuckJobs` reads the MediaJob and two copies would drift (gap G13).

**Cache retention.** `CanonicalScrape.resultJson` is scraped public metadata held outside any workspace. It needs: an explicit sweeper (delete past `expiresAt`), exclusion from workspace retention counting, and a service-role-only RLS policy — no workspace-scoped read path. Ship the sweeper in the same migration as the table (gap G12).

### Phase C — Scheduled global crawl (max savings)

- Cron builds the set of **distinct** active canonical queries across all workspaces with `refreshSchedule in (daily, weekly)` due now.
- One batched Apify strategy:
  - **Creators:** pack up to K profiles per actor input (`profiles: [a,b,c,…]`) with `resultsPerPage` = incremental limit. Attribution on fan-out is by `creatorHandle`, which every normalized item carries.
  - **Hashtags/keywords:** **do not pack** until attribution is solved (gap G15). A packed hashtag run returns a flat item list with nothing saying which hashtag matched, so results cannot be fanned out correctly. Either run one hashtag per actor call, or add a matcher (caption `#tag` scan) and accept its false-negative rate explicitly.
- Fan-out into every workspace source linked to those queries.
- **Solvency gate (gap G16):** only crawl a canonical query that has ≥1 subscriber whose workspace can cover the pre-auth *at crawl time*. Otherwise the platform pays Apify for results nobody can be billed for.
- **Authorisation:** the crawl runs against the platform spend cap (§4), never a tenant's.

This is the largest saving for "everyone tracks #buildinpublic".

---

## 4. Credit & billing rules (non-negotiable)

| Rule | Why | Status |
|---|---|---|
| Debit **per workspace**, never share a ledger | Multi-tenant isolation | ✅ |
| Charge for **value received**, not raw Apify line item | Workspace A may already hold 4/5 results → charge less than B | ✅ G9 fixed |
| `credits = ceil(1.5 × newVideos)` for incremental | Aligns with "new outliers only" | ✅ `settleAndApply` bills `newVideos` only |
| Platform absorbs true Apify COGS | Or mark up and track margin in `UsageLog` | ✅ `PLATFORM_WORKSPACE_ID` + pro-rata `scrape_share` rows |
| Cap / insufficient credits: **skip that subscriber**, do not fail the whole batch | One broke tenant must not block others | ✅ credits per member; the shared scrape no longer draws on a tenant's cap |
| Idempotent `opId` per MediaJob | Keep existing retry safety | ✅ refund deferred to the terminal branch, so a retry is still paid for |

**Do not** bill every subscriber the full Apify result count if they already had those videos — that recreates the waste we just fixed.

### Apify COGS attribution ✅ shipped (resolved G1/G2)

The first cut (`attributeApifyCost: i === 0`) made one arbitrary tenant carry the whole batch, both in `RefreshRun.costCents` and — worse — in their monthly spend cap. Now:

1. A **platform workspace** (env `PLATFORM_WORKSPACE_ID`) owns shared scrapes: when a batch has more than one member and the env is set, `scrapeSource` asserts and records the cap against it, not against `ready[0]`. Unset = previous behaviour, so this is opt-in per environment.
2. `RefreshRun.costCents` = `floor(scrapeCostCents / batchSize)` per source, remainder to the leader, so per-source cost analytics stay meaningful — §10's savings metric is computed from these rows.
3. One `UsageLog` row per subscriber with the pro-rata share, under kind `scrape_share`. Deliberately **not** the `scrape` kind the cap sums over: the real spend was recorded once against the scrape owner, and this row exists so a workspace's true COGS can be reported without being billed twice.

---

## 5. Data isolation

- Videos stay **owned by `Source` / workspace** (current model). Fan-out **copies or links**:
  - **Copy (recommended v1):** insert/update `Video` rows per sourceId (today's shape). Simple RLS, retention, scoring.
  - **Link (v2):** global `GlobalVideo` + `WorkspaceVideo` join — less storage, more migration pain.
- Never write another workspace's `sourceId`.
- Thumbnails: ingest per workspace or shared thumb key with refcount (later).

**Constraint ✅ shipped (G7).** `supabase/migrations/20260812090000_video_unique_per_source.sql` collapses existing duplicates (keeping the oldest row, which owns the analyses/scores/thumbs) and adds:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "Video_sourceId_platform_externalId_key"
  ON "Video" ("sourceId", "platform", "externalId");
```

`applyScrapeItems` now bulk-loads existing rows for the page in one query and catches `P2002` as "another worker applied the same shared scrape first" — treating it as an update, never a failure. That is what makes fan-out idempotent, and it is the prerequisite for Phase B replaying a cached result.

Scoring (`batchScoreVideos`) stays per-source; baselines by `creatorHandle+platform` are already global and benefit everyone (existing behavior).

---

## 6. Interaction with "new outliers only" policy

Already implemented:

- Bootstrap ≤20, incremental ≤5, creator `postedAfter` watermark.

Batching should:

1. Resolve plan **per source**, then **merge** for the Apify call (max limit, min postedAfter).
2. Apply **per source** filters again on fan-out (drop items older than that source's watermark if we widened the window for a sibling). ✅ implemented.
3. Keep baseline rescrapes (`sourceTypeOverride`) **out of** cross-tenant batches — different purpose (stats for too_fresh). ✅ `runRefresh` routes those to `runRefreshSolo`.

**✅ shipped (G10).** `refresh_due_sources` now resolves the real plan per source (`resolveRefreshPlan`) and quotes/pre-authorises from `plannedLimit`, not the stored `videoLimit`. A legacy 50-video source no longer reserves 75 credits for a run that will spend 8, and the scheduler's credit ceiling stops refusing sources the budget can easily cover. `refreshSourceForWorkspace` already did this; the two paths now agree.

**Not yet sized:** `rescoreStaleTooFresh` runs an unbatched baseline scrape on every drain. It is deliberately excluded from batching, but it is a recurring Apify cost that the savings metric in §10 must report separately rather than hide.

**✅ shipped (G24).** `api/jobs/analyze.ts` now computes `vpsActive` before the sweep and skips `rescoreStaleTooFresh()` entirely when a VPS worker is deployed, reporting `rescoredStale.skipped = 'vps_worker_owns_this'`. Previously both Vercel (every minute, via pg_cron) and the maintenance worker (every `WORKER_RESCORE_EVERY` iterations) bought the same baseline top-up scrapes.

---

## 7. API / job surface changes

| Component | Change |
|---|---|
| `enqueueRefreshJob` | Pre-auth from the resolved plan, not raw `videoLimit` ✅ |
| `runRefresh` | Split into `scrapeCanonical()` + `applyScrapeToSource()` ✅ (`runBatchedRefresh` + `applyScrapeItems`) |
| `claimNextJob` | Holds queued refresh jobs for `REFRESH_COALESCE_MS` so peers can accumulate ✅ |
| `processClaimedJob` | Lease → claim peers → one scrape → per-subscriber settle ✅ (both runners share it; peer cap scales with `deadlineMs` when the caller is time-boxed) |
| `src/worker/index.ts` | No change needed — batching rides inside `processClaimedJob` |
| `api/jobs/analyze.ts` | Skips `rescoreStaleTooFresh()` when a VPS worker is active ✅ |
| `refresh_source` tool | Unchanged UX; a refresh now waits out the coalescing window before starting |
| Observability | One structured batch log line + pro-rata `RefreshRun.costCents` + `scrape_share` `UsageLog` rows ✅ |
| Kill switch | `REFRESH_BATCHING_ENABLED` (0 also drops the coalescing hold) + tunable `REFRESH_BATCH_PEER_CAP` ✅ |
| Connection pool | Fan-out bulk-loads existing videos per source instead of one `findFirst` per item ✅ |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| One tenant's huge `videoLimit` inflates batch | Cap merge with `REFRESH_INCREMENTAL_CAP` / bootstrap cap; ignore pathological overrides in scheduled path |
| Continuous VPS drain leaves nothing to coalesce | ✅ `REFRESH_COALESCE_MS` hold inside `claimNextJob` |
| Two maintenance containers scrape the same query at once | ✅ `CanonicalScrapeLock` TTL lease; the loser requeues |
| Fan-out saturates a 4-connection Prisma pool | ✅ one bulk `findMany` per source per page instead of per-item lookups |
| **Coalescing hold delays a user-visible refresh** | The hold is 30s by default and refresh is already a background operation (`await_job` polls for minutes). Set `REFRESH_COALESCE_MS=0` to opt out; `REFRESH_BATCHING_ENABLED=0` drops it automatically |
| **Lease held by a container that was SIGKILLed** | TTL (`CANONICAL_LOCK_TTL_MS`, 10 min) expires the lease and the next worker steals it in the same UPSERT |
| **Leader's spend cap absorbs the whole batch** | Platform workspace for shared scrapes (§4); until then, bounded by `REFRESH_BATCH_PEER_CAP` |
| **Leader's cap breach aborts solvent peers** | Check cap against the scrape-owning workspace only; refuse the member, not the batch |
| PII / cross-tenant leakage | Only share public TikTok metadata; no workspace names in shared rows |
| Partial fan-out failure | Mark subscriber failed + refund that opId; scrape still done. **Currently the catch-all fails every job in the batch, including ones already applied and billed (G5).** |
| **Fan-out exceeds the invocation budget** | Budget-scale the peer cap (`REFRESH_FANOUT_MS_PER_PEER`), bound thumbnail ingest across the whole batch, not per source |
| **Retry after a refunded pre-auth is free** | `${opId}:fail` refund + requeue means the retry replays the idempotent debit and charges nothing (G4). Refund only on terminal failure, as the analyze path already does |
| Clockworks multi-profile rate limits | Bound profiles per run (e.g. 10); chunk |
| Cache serves stale stats | Short TTL; too_fresh path keeps dedicated small rescrape |

---

## 9. Implementation order

1. **Done:** New-outlier policy (`refresh-policy.ts` + apify date filter + lower limits).
2. **Done:** Refactor `runRefresh` → `applyScrapeItems` + `runBatchedRefresh` (`src/lib/refresh.ts`).
3. **Done — Phase A:** Peer claim by canonical key (`claimRefreshPeersForCanonical` in `src/lib/jobs.ts`, wired in `src/worker/process-job.ts` so both runners share it). One Apify scrape, fan-out persist/score, per-workspace credits. Video lookup scoped to `sourceId`. Peer count scales with the caller's remaining budget.
4. **Done — correctness + topology fixes (§14):** G4, G5, G6, G7, G9, G10, G20, G22, G23, G24, G25, and the code half of G26.
5. **Next — Phase B:** promote `CanonicalScrapeLock` to a full `CanonicalScrape` row (planJson, apifyRunId, resultJson, expiresAt) so a result can be **reused** within its TTL under the superset rule in §3, not merely de-duplicated at claim time. The lease, the lock table and the idempotent apply are already in place, so this is additive.
6. **Then:** G8 normalization (needs a data migration for stored `Source.query` values), then Phase C.
7. **Phase C:** Scheduled distinct-query crawl + creator packing (hashtag packing blocked on attribution, G15).
8. Metrics dashboard: Apify $ / distinct query / day vs jobs / day (savings ratio).

---

## 10. Success metrics

- Apify `$ / active source / week` ↓ ≥ 40% after Phase A+B on shared queries
- `% refresh runs with newVideos=0` ↓ (less pure waste)
- No cross-workspace video leakage
- Credit ledger still balances per workspace under concurrent batch fan-out

These are only measurable once §4's pro-rata `RefreshRun.costCents` lands — with `costCents = 0` on every peer row, per-source Apify cost is structurally wrong.

**Leakage audit query** (was "audit query" with no query):

```sql
-- Any Video whose Source belongs to a different workspace than the
-- RefreshRun/MediaJob that created it. Must return zero rows.
SELECT v.id, v."sourceId", s."workspaceId" AS source_ws, mj."workspaceId" AS job_ws
  FROM "Video" v
  JOIN "Source" s ON s.id = v."sourceId"
  JOIN "MediaJob" mj ON mj."sourceId" = v."sourceId"
 WHERE mj.kind = 'refresh'
   AND mj."workspaceId" <> s."workspaceId";
```

Plus a duplicate check that must return zero once G7 lands:

```sql
SELECT "sourceId", platform, "externalId", count(*)
  FROM "Video" GROUP BY 1,2,3 HAVING count(*) > 1;
```

---

## 11. Out of scope (for this plan)

- Changing Stripe plans or credit prices
- Reels/Shorts scrapers
- Global video CDN shared across tenants (nice later)

---

## 12. Audit — open gaps in shipped Phase A

Findings from reading `src/lib/refresh.ts`, `refresh-policy.ts`, `canonical-query.ts`, `jobs.ts`, `worker/process-job.ts`, `worker/index.ts`, `api/jobs/analyze.ts`, `spend-cap.ts`, `credits.ts`, `db.ts`, `prisma/schema.prisma` at `master` @ `0a32167`. Ordered by money impact.

| # | Gap | Where | Status |
|---|---|---|---|
| **G1** | Batch scrape ran as `ready[0].workspaceId`, so the whole batch hit the leader's spend cap; peers showed $0 Apify spend forever | `runBatchedRefresh` → `scrapeSource` | ✅ **fixed** — `PLATFORM_WORKSPACE_ID` owns shared scrapes |
| **G2** | Only the leader got `attributeApifyCost`; peers wrote `RefreshRun.costCents = 0` | `settleAndApply` | ✅ **fixed** — pro-rata cents per source + `scrape_share` UsageLog |
| **G3** | The real `assertApifyCap` inside the scrape ran on the leader only; a leader breach failed **every** member | `runBatchedRefresh` | ✅ **fixed** — the shared scrape no longer draws on a tenant's cap |
| **G4** | Failure refunded the pre-auth under `${opId}:fail`, then `failJob` requeued; the retry replayed the idempotent debit and charged nothing | `refresh.ts` + `processClaimedJob` | ✅ **fixed** — `deferRefund`, refund only on the terminal branch |
| **G5** | The fan-out `catch` failed **all** `batchJobs`, including members already applied and billed | `processClaimedJob` | ✅ **fixed** — per-subscriber settle; members whose videos landed are completed |
| **G6** | Peer claim ignored `deadlineAt`; two jobs for one source could both join a batch | `claimRefreshPeersForCanonical` | ✅ **fixed** — deadline filter + dedupe by `sourceId` |
| **G7** | No unique index on `Video(sourceId, platform, externalId)`; dedupe was read-then-write | `prisma/schema.prisma` | ✅ **fixed** — migration + `P2002` treated as an update |
| **G8** | Three normalizations: `canonical-query.ts`, a private copy in `suggestions.ts`, and **none** in `create_source` (the `Source` unique key is on the raw query) | multiple | ⛔ **open** — needs a data migration to normalize stored queries, not just a code change |
| **G9** | Billing was `newVideos + updatedVideos`; §4 says `newVideos` | `settleAndApply` | ✅ **fixed** — new videos only |
| **G10** | Pre-auth used `1.5 × videoLimit`, ignoring the plan the worker applies | `tools/schedule.ts` | ✅ **fixed** — quotes and pre-auths from `plannedLimit` |

### Topology gaps (new — introduced by the move to VPS workers)

| # | Gap | Where | Impact |
|---|---|---|---|
| **G22** ✅ | The VPS loop claimed a refresh within `WORKER_IDLE_MS` (3s) of enqueue, so peers were rarely queued yet | `claimNextJob` | **Fixed:** `REFRESH_COALESCE_MS` (default 30s) holds a queued refresh before any worker may claim it |
| **G23** ✅ | `WORKER_KINDS` allows N maintenance containers; `SKIP LOCKED` stops double-*claiming a job*, not two containers scraping the **same canonical query** | `worker/index.ts` | **Fixed:** `CanonicalScrapeLock` TTL lease; the loser requeues. Not `pg_advisory_lock` — see §14.2 |
| **G24** ✅ | `api/jobs/analyze.ts` ran `rescoreStaleTooFresh()` before the `vpsActive` break, while the maintenance worker also ran it | `api/jobs/analyze.ts` | **Fixed:** Vercel skips the sweep entirely when a VPS worker is active |
| **G25** ✅ | Fan-out did a `findFirst` + write per item **per subscriber** against a `DB_CONNECTION_LIMIT=4` pool | `applyScrapeItems` | **Fixed:** one `findMany` per source per page; a 10×5 batch went from ~50 round-trips to 10 |
| **G26** ⚠️ | `SIGTERM` only sets `shuttingDown`, checked *between* jobs; the in-flight job runs on and Docker `SIGKILL`s it after the (default 10s) grace | `worker/index.ts` + deploy config | **Partly fixed in code** (batch members whose videos landed are completed, not retried). Still needs `stop_grace_period: 300s` **in the deployment** — documented in `worker/Dockerfile` and `worker/.env.example` |

Deferred-design gaps (Phase B/C, folded into §3 above): **G11** cache-hit superset rule, **G12** shared-cache retention/RLS, **G13** duplicate pre-auth source of truth, **G14** lease timeout recovery, **G15** hashtag packing attribution, **G16** unsolicited-crawl solvency gate.

Process gaps: **G17** ⚠️ partial — `refresh-batching.test.ts` covers the kill switch, cap parsing, coalescing window and canonical grouping; the DB-bound cases (watermark merge, per-source re-filter, insolvent member skipped, terminal-only refund) still need a test harness with a database. **G20** ✅ `REFRESH_BATCHING_ENABLED` + `REFRESH_BATCH_PEER_CAP`. **G21** ⚠️ batch telemetry is now a single structured log line (`refresh batch canonical=… size=… apifyCents=… subscribers=…`) plus pro-rata `RefreshRun.costCents` and `scrape_share` `UsageLog` rows — queryable, though there is still no dashboard.

### Verification note

Before/after measurement must now be taken on the **maintenance worker's** logs, not Vercel's: with `WORKER_URL` set, `POST /api/jobs/analyze` reports `processed: 0` for every drain and tells you nothing about refresh behaviour. Grep the worker for `[worker] refresh batch:` — if that line is rare while refresh volume is high, you are seeing G22, not a bug in the grouping.

---

## 13. Worker feasibility — can this actually be built on the VPS workers?

**Verdict: yes, and most of it is easier on a long-lived worker than it was on Vercel.** Nothing in Phases B or C needs infrastructure the project does not already have. What is genuinely blocking is deployment-shaped, not code-shaped: the plan cannot be *scaled out* (more refresh containers) until the lease exists, and it cannot survive a redeploy until the batch failure paths are fixed.

### 13.1 What the worker makes easier

| Item | Why the VPS worker helps |
|---|---|
| **Phase B lease** | On Vercel a lease holder had a 45s reserve and a real chance of dying mid-scrape, stranding a `running` lease for `STUCK_AFTER_MINUTES`. The worker has no ceiling, so one holder can carry a ~170s scrape to completion. Same `UPDATE … FOR UPDATE SKIP LOCKED` primitive `claimNextJob` already uses — no new machinery |
| **Coalescing delay (G22)** | `claimNextJob` is already `ORDER BY "createdAt" ASC`; restoring the batching window is `AND "createdAt" < now() - interval 'REFRESH_COALESCE_MS'` for `kind='refresh'`. Waiting costs a background loop nothing, whereas on Vercel it would burn invocation budget. Refresh latency is already measured in minutes (`await_job` is built for it), so a 30s hold is invisible to users |
| **Migrations** | No `prisma migrate` framework in play — `supabase/migrations/*.sql` + a `schema.prisma` edit + `db push`. `CanonicalScrape` + `CanonicalScrapeSubscriber` is one file |
| **Long scrapes** | Phase C's packed multi-profile runs are longer than any single-profile run today. Only the worker can run them at all |
| **Budget guard** | `deadlineMs` is undefined on the worker, so `peerCap` is simply the constant and no refresh is ever requeued for lack of budget. The guard is now Vercel-fallback-only — inert, not broken |

### 13.2 Ordinary work, no worker-specific difficulty

G1/G2 (platform workspace + pro-rata attribution), G3 (per-member cap isolation), G7 (unique index + upsert), G9 (bill `newVideos`), G10 (plan-aware pre-auth), G20 (kill switch), G25 (bulk `findMany`/`createMany` instead of per-item round-trips).

### 13.3 The three real gates

**1. Refresh must stay a singleton until the lease lands (G23).**
A second `WORKER_KINDS=refresh,rescore` replica today means two concurrent Apify runs for the same canonical query — it makes spend *worse*. No compose file lives in this repo, so nothing in-tree prevents `replicas: 2`. Until Phase B:

- exactly one container may include `refresh` in `WORKER_KINDS`;
- worth a startup guard — log loudly (or refuse to claim `refresh`) unless an explicit `REFRESH_WORKER_SINGLETON=1` is set, so the constraint is enforced by the image rather than by memory.

**2. Container stop grace must exceed a whole batch (new — G26).**
`src/worker/index.ts` handles `SIGTERM` by setting `shuttingDown`, but the flag is only checked *between* jobs: the in-flight job keeps running. Docker's default 10s grace then `SIGKILL`s it. A redeploy landing mid-batch therefore kills the scrape and the fan-out, and with **G4** (refunded pre-auth + requeue ⇒ the retry replays the idempotent debit and is free) and **G5** (the catch-all fails every member, including ones already applied and billed) still open, that corrupts up to `REFRESH_BATCH_PEER_CAP` tenants' ledgers and wedges their refreshes for `STUCK_AFTER_MINUTES` (15). Master ships worker images to GHCR continuously, so this is a likely event, not a theoretical one.

Fix: `stop_grace_period: 300s` on the maintenance service (scrape ~170s + fan-out headroom), and fix G4/G5 **before** widening the peer cap. A mid-batch kill is survivable only when each subscriber settles independently.

**3. Pool math before wider batches (G25).**
`DB_CONNECTION_LIMIT=4` per container against the Supabase pooler, and fan-out is a `findFirst` + write per item **per subscriber**, serialized, while the video worker competes for the same pool. Bulk the existence check (`externalId IN (...)` once per source) before raising `REFRESH_BATCH_PEER_CAP`.

### 13.4 Not doable regardless of runner

Hashtag/keyword packing in Phase C (G15): a packed actor run returns a flat item list with no signal for which hashtag matched, so fan-out cannot attribute results to the right `Source`. Creator packing is fine — `creatorHandle` is on every normalized item. This is an actor-input limitation, not an infrastructure one.

### 13.5 Recommended sequence

1. **G24** — gate Vercel's `rescoreStaleTooFresh` behind `vpsActive`. Pure win, one condition, stops a live double-spend.
2. **G4 + G5 + G26** — make a batch survive a redeploy: refund only on terminal failure, isolate per-subscriber failures, raise `stop_grace_period`.
3. **G7** — unique index + upsert, so replayed fan-out is idempotent.
4. **G22** — `REFRESH_COALESCE_MS` claim delay: the cheapest way to make Phase A fire at all on this topology.
5. **Phase B** — `CanonicalScrape` lease + TTL reuse (§3, superset rule).
6. **Scale out** — only now is a second refresh container safe.
7. **Attribution** — G1/G2/G3, then G8/G10.

Steps 1–4 are hours of work and remove real spend. Step 5 is where the structural saving lives on the current topology.

---

## 14. What shipped (implementation record)

Everything below is on `feat/apify-multi-tenant-batching`, merged with `master` @ `0a32167`. Both typechecks green; `prisma validate` + `generate` clean.

### 14.1 Files

| File | Change |
|---|---|
| `src/lib/canonical-query.ts` | The one normalization used for grouping: `canonicalKey(platform, sourceType, query)` |
| `src/lib/refresh-policy.ts` | bootstrap ≤20 / incremental ≤5 plans + creator `postedAfter` watermark |
| `src/lib/refresh.ts` | `runBatchedRefresh` (one scrape, N subscribers) + `applyScrapeItems` (persist/score one source); bulk existence check; `P2002` → update; bill new videos only; pro-rata cost; `deferRefund` |
| `src/lib/jobs.ts` | `REFRESH_COALESCE_MS` hold in `claimNextJob`; `acquireCanonicalLock`/`releaseCanonicalLock`; peer claim with deadline filter + `sourceId` dedupe; `refreshBatchingEnabled` / `refreshBatchPeerCap` |
| `src/worker/process-job.ts` | Lease → peers → one scrape → per-subscriber settle; terminal-only refunds; batch telemetry line; "videos landed ⇒ complete, don't retry" |
| `src/tools/schedule.ts` | `plannedLimit` from `resolveRefreshPlan` for quotes, ceilings and pre-auths |
| `api/jobs/analyze.ts` | Skips `rescoreStaleTooFresh()` when a VPS worker is active |
| `prisma/schema.prisma` | `Video @@unique([sourceId, platform, externalId])`; `CanonicalScrapeLock` model |
| `supabase/migrations/20260812090000_video_unique_per_source.sql` | De-dupe existing rows, then the unique index |
| `supabase/migrations/20260812091000_canonical_scrape_lock.sql` | Lease table + expiry index + RLS enabled |
| `worker/.env.example`, `worker/Dockerfile` | New env vars; `stop_grace_period` guidance |
| `src/lib/refresh-batching.test.ts` | Kill switch, cap parsing, coalescing window, canonical grouping |

### 14.2 Two decisions worth remembering

**The lease is a row, not `pg_advisory_lock`.** The obvious implementation is a session-level advisory lock keyed on the canonical query: no table, no migration, and Postgres frees it when the worker dies. It is wrong here. The workers connect through the Supabase pooler in **transaction pooling** mode, where the backend that took the lock is returned to the pool after the statement; the matching unlock can land on a different backend, leaving the lock held for the life of the process and blocking that query until a restart. `CanonicalScrapeLock` needs no session affinity, self-heals via `expiresAt`, and is the row Phase B's result cache will grow from.

**The coalescing hold lives in `claimNextJob`, not in the worker loop.** Putting it in `src/worker/index.ts` would leave the Vercel fallback (and any future runner) claiming refreshes instantly and scraping alone. Enforcing it at the claim query means every runner obeys the same window by construction, and `REFRESH_BATCHING_ENABLED=0` removes both the batching and its latency cost together.

### 14.3 Deploy checklist

1. Apply both migrations (`supabase db push` or the SQL directly). The lock acquire fails **open** with a warning if `CanonicalScrapeLock` is missing, so code can ship before the migration — but duplicate scrapes stay possible until it lands.
2. `prisma generate` (postinstall already does it) — the `Video` compound unique is new.
3. Set on the maintenance worker: `REFRESH_COALESCE_MS=30000`, `REFRESH_BATCH_PEER_CAP=9`, optionally `PLATFORM_WORKSPACE_ID`.
4. Set `stop_grace_period: 300s` (compose) or `--stop-timeout 300` (docker run). Still the one gap the code cannot close by itself.
5. Watch `[worker] refresh batch canonical=… size=…`. `size=1` on every line means the hold is too short for the enqueue pattern, not that grouping is broken.

### 14.4 Why the lease matters with only ONE worker container

The VPS runs a single maintenance worker today, so "two containers scraping the same query" reads like a future problem. It is not:

1. **Every deploy runs two.** `docker compose up -d` starts the new container while the old one is still finishing its in-flight job — and the `stop_grace_period: 300s` in §13.3 deliberately makes that overlap *longer* (up to 5 minutes). During it, both poll the same queue. The lease is what stops the new container starting a second Apify run for a query the old one is mid-scrape on.
2. **Vercel is still a live drainer.** It claims nothing while `WORKER_URL` is set, but that is one env var. Unset it (or run a preview deployment with the same `DATABASE_URL`) and there are two runners again.
3. **`async: false` bypasses the queue.** `refreshSourceForWorkspace` still has an inline scrape path (`INLINE_REFRESH_MAX_VIDEOS = 0` means it is unreachable by default, but an explicit `async: false` debug call takes it). That path does **not** take the lease — a known, low-severity hole, listed here rather than silently left.

**Losing the race costs nothing.** The loser calls `yieldJob`, which requeues *and gives the attempt back* — `attempts` increments at claim time, so using `failJob` here would let three lost races terminally fail a refresh that never attempted anything. The same applies to the Vercel budget-requeue path.

### 14.5 Running a second worker container

Only worth it when *distinct-query throughput* is the bottleneck: with the lease, a second refresh container does not speed up one query (it yields and picks up other work), it drains **other** canonical queries in parallel.

```yaml
# docker-compose.prod.yml (sketch)
services:
  worker-video:
    image: ghcr.io/man0l/slashloop-worker:latest
    environment: { WORKER_KINDS: "analyze,fetch", DB_CONNECTION_LIMIT: "4" }
    stop_grace_period: 300s
  worker-maint:
    image: ghcr.io/man0l/slashloop-worker:latest
    environment:
      WORKER_KINDS: "refresh,rescore"
      DB_CONNECTION_LIMIT: "4"
      REFRESH_COALESCE_MS: "30000"
      REFRESH_BATCH_PEER_CAP: "9"
    stop_grace_period: 300s
    deploy: { replicas: 2 }      # safe ONLY because of the lease
```

Before scaling `worker-maint` past 1, check three things:

- **Pool.** Each replica opens `DB_CONNECTION_LIMIT` connections against the shared pooler; `replicas: 2` on both services is 16 connections before Vercel asks for any.
- **`WORKER_RESCORE_EVERY`.** Every maintenance replica runs `rescoreStaleTooFresh` on its own counter, so N replicas means N× the baseline top-up scrapes. That sweep needs its own lease (or `WORKER_RESCORE_EVERY=0` on all but one) before scaling — this is the G24 double-spend returning by a different route.
- **Coalescing.** Two replicas halve the effective batch size: each claims a leader from the same window, and one of the two yields on the lease. If the goal is cheaper scrapes rather than faster ones, one replica with a longer `REFRESH_COALESCE_MS` beats two replicas.

### 14.6 Deliberately not done

- **Phase B result reuse.** The lease prevents two concurrent scrapes; it does not let a workspace refreshing `@foo` 10 minutes after another skip Apify. That needs the cached result + superset rule in §3 and is the next real saving.
- **G8 normalization.** `create_source` still stores the raw query and `Source`'s unique key is on it, so `@Foo` and `foo` remain separate sources that happen to share a canonical key. Fixing it properly means migrating stored queries, not just centralising the function.
- **Hashtag packing (G15)** — blocked on attribution, see §3 Phase C.
