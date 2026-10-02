# Test suite run-dependence policy

Decided 2026-10-01, after deploy-worker run 188 (verify failed on
`src/cf/internal.test.ts`, `deploy` skipped, merged SHA never published).
Extended 2026-10-02 with the wall-clock half of the same problem, which took
out the next two runs for a different reason.

Both sections below are one problem: a test whose result depends on something
about the *run* other than the code under test. `deploy` needs `verify`, so
either kind costs the whole pipeline, not just the change that introduced it.

## The decision

**A test file must not depend on any other test file. Order is not a knob.**

Concretely, in `*.test.ts` files:

1. No `mock.module()` on a specifier that any other test file also mocks.
   `mock.module` mutates the process-wide module registry, and every file in a
   `bun test` run shares it.
2. No test file may leave process-global state behind for another file to
   observe or trip over — `globalThis` slots, `process.env` keys, module-level
   mutable singletons.
3. If a unit needs a seam, own it: inject it, or set it up and tear it down
   inside the file that needs it.

Review rule: a new `mock.module` in a test file needs the same scrutiny as a
change to a shared module, because its blast radius is every other test file.

## Why sorting discovery was rejected

The obvious alternative — make discovery sorted so the order is fixed — does
not work with `bun test`, and this was measured rather than assumed.

```
$ bun scripts/bun-test-order-probe.ts
bun test order probe
  bun version: 1.4.2
  command line: e-echo d-delta c-charlie a-alpha m-bravo
  ran in order: a-alpha c-charlie d-delta e-echo m-bravo
VERDICT: bun test IGNORES the command-line order.
```

`bun test` discards the order of the paths it is given and uses its own
discovery order. That order is a filesystem walk, so it varies with the
checkout: on the same SHA, `src/cf/serialize-d1.test.ts` runs before
`src/cf/internal.test.ts` in one checkout and `src/cf/internal.test.ts` lands
around position 50 in CI. It is not alphabetical, and it is not Node's
`readdir` order either.

So there is no sorted-discovery lever to pull. Even if there were, a fixed
order would only make a process-global leak *consistently* green or
consistently red; it would not make the tests independent. Independence is the
property worth having, because a leak that a chosen order happens to avoid is
one refactor, one new test file, or one Bun upgrade away from resurfacing.

Re-run the probe after any Bun upgrade. If it reports that the command-line
order is honoured, revisit this document — the runner's behaviour changed and
the reasoning above no longer holds.

## Why the suite is not safe today

16 test files call `mock.module`, and at least two of them replace
`src/store.js` wholesale (`src/lib/queue-owner.test.ts`,
`src/lib/fallback-reconcile.test.ts`). `src/cf/internal.ts` imports `rawBatch`
from that module, so a replacement from either file can reach the bridge
endpoint's accounting. `src/cf/internal.test.ts` pins its own seam; that is
the correct local fix and it is not yet on `master`.

The same SHA disagrees with itself in both directions, which is the whole
argument in one measurement. On `01bd731`:

- full `bun test` in a local checkout: 786 pass, 1 fail —
  `src/worker/pg-runtime.test.ts` ("lifecycle sink ignores D1 ids"), which
  passes when run on its own;
- `bun test` in deploy-worker run 188: 5 failures, all in
  `src/cf/internal.test.ts`, and `pg-runtime` green.

Neither environment is wrong; they are running the files in different orders.
So an order-dependent failure here is not a flake to re-run — it is a
statement about which files ran first, and it can flip in either direction on
the next checkout.

The general class is still open. That is a code change, not a CI change, so
it is tracked separately from the pipeline work.

## The wall clock is not a fixture

A test must not depend on what day it is run on. Concretely:

1. A test that drives a simulated day must pass an explicit `Date` to every
   function under test. Bare `new Date()` next to a fixed timestamp is the bug,
   and the compiler cannot see it — both are valid dates.
2. Where the code under test reads the clock itself, inject or pin it. Do not
   reach for the real one and then compare against a fixture.
3. If a test genuinely needs "now" (a TTL that must be in the future), keep every
   other timestamp in that test relative to that same `now`, so the file stays
   correct on any date. This is what `d1-read-budget.test.ts` already does for
   its staleness checks with its `later()` helper.

### What it cost

`src/cf/d1-read-budget.test.ts` recorded a failed KV flush with a bare
`new Date()` and then replayed the runaway with `AT`, a fixed
`2026-10-01T09:00:00Z`. The sticky degraded flag is scoped to a UTC day, so the
two only lined up while the real date happened to *be* AT's date. The test's own
comment said "Same day, one failed flush at the start" — the intent was
recorded, the code did not express it.

Nothing about that looks like a date bomb in review, and nothing looks wrong in
a local run either. It passed on 2026-10-01, and at 2026-10-02T00:00Z it started
failing and could not pass again until someone changed the fixture. Because
`deploy` needs `verify`, the cost was every publish in the repo:

| run | SHA | what it blocked |
| --- | --- | --- |
| 195 | `dbd1248` (merge of #103) | the D1 read-budget fix never reached production |
| 196 | `a49596f` (merge of #106) | everything after it, with no retry |

The last good publish was run 194 (`2b491ee7`, merge of #102). `worker-live`
still points there.

The same failure mode as run 188, one layer over: there the run depended on the
order `bun test` discovered files in, here it depended on the calendar.

### The invariant that makes the fix honest

The repaired test now pins *why* `AT` is required, so the flag cannot be moved
to a `Date` that merely looks equivalent: `load()` re-seeds the per-isolate cache
when the UTC day changes, so a blip is scoped to the day it was raised on and
midnight UTC is a real recovery. Making the sticky flag survive the rollover
fails that test.

## How a violation shows up

Order-dependent coupling is invisible locally and reproducible only in CI,
which is what makes it expensive. The mitigations in place:

- `.github/workflows/verify-pr.yml` runs the same typecheck + `bun test` as
  the deploy gate on every pull request, so a violation is caught on the PR
  that introduces it rather than on `master` after a merge.
- `cloudflare-worker/deploy-blocked` names the gating job on the SHA, so a
  blocked publish is legible from the commit page. A red gate blocks every
  later push, not just its own SHA.
