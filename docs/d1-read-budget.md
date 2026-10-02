# D1 read budget — where the rows go, and why

The Workers Free tier caps an **account** at **5,000,000 rows read per UTC
day**. Crossing it fails *every* D1 read on *every* database on the account
until midnight (Cloudflare error 7500), so one runaway query takes down
unrelated reads in other products sharing the account. That is what happened on
2026-09-30 (SLA-195) and what the `/internal/raw-batch` ceiling in
`src/cf/d1-read-budget.ts` exists to stop.

This file is the ledger of what customer-facing tools spend, measured against
the `slashloop` D1 database. **All numbers below are `meta.rows_read` from the
Cloudflare D1 query API (REST v4), measured 2026-10-02.** The v4 path works
from the agent environment where v1 does not.

Reproduce any row with:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/e1caee8f-3962-42a1-84d3-9d17eb3cab34/query" \
  -d '{"sql":"<sql>","params":[...]}'
# -> result[0].meta.rows_read
```

Use `EXPLAIN QUERY PLAN <sql>` to confirm a read is index-served. A plan with
`USE TEMP B-TREE FOR ORDER BY` over `CreditLedger` means a full slice scan, and
that is the shape to avoid.

---

## get_usage — the most-called customer-facing tool

Measured on the largest production workspace (17,331 `CreditLedger` rows).
Workspace ids and balances are deliberately omitted — this is a public repo.

| Leg | Before | After | Why |
|---|---:|---:|---|
| recent ledger, `createdAt` leg | 34,663 | 34,663 → **20** with [#109](https://github.com/man0l/slashloop/pull/109) | The `CAST("createdAt" AS TEXT)` in the projection forced a row fetch per candidate. Fixed by #109. |
| recent ledger, `refId` leg | 20 | 20 | Bounded range `['20','21')` on `CreditLedger_workspaceId_refId_key`; a seek. |
| `SUM(delta)` reconciliation | **17,332** | **0** | Removed. See below. |
| `UsageLog` for the period | 2,480 | 2,480 | Unchanged. Bounded by the period, not by ledger size. |
| **Total** | **~54,495** | **~2,520** (or **~60** once #109 lands) | |

At the "before" figure, **~91 get_usage calls exhaust the 5M/day cap**, and
once it is exhausted every D1 read on the account fails until midnight UTC.

### Why the `SUM(delta)` leg is gone

It was 99% of the remaining cost after #103 fixed the first leg, and it was
also **reporting a discrepancy that did not exist**.

`SELECT COALESCE(SUM("delta"), 0) FROM "CreditLedger" WHERE "workspaceId" = ?`
is a full scan of the workspace's ledger. There is no index that can serve an
unbounded sum over a slice, and the rows it needs are the ones no index range
can name. It cannot be paged.

Worse, `sum(delta)` is not supposed to equal the wallet:

- `txSetPlan` (`src/lib/credits.ts`) writes `delta = updated.planCredits -
  before.planCredits`. A plan **cycle reset is a new allotment, not an
  increment** — resetting 3,000 → 0 records −3,000 even though the customer
  had only spent part of it, and the running total permanently stops matching
  the wallet.
- The experiments path (`src/experiments/store.ts`) splits one charge into a
  plan row and a pack row and deliberately writes a **zero-delta** row to keep
  the split exact.

Measured across every production workspace with a non-trivial ledger, before
this change:

| workspace | ledger rows | wallet == `sum(delta)` | wallet == newest `balanceAfter` |
|---|---:|---|---|
| largest (17,331 rows) | 17,331 | **false** | true |
| second | 736 | **false** | true |
| third | 35 | **false** | false |
| fourth | 13 | **false** | true |
| fifth | 12 | **false** | true |

Five for five, the check said "your wallet does not reconcile" on healthy
accounts, at 17,332 rows a call.

### What replaced it

`balanceAfter` on each row already stores the wallet as of that write, so the
invariant that actually holds is checked instead — both free, from the 20 rows
get_usage is **already** reading:

1. **Wallet vs newest `balanceAfter`.** Catches a wallet that moved with no
   ledger row behind it (a direct `planCredits` edit, a Stripe path that
   updated the balance and failed to write the row).
2. **Predecessor balance present in the window.** Each row's predecessor is the
   row whose `balanceAfter` equals `this.balanceAfter - this.delta`. Every row
   but the oldest must find it. Two or more unanchored rows means a row was
   deleted, inserted, or a delta was hand-edited.

The second check is **set membership, not a walk over consecutive rows**, and
that is load-bearing. `createdAt` is stamped when the request is built but the
D1 `rawBatch` commits later, so under concurrency the timestamp order is *not*
the write order. On one production workspace two debits 4ms apart stored
`balanceAfter` 274
and 282 in the opposite order to their `createdAt`; a consecutive-pair walk
reported **6 phantom breaks on a healthy ledger**. Two debits landing in the
same millisecond is routine on D1, not corruption. Ordering by `balanceAfter`
does not fix it either — `balanceAfter` is not monotonic across a window mixing
debits and refunds, and that ordering invented phantom breaks too. Set
membership asks the same question without assuming an order the table does not
store.

Verified 0 false positives across all 9 production workspaces with 2+ ledger
rows at take=20. It still fires on a deleted row, a hand-edited delta, and a
real 2-credit corruption in a workspace's 2026-09-01 rows (a row says
`-8` where the balance moved 6).

### The honest limit

A window check cannot see a row corrupted **before** the window. That is a
deliberate trade: an unbounded scan on a customer-facing tool, against a shared
5M/day account cap, to find a corruption not observed in any live workspace.

`get_usage` takes `auditFullLedger: true` for the whole-slice view. It is off
by default, costs a full scan, and its `driftFromWallet` is **expected to be
non-zero on a healthy account** for the plan-cycle-reset reason above — read it
as "how far the running total has drifted", never as "the wallet is wrong".
`src/lib/ledger-recent.test.ts` asserts it stays opt-in.

---

## Other D1 costs worth knowing

- **`/internal/raw-batch` bridge** — 4,000,000 rows/day ceiling in
  `src/cf/d1-read-budget.ts`, counted in KV (never D1: a D1 row counter would
  consume the rows it exists to protect). Degraded mode fails *down* to 1/16 of
  the ceiling. Rationale in `docs/compute-target.md`.
- **KV writes** — 1,000/day account-wide, shared with the digest sweep cursor.
  This is why the read counter spends a *write budget* rather than flushing
  often for accuracy.
- **Free tier write cap** — 100,000 rows/day. The read cap is the one that has
  actually bitten.

## Rules of thumb

- Any new read over `CreditLedger` must be index-served. Check with
  `EXPLAIN QUERY PLAN`; `USE TEMP B-TREE` over the table is a scan.
- No unbounded `SUM`/`COUNT` on a customer-facing path. If a whole-slice
  aggregate is genuinely needed, make it opt-in and say what it costs.
- Cost of a read is a function of **workspace size**, not request size. The
  largest workspace sets the worst case; measure there.
- When you change a query's shape, measure before *and* after on production
  and put both numbers in the PR. The code comments in `src/lib/ledger-recent.ts`
  and `src/lib/credit-reconcile.ts` carry the per-query history.
