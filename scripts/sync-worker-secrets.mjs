// Sync GitHub-provided environment variables → Cloudflare Worker secrets.
//
// GitHub is the source of truth (repo secrets/variables + the `production`
// environment the workflow runs under). This script runs INSIDE the deploy
// workflow, reads whatever the manifest lists from process.env, and pushes
// the non-empty ones with `wrangler secret bulk`.
//
// Semantics ("if set"):
//   • GH value present and non-empty → pushed (overwrites the Worker's).
//   • GH value absent/empty → Worker secret LEFT AS-IS (never deleted).
//   • Names not in the manifest are never touched.
//
// The manifest and the Free-plan var budget live in ./worker-secrets.mjs,
// together with WORKER_EXCLUDED — names the Worker must not carry. Because
// "if set" never deletes, pruning those names is a separate, explicit step
// (./prune-worker-secrets.mjs).
//
// One-time setup lives on the Cloudflare side (`wrangler secret put`) only
// for values that have no GH home (e.g. the generated GALLERY_LINK_SECRET).

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MANIFEST, WORKER_EXCLUDED, WORKER_NAME, isPlaceholder } from './worker-secrets.mjs';

/**
 * Build the `wrangler secret bulk` payload from the environment: every
 * manifest entry whose GitHub value is present and not a placeholder.
 * Exported for tests; `env` is injected so nothing here reads process.env.
 */
export function buildPayload(env = process.env) {
  const payload = {};
  const skipped = [];
  for (const [ghName, workerName] of Object.entries(MANIFEST)) {
    if (WORKER_EXCLUDED.has(workerName)) continue;
    const value = env[ghName];
    if (!value || value.trim() === '' || isPlaceholder(value)) {
      skipped.push(ghName);
      continue;
    }
    payload[workerName] = value;
  }
  return { payload, skipped };
}

function main() {
  const { payload, skipped } = buildPayload(process.env);

  const names = Object.keys(payload);
  console.log(`syncing ${names.length} secrets: ${names.join(' ')}`);
  if (skipped.length > 0) console.log(`not set in GitHub (left as-is on the Worker): ${skipped.join(' ')}`);

  if (names.length === 0) {
    console.log('nothing to sync');
    return;
  }

  const file = join(tmpdir(), `worker-secrets-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(payload));
  try {
    execFileSync('bunx', ['wrangler', 'secret', 'bulk', file, '--name', WORKER_NAME], { stdio: 'inherit' });
    console.log('secrets synced.');
  } finally {
    rmSync(file);
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('sync-worker-secrets.mjs');
if (invoked) main();