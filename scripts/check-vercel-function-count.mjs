#!/usr/bin/env node
// Guard the Vercel Hobby per-deployment Serverless Function limit.
//
// Vercel builds EVERY .js/.ts file under api/ as its own Serverless Function,
// so the file count in api/ is a hard deploy-time constraint, not a style
// preference. On the Hobby plan a deployment may hold at most 12; going over
// fails the deploy at the patchBuild step AFTER a perfectly green build, which
// is why typecheck and `bun test` never catch it.
//
// This has bitten this repo twice:
//   - 2026-08-03 c23d6f8 "fix(api): consolidate routes to fit Vercel Hobby's
//     12-function cap" — 19 functions, consolidated down to 9.
//   - 2026-09-16 000e05c added the social scheduler (12 -> 16) and the tree
//     never came back under the cap, so every deploy since has failed.
//     See SLA-314.
//
// Counting rule replicated from Vercel's build detection:
//   - every JS/TS file under api/ counts, including `*.test.ts`;
//   - a path segment starting with `_` is excluded (Vercel's documented
//     utility-file convention, e.g. api/_shared/);
//   - `.vercelignore` entries are excluded.
//
// Exits non-zero when the count exceeds the limit, so CI fails the PR before
// a 13th file can reach master and break deploys.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOBBY_LIMIT = 12;
const FUNCTION_FILE = /\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx)$/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function collectFunctions(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFunctions(full, acc);
    else acc.push(full);
  }
  return acc;
}

function readVercelignore() {
  const file = join(repoRoot, '.vercelignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^\.\//, '').replace(/\/$/, ''));
}

/** Count the api/ files Vercel will turn into Serverless Functions. */
export function countApiFunctions(root = repoRoot) {
  const apiDir = join(root, 'api');
  if (!existsSync(apiDir)) return { functions: [], ignored: [] };

  const ignored = readVercelignore();
  const all = collectFunctions(apiDir)
    .map((full) => relative(root, full).split(sep).join('/'))
    .filter((path) => FUNCTION_FILE.test(path));

  // `_`-prefixed segments are Vercel's documented exclusion for utility files.
  const counted = all.filter(
    (path) => !path.split('/').slice(1).some((segment) => segment.startsWith('_')),
  );
  return { functions: counted.sort(), ignored: all.filter((p) => !counted.includes(p)).sort() };
}

function main() {
  const { functions, ignored } = countApiFunctions();
  for (const path of functions) console.log(`  ${path}`);
  if (ignored.length > 0) console.log(`  (excluded: ${ignored.join(', ')})\n`);

  const count = functions.length;
  const headroom = HOBBY_LIMIT - count;
  console.log(`api/ Serverless Functions: ${count} / ${HOBBY_LIMIT} (Vercel Hobby limit)`);

  if (count > HOBBY_LIMIT) {
    console.error(
      `\n${count - HOBBY_LIMIT} over the limit. Vercel will reject every deployment of this ` +
        `commit with "No more than ${HOBBY_LIMIT} Serverless Functions can be added to a ` +
        `Deployment on the Hobby plan" — after a green build, so nothing else catches it.\n` +
        `Fix by routing more URLs at one physical function via vercel.json rewrites ` +
        `(the api/sources.ts pattern), or move helper/test files out of api/.`,
    );
    process.exit(1);
  }
  console.log(`OK — ${headroom} function${headroom === 1 ? '' : 's'} of headroom.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();