# Multi-tenant Apify batching plan

**Goal:** One Apify actor run can serve many workspaces (tenants) that track the same TikTok creator/hashtag/keyword, so we pay **once per unique query**, not once per tenant.

**Status:** Phase A implemented (see §9). Incremental "new outliers" refresh is in `src/lib/refresh-policy.ts`. **A code audit (§12) found 10 open gaps in the shipped Phase A path — 6 of them touch money. Read §12 before extending this to Phase B.**

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

### Phase A — In-process coalescing (fast, single deploy)

**When:** Job worker drains refresh jobs (`src/worker/process-job.ts`, shared by the Vercel drain and the VPS worker).

1. Claim a `refresh` job (leader).
2. Claim queued peer jobs with the same `canonicalKey(platform, sourceType, query)`.
3. For that group:
   - Compute a **union plan**:
     - `limit = max(plan.limit across members)`
     - `postedAfter = min(watermarks)` for creators, and only when **every** member has one (any bootstrap member widens to no filter)
   - **One** `scrapeSource` call.
   - For each workspace/source in the group, run **persist+score only** (`applyScrapeItems`), re-applying that source's own `postedAfter`, and debit **that** workspace's credits.

**Pros:** No new tables; works on one drain invocation.
**Cons:** Only batches jobs queued in the same drain window; multi-instance drains need a DB lease (Phase B).

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
2. Leader worker takes lease (`UPDATE … WHERE status=queued`).
3. Runs Apify once, writes results.
4. Fan-out workers (or same worker) apply results per subscriber and settle credits.

**TTL:** Cache results 15–60 minutes so a second workspace refreshing the same creator within the window **reuses** without Apify.

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
| Debit **per workspace**, never share a ledger | Multi-tenant isolation | ✅ implemented |
| Charge for **value received**, not raw Apify line item | Workspace A may already hold 4/5 results → charge less than B | ❌ **violated — G9** |
| `credits = ceil(1.5 × newVideos)` for incremental | Aligns with "new outliers only" | ❌ code bills `newVideos + updatedVideos` |
| Platform absorbs true Apify COGS | Or mark up and track margin in `UsageLog` | ❌ **the batch leader absorbs it — G1** |
| Cap / insufficient credits: **skip that subscriber**, do not fail the whole batch | One broke tenant must not block others | ⚠️ true for credits, **false for the spend cap — G3** |
| Idempotent `opId` per MediaJob | Keep existing retry safety | ⚠️ idempotent, but makes a retried run **free — G4** |

**Do not** bill every subscriber the full Apify result count if they already had those videos — that recreates the waste we just fixed.

### Apify COGS attribution (new — resolves G1/G2)

The current scheme (`attributeApifyCost: i === 0`) makes one arbitrary tenant carry the whole batch, both in `RefreshRun.costCents` and — worse — in their monthly spend cap. Target scheme:

1. Introduce a **platform workspace** (env `PLATFORM_WORKSPACE_ID`) that owns shared scrapes. `scrapeSource` for a batch asserts and records against it, not against `ready[0]`.
2. Keep a per-source `RefreshRun.costCents` = `scrapeCostCents / batchSize` (integer cents, remainder to the leader) so per-source cost analytics stay meaningful — §10's savings metric is computed from these rows.
3. Emit one `UsageLog` row per subscriber with the pro-rata share so no workspace free-rides an unbounded number of shared scrapes invisibly.

Until (1) ships, `REFRESH_BATCH_PEER_CAP` is effectively a cap on how much of one tenant's spend cap can be spent on other tenants.

---

## 5. Data isolation

- Videos stay **owned by `Source` / workspace** (current model). Fan-out **copies or links**:
  - **Copy (recommended v1):** insert/update `Video` rows per sourceId (today's shape). Simple RLS, retention, scoring.
  - **Link (v2):** global `GlobalVideo` + `WorkspaceVideo` join — less storage, more migration pain.
- Never write another workspace's `sourceId`.
- Thumbnails: ingest per workspace or shared thumb key with refcount (later).

**Missing constraint (G7):** `Video` has no unique index on `(sourceId, platform, externalId)`. Dedupe is a read-then-write (`findFirst` → `create`), so two overlapping drains touching the same source duplicate rows. Add:

```sql
CREATE UNIQUE INDEX CONCURRENTLY "Video_sourceId_platform_externalId_key"
  ON "Video" ("sourceId", "platform", "externalId");
```

then switch `applyScrapeItems` to an upsert on that key. This is what makes fan-out genuinely idempotent, and it is a prerequisite for Phase B (where two workers can apply the same cached result).

Scoring (`batchScoreVideos`) stays per-source; baselines by `creatorHandle+platform` are already global and benefit everyone (existing behavior).

---

## 6. Interaction with "new outliers only" policy

Already implemented:

- Bootstrap ≤20, incremental ≤5, creator `postedAfter` watermark.

Batching should:

1. Resolve plan **per source**, then **merge** for the Apify call (max limit, min postedAfter).
2. Apply **per source** filters again on fan-out (drop items older than that source's watermark if we widened the window for a sibling). ✅ implemented.
3. Keep baseline rescrapes (`sourceTypeOverride`) **out of** cross-tenant batches — different purpose (stats for too_fresh). ✅ `runRefresh` routes those to `runRefreshSolo`.

**Not yet done (G10):** the policy stops at the scrape. `enqueueRefreshJob` still pre-authorises `1.5 × source.videoLimit` (legacy sources carry `videoLimit: 50` → 75 credits) while the worker will actually run `limit=5`. Two consequences: large pre-auths sit locked until settlement, and `refresh_due_sources` sizes its credit ceiling off the same inflated number, so a scheduled run queues far fewer sources than the budget allows. Fix: call `resolveRefreshPlan` (or a cheap `estimateRefreshLimit`) at enqueue time and pre-auth from that.

**Not yet sized:** `rescoreStaleTooFresh` runs an unbatched baseline scrape on every drain. It is deliberately excluded from batching, but it is a recurring Apify cost that the savings metric in §10 must report separately rather than hide.

---

## 7. API / job surface changes

| Component | Change |
|---|---|
| `enqueueRefreshJob` | Optional `canonicalKey`; pre-auth from the resolved plan, not raw `videoLimit` (G10) |
| `runRefresh` | Split into `scrapeCanonical()` + `applyScrapeToSource()` ✅ (`runBatchedRefresh` + `applyScrapeItems`) |
| `processClaimedJob` | Group-by-canonical before scrape ✅ (both workers share it) |
| `refresh_source` tool | Unchanged UX; may complete faster when cache hit |
| Observability | Persist `batchSize`, `canonicalKey`, `apifyCostCents`, `subscribers` — not `console.log` only (G21) |
| Kill switch | `REFRESH_BATCHING_ENABLED` env flag + tunable `REFRESH_BATCH_PEER_CAP`, so batching can be turned off without a redeploy (G20) |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| One tenant's huge `videoLimit` inflates batch | Cap merge with `REFRESH_INCREMENTAL_CAP` / bootstrap cap; ignore pathological overrides in scheduled path |
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
3. **Done — Phase A:** Peer claim by canonical key (`claimRefreshPeersForCanonical` in `src/lib/jobs.ts`, wired in `src/worker/process-job.ts` so the Vercel drain and the VPS worker share it). One Apify scrape, fan-out persist/score, per-workspace credits. Video lookup scoped to `sourceId`. Peer count scales with the caller's remaining budget.
4. **Next — Phase A hardening (do before Phase B):**
   - G9 bill `newVideos` only (or an explicit "stats refresh" price for updates)
   - G1/G2 platform workspace + pro-rata cost attribution
   - G3 per-member spend-cap isolation
   - G4 refund only on terminal failure
   - G5 per-subscriber failure isolation in the fan-out loop
   - G7 unique index + upsert
   - G8 single normalization function
   - G20 kill switch
5. **Phase B:** `CanonicalScrape` lease + 30m result reuse with the superset rule.
6. **Phase C:** Scheduled distinct-query crawl + creator packing (hashtag packing blocked on attribution).
7. Metrics dashboard: Apify $ / distinct query / day vs jobs / day (savings ratio).

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

Findings from reading `src/lib/refresh.ts`, `refresh-policy.ts`, `canonical-query.ts`, `jobs.ts`, `worker/process-job.ts`, `spend-cap.ts`, `credits.ts`, `prisma/schema.prisma`. Ordered by money impact.

| # | Gap | Where | Impact |
|---|---|---|---|
| **G1** | Batch scrape runs as `ready[0].workspaceId`, so `assertApifyCap` + `recordApifySpend` charge the whole batch to the leader; peers show $0 Apify spend forever | `runBatchedRefresh` → `scrapeSource` | Leader breaches its $5 cap doing other tenants' work; cap stops guarding free-riders |
| **G2** | Only the leader gets `attributeApifyCost`; peers write `RefreshRun.costCents = 0` | `settleAndApply` | Per-source cost analytics — the basis of §10 — are wrong by construction |
| **G3** | Per-member cap is pre-checked, but the real `assertApifyCap` inside the scrape runs on the leader only; a leader breach refunds and fails **every** member | `runBatchedRefresh` | Violates "one broke tenant must not block others" |
| **G4** | Scrape/persist failure refunds the full pre-auth under `${opId}:fail`, then `failJob` requeues; the retry replays the idempotent `${opId}:preauth` debit and charges nothing | `refresh.ts` + `failJob` | A retried refresh is free. Pre-existing, multiplied by N per batch |
| **G5** | The fan-out `catch` fails **all** `batchJobs`, including members already applied and billed | `processClaimedJob` | Double persist + inconsistent ledger on retry; §8's stated mitigation is unimplemented |
| **G6** | Peer claim ignores `deadlineAt` and does not spread across workspaces (one workspace can fill all peer slots) | `claimRefreshPeersForCanonical` | Expired jobs run; unfair scheduling |
| **G7** | No unique index on `Video(sourceId, platform, externalId)`; dedupe is read-then-write | `prisma/schema.prisma` | Duplicate videos under concurrency; blocks safe Phase B replay |
| **G8** | Three normalizations: `canonical-query.ts` (per-type, repeated prefixes), `suggestions.ts` (private copy, single `[#@]`, type-blind), `create_source` (**none** — `Source` unique key is on the raw query) | multiple | `@Foo` and `foo` are separate Sources; batch key can disagree with the dismissal key |
| **G9** | Billing is `newVideos + updatedVideos`; §4 says `newVideos` | `settleAndApply` | A workspace that already held all 5 results pays full price — the exact waste this plan exists to remove |
| **G10** | `enqueueRefreshJob` pre-auths `1.5 × videoLimit`, ignoring the refresh policy the worker will apply | `jobs.ts`, `tools/schedule.ts` | Over-locked credits; scheduled runs queue too few sources |

Deferred-design gaps (Phase B/C, folded into §3 above): **G11** cache-hit superset rule, **G12** shared-cache retention/RLS, **G13** duplicate pre-auth source of truth, **G14** lease timeout recovery, **G15** hashtag packing attribution, **G16** unsolicited-crawl solvency gate.

Process gaps: **G17** no tests for the batching path (only `canonical-query` and `refresh-policy` are covered) — needed cases: mixed bootstrap/incremental watermark merge, per-source `postedAfter` re-filter, insolvent member skipped without aborting, scrape failure refunding all members, cost attributed exactly once. **G20** no kill switch. **G21** batch telemetry is `console.log` only, so the savings ratio cannot be computed after the fact.
