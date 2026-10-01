# Test suite ordering policy

Decided 2026-10-01, after deploy-worker run 188 (verify failed on
`src/cf/internal.test.ts`, `deploy` skipped, merged SHA never published).

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

## How a violation shows up

Order-dependent coupling is invisible locally and reproducible only in CI,
which is what makes it expensive. The mitigations in place:

- `.github/workflows/verify-pr.yml` runs the same typecheck + `bun test` as
  the deploy gate on every pull request, so a violation is caught on the PR
  that introduces it rather than on `master` after a merge.
- `cloudflare-worker/deploy-blocked` names the gating job on the SHA, so a
  blocked publish is legible from the commit page. A red gate blocks every
  later push, not just its own SHA.
