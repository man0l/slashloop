// Workflow log monitor — level-filtered error/warning report for CI runs.
//
// Problem: GitHub keeps raw Actions logs per run with no level filtering and
// no cross-run search. This script turns the log captured during the workflow
// (every `run:` step tees stdout/stderr to $WORKFLOW_LOG) into:
//   1. a Job Summary section on the run page (counts + excerpts — the place
//      you scan first, next to the failed step), and
//   2. filtered artifacts (workflow-errors.log / workflow-warnings.log) plus
//      the full capture, for download / `gh run download`.
//
// Level setting: $WORKFLOW_LOG_LEVEL (or first CLI arg) — one of:
//   error → errors only · warn → warnings + errors (default) · info|all → all.
// Wire it to a repo/environment VARIABLE so it can be changed without a code
// push, e.g. `WORKFLOW_LOG_LEVEL: ${{ vars.WORKFLOW_LOG_LEVEL || 'warn' }}`.
//
// Classification is heuristic (regex over the stripped line): error-like =
// error|failed|failure|✘|exception|traceback; warn-like = warn(ing)|⚠|deprecat.
// Everything else counts as info. Monitoring must never fail the build, so
// every failure path below degrades to a summary note and exit 0.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ANSI_RE = /(?:\u001b)?\[[0-9;]*[mK]/g;
const ERROR_RE = /\berror\b|failed|failure|✘|\bexception\b|traceback|error:/i;
const WARN_RE = /\bwarn(ing)?\b|⚠|deprecat/i;

const MAX_EXCERPT = 30; // lines per level shown in the summary
const MAX_FILE_LINES = 5000; // bound on artifact files
const MAX_LINE_LEN = 500;

const level = (process.argv[2] ?? process.env.WORKFLOW_LOG_LEVEL ?? 'warn')
  .trim()
  .toLowerCase();
const logFile =
  process.argv[3] ?? process.env.WORKFLOW_LOG ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'workflow.log');
const outDir = dirname(logFile);
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const outputFile = process.env.GITHUB_OUTPUT;

function clean(line) {
  return line.replace(ANSI_RE, '').slice(0, MAX_LINE_LEN);
}

function classify(line) {
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  return 'info';
}

function main() {
  if (!existsSync(logFile)) {
    const note = `### Workflow log monitor\nNo captured log at \`${logFile}\` — steps may not have run yet.\n`;
    if (summaryFile) appendFileSync(summaryFile, note);
    else process.stdout.write(note);
    return;
  }

  const lines = readFileSync(logFile, 'utf8').split('\n');
  const errors = [];
  const warnings = [];
  for (const raw of lines) {
    const line = clean(raw);
    if (!line.trim()) continue;
    const kind = classify(line);
    if (kind === 'error') errors.push(line);
    else if (kind === 'warn') warnings.push(line);
  }

  // Filtered artifacts (always written — the level only gates the summary).
  writeFileSync(join(outDir, 'workflow-errors.log'), errors.slice(-MAX_FILE_LINES).join('\n') + '\n');
  writeFileSync(join(outDir, 'workflow-warnings.log'), warnings.slice(-MAX_FILE_LINES).join('\n') + '\n');

  const showErrors = level === 'error' || level === 'warn' || level === 'info' || level === 'all';
  const showWarnings = level === 'warn' || level === 'info' || level === 'all';
  const showAll = level === 'info' || level === 'all';

  const excerpt = (arr) => arr.slice(-MAX_EXCERPT).join('\n') || '(none)';
  const scopeNote =
    level === 'error' ? 'errors only'
    : level === 'warn' ? 'warnings + errors'
    : 'everything';

  const summary = [
    '### Workflow log monitor',
    `- level: \`${level}\` (showing ${scopeNote}) · scanned ${lines.length} lines · **${errors.length} errors, ${warnings.length} warnings**`,
    ...(showErrors ? ['<details><summary>Errors</summary>', '', '```', excerpt(errors), '```', '', '</details>'] : []),
    ...(showWarnings
      ? ['<details><summary>Warnings</summary>', '', '```', excerpt(warnings), '```', '', '</details>']
      : []),
    ...(showAll
      ? ['<details><summary>Full log tail</summary>', '', '```', lines.map(clean).slice(-MAX_EXCERPT).join('\n'), '```', '', '</details>']
      : []),
    '',
    'Full capture + filtered files are in the `workflow-logs-*` run artifact.',
    '',
  ].join('\n');

  if (summaryFile) appendFileSync(summaryFile, summary);
  else process.stdout.write(summary);

  if (outputFile) {
    appendFileSync(outputFile, `errors=${errors.length}\nwarnings=${warnings.length}\n`);
  }
}

try {
  main();
} catch (err) {
  const note = `### Workflow log monitor\nReporter failed (non-blocking): ${String(err).slice(0, 200)}\n`;
  try {
    if (summaryFile) appendFileSync(summaryFile, note);
    else process.stdout.write(note);
  } catch {
    /* last resort: stay silent, never fail the build */
  }
}
