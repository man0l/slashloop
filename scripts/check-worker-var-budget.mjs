// Fail the deploy BEFORE wrangler does, if the Worker's secret+text vars would
// exceed the Free-plan cap of 64.
//
// Cloudflare rejects the 65th secret_text/plain_text binding with code 10055
// ("Maximum allowed number of secrets"), and it rejects it during
// `wrangler deploy` — after the D1 migration apply, after the SHA stamp, with
// the Worker left on the previous build. PR #96 hit exactly that, and because
// deploy-worker.yml only ran on pushes to master, the failure was only
// discoverable after the merge.
//
// This step is the cheap preflight for that class of failure: read the live
// settings (names + types only), project the counted set this deploy will
// finish with, and fail the job when it does not fit. The check is advisory
// about *count*, exact about *names* — the log lists what is bound.
//
// Run it locally with:  bun scripts/check-worker-var-budget.mjs

import {
  FREE_VAR_CAP,
  countedVarNames,
  projectCountedVarNames,
  pushedWorkerNames,
  readWorkerSettings,
  wranglerVarNames,
} from './worker-secrets.mjs';

async function main() {
  const liveNames = countedVarNames(await readWorkerSettings());
  // Read AFTER the prune step, so the excluded names are already gone. Nothing
  // here assumes that: a skipped prune shows up as the real over-count it is.
  const projected = projectCountedVarNames({
    liveNames,
    addedNames: [...pushedWorkerNames(), ...wranglerVarNames()],
  });

  console.log(`Worker var budget: ${projected.length}/${FREE_VAR_CAP} counted bindings after this deploy`);
  if (projected.length > FREE_VAR_CAP) {
    const over = projected.length - FREE_VAR_CAP;
    console.error(
      `too many Worker secret+text vars: ${projected.length} > ${FREE_VAR_CAP} (${over} over).\n`
      + `Free accounts cap secret_text + plain_text at ${FREE_VAR_CAP}. Fix before deploying:\n`
      + `  • stop pushing a var the Worker never reads, and delete it from the Worker\n`
      + `    (WORKER_EXCLUDED in scripts/worker-secrets.mjs + scripts/prune-worker-secrets.mjs)\n`
      + `  • consolidate two env vars behind one value the code already reads\n`
      + `  • move the Worker to a plan with a higher limit\n`
      + `currently bound: ${liveNames.length}`,
    );
    process.exitCode = 1;
    return;
  }
  if (projected.length === FREE_VAR_CAP) {
    console.log(`at the cap: the next added var will fail the deploy. Consider consolidating now.`);
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('check-worker-var-budget.mjs');
if (invoked) {
  main().catch((error) => {
    console.error(`check-worker-var-budget failed: ${error.message}`);
    process.exit(1);
  });
}