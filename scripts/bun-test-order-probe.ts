#!/usr/bin/env bun
// Measure whether `bun test` honours the order of the file paths on its
// command line, or runs them in its own order regardless.
//
// This is the evidence behind docs/test-suite-policy.md. Run it after any Bun
// upgrade and after the test suite is reorganised; it exits non-zero if the
// observed behaviour flips, because the policy document's rationale depends
// on it.
//
//   bun scripts/bun-test-order-probe.ts
//
// It is a measurement tool, not a gate. Nothing in CI calls it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES = ['m-bravo', 'a-alpha', 'c-charlie', 'd-delta', 'e-echo'] as const;
const MARKER = 'ORDER-PROBE-RAN';

const dir = mkdtempSync(join(tmpdir(), 'bun-test-order-probe-'));

try {
  for (const name of FILES) {
    writeFileSync(
      join(dir, `${name}.test.ts`),
      [
        "import { test } from 'bun:test';",
        `test('${name}', () => {`,
        `  console.log('${MARKER} ${name}');`,
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  // Ask for the exact reverse of the on-disk creation order. If bun honoured
  // the command line, e-echo would be first.
  const requested = [...FILES].reverse();
  const proc = Bun.spawnSync(['bun', 'test', ...requested.map((n) => `${n}.test.ts`)], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = proc.stdout.toString();
  const observed = stdout
    .split('\n')
    .filter((line) => line.includes(MARKER))
    .map((line) => line.slice(line.indexOf(MARKER) + MARKER.length + 1).trim());

  const lines = [
    'bun test order probe',
    `  bun version: ${Bun.version}`,
    `  command line: ${requested.join(' ')}`,
    `  ran in order: ${observed.join(' ')}`,
    '',
  ];

  if (observed.length !== FILES.length) {
    lines.push(
      `VERDICT: INCONCLUSIVE — expected ${FILES.length} markers, saw ${observed.length}.`,
      'The probe files must all run for this to mean anything.',
    );
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }

  const honoured = observed.join(' ') === requested.join(' ');
  lines.push(
    honoured
      ? 'VERDICT: bun test HONOURS the command-line order. A sorted file list would'
        + ' therefore pin the order, and docs/test-suite-policy.md should be revisited.'
      : 'VERDICT: bun test IGNORES the command-line order. Discovery order is the'
        + ' runner\'s own filesystem walk, so it cannot be pinned from outside'
        + ' and the only durable policy is to forbid cross-file process-global state.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(honoured ? 1 : 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
