// Delete the WORKER_EXCLUDED names from the Worker if they are still bound.
//
// scripts/sync-worker-secrets.mjs is additive by design ("GH value absent →
// Worker secret LEFT AS-IS"), so dropping a name from the manifest never frees
// a slot: the old secret stays forever. That is how the Worker got to exactly
// 64 secret+text bindings — the Free-plan cap — and why PR #96's deploy failed
// with code 10055 on a 65th var. This step is the only thing that actually
// reclaims a slot, so it is deliberately explicit and separate from the push.
//
// Safe to run on every deploy:
//   • It reads the live settings first (names + types only, never values) and
//     deletes only names that are still bound, so a later run is a no-op.
//   • It fails loudly when CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID is
//     missing instead of guessing.
//   • --dry-run reports the plan and writes nothing.
//
// Deletion is limited to WORKER_EXCLUDED (scripts/worker-secrets.mjs), which
// documents each name and why the Worker cannot read it. The VPS image is
// unaffected: build-worker-image.yml reads those R2 values from GitHub itself.

import { execFileSync } from 'node:child_process';

import {
  WORKER_EXCLUDED,
  WORKER_NAME,
  countedVarNames,
  readWorkerSettings,
} from './worker-secrets.mjs';

/** Excluded names that are currently bound to the Worker. */
export function pruneTargets(liveNames, excluded = WORKER_EXCLUDED) {
  const bound = new Set(liveNames);
  return [...excluded].filter((name) => bound.has(name)).sort();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const targets = pruneTargets(countedVarNames(await readWorkerSettings()));

  if (targets.length === 0) {
    console.log('no excluded Worker vars bound; nothing to prune');
    return;
  }

  console.log(`${dryRun ? 'would delete' : 'deleting'} ${targets.length} Worker var(s): ${targets.join(' ')}`);
  if (dryRun) return;

  for (const name of targets) {
    execFileSync('bunx', ['wrangler', 'secret', 'delete', name, '--name', WORKER_NAME], { stdio: 'inherit' });
  }
  console.log('excluded Worker vars pruned.');
}

const invoked = process.argv[1] && process.argv[1].endsWith('prune-worker-secrets.mjs');
if (invoked) {
  main().catch((error) => {
    console.error(`prune-worker-secrets failed: ${error.message}`);
    process.exit(1);
  });
}