// ---------------------------------------------------------------------------
// Refresh log lines: informational notes vs real failures.
//
// RefreshRun.errorsJson is the audit log of a refresh — it deliberately holds
// BOTH the things that went wrong ("Scoring failed", an Apify notice) and the
// things that merely happened ("Refresh policy: mode=incremental limit=5",
// "Already known: 1/3 results were existing videos"). Keeping the second kind
// is worth it for support: it is how a policy regression or a mysteriously 0c
// run gets diagnosed after the fact.
//
// What it is NOT worth is showing that bookkeeping to the user as a warning.
// A source whose refresh worked perfectly was rendering a red "last refresh
// had errors" badge because the run wrote down which page size it chose.
//
// So: informational lines are tagged with INFO_PREFIX at write time, stay in
// the DB, and are filtered out of anything user-facing. isInfoNote() also
// recognises the untagged shapes written before this existed, so history in
// the database doesn't keep raising false alarms.
// ---------------------------------------------------------------------------

/** Marker written in front of every non-failure log line. */
export const INFO_PREFIX = '[info] ';

/** Tag a line as informational (kept in the DB, never shown as a warning). */
export function infoNote(message: string): string {
  return message.startsWith(INFO_PREFIX) ? message : INFO_PREFIX + message;
}

/**
 * Untagged informational lines written by older builds. Matched by prefix so
 * rows already in the database stop surfacing as warnings after this ships.
 */
const LEGACY_INFO_PREFIXES = [
  'Refresh policy:',
  'Recency filter:',
  'Per-source watermark:',
  'Already known:',
  'Multi-tenant batch:',
  'Resumed dataset ',
  'Creator baselines:',
];

/** True when a log line is bookkeeping rather than a failure. */
export function isInfoNote(line: string): boolean {
  if (line.startsWith(INFO_PREFIX)) return true;
  // The connector's older marker for "this is a notice, not a failure".
  if (line.includes('(cosmetic only)')) return true;
  if (LEGACY_INFO_PREFIXES.some(p => line.startsWith(p))) return true;
  // "Thumbnail ingest: N beyond the per-run cap ... queued as thumb jobs" is a
  // deferral, not a failure — unlike "Thumbnail ingest: 2/5 failed".
  if (line.startsWith('Thumbnail ingest:') && line.includes('beyond the per-run cap')) return true;
  return false;
}

/** The failure lines only — what a user should ever be shown. */
export function failureLines(lines: string[]): string[] {
  return lines.filter(l => !isInfoNote(l));
}

/** The informational lines only, marker stripped — for log/debug surfaces. */
export function infoLines(lines: string[]): string[] {
  return lines.filter(isInfoNote).map(stripInfoPrefix);
}

/** Strip the marker for display/log output. */
export function stripInfoPrefix(line: string): string {
  return line.startsWith(INFO_PREFIX) ? line.slice(INFO_PREFIX.length) : line;
}
