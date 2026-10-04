// ---------------------------------------------------------------------------
// One readable string for anything a `catch` can receive.
//
// SLA-141. The worker logged
//
//   [worker] experiment tick failed (streak 1, next attempt in ~5s):
//
// in production — a failure report with no detail at all — because the site was
// `err.stack ?? err.message`. `??` only falls through on null/undefined, and a
// real Error can carry an EMPTY STRING for either field, so the log line ended
// at the colon. The same trap sits behind `(err as Error).message`, which is
// `undefined` for every non-Error throw and renders as "undefined".
//
// Nothing here changes control flow. It only makes a caught value legible, so
// the next occurrence is diagnosable from the log instead of from a rebuild.
// ---------------------------------------------------------------------------

/**
 * The `reference = e_...` id that D1/Prisma adapters attach to their errors —
 * the handle for the provider's own error log. Found on the error's message,
 * on its own fields, or on its cause, so it survives even when the id only
 * lives in the cause object (which the old shipper dropped entirely). Promoted
 * into the head line so single-line truncation (errorMessage) still carries it.
 *
 * Exported and shared with the shipper (ship-logs.ts) so the two render the id
 * identically instead of drifting.
 */
export function referenceId(err: unknown): string | undefined {
  const message =
    typeof err === 'string' ? err
    : err instanceof Error ? (err.message ?? '')
    : '';
  const fromMessage = /reference\s*=\s*(e_[A-Za-z0-9_]+)/.exec(message)?.[1];
  if (fromMessage) return fromMessage;
  const cand = (err ?? {}) as Record<string, unknown>;
  const sources = [cand, cand.cause as Record<string, unknown> | undefined];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    for (const key of ['reference', 'refId', 'ref']) {
      const v = s[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  return undefined;
}

/**
 * A Cloudflare D1 / Prisma driver adapter error (or anything else) carries its
 * real cause object on `error.cause` — the `kind` / `extendedCode` / message
 * of the underlying driver failure. Print it inline (one line each) so the
 * failure is diagnosable without a rebuild. Bounded depth so a pathological
 * cause chain cannot recurse forever.
 *
 * Exported and shared with the shipper (ship-logs.ts) — previously each file
 * carried its own copy with a different depth cap, which would drift.
 */
export function causeChain(err: Error, depth = 5): string[] {
  const parts: string[] = [];
  let cur: unknown = err.cause;
  let guard = 0;
  while (cur !== undefined && parts.length < depth && guard++ < depth + 1) {
    if (cur instanceof Error) {
      const head = `${cur.name}: ${cur.message}`.trim();
      const ref = referenceId(cur);
      parts.push(ref ? `${head} (reference=${ref})` : head);
      cur = cur.cause;
    } else {
      try {
        const s = JSON.stringify(cur);
        if (s && s !== '{}') parts.push(s);
      } catch {
        const s = String(cur);
        if (s && s !== 'undefined') parts.push(s);
      }
      break;
    }
  }
  return parts;
}

/**
 * Best-effort human-readable detail for a caught value.
 *
 * Order matters: a stack is the most actionable, then a message, then whatever
 * the value stringifies to. Every step uses a truthiness test, never `??`, so
 * `''` and `0` fall through instead of being printed as the detail.
 *
 * For an Error the cause chain is appended AFTER the stack/message as `cause:`
 * lines, and the error's provider reference id is promoted onto the HEAD line
 * (`name: message (reference=e_…)`). That keeps errorMessage — the first line
 * of this — carrying name + message + reference even when the id is not
 * already in err.message (SLA-386: it used to live only inside the dropped
 * `%O` object, so the one-line warns shipped `DriverAdapterError: internal
 * error` with no id).
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const extras = causeChain(err);
    const ref = referenceId(err);
    const suffix = extras.length ? `\n${extras.map((p) => `cause: ${p}`).join('\n')}` : '';
    const stack = typeof err.stack === 'string' ? err.stack.trim() : '';
    const message = typeof err.message === 'string' ? err.message.trim() : '';
    const base = stack || message || (err.name || 'Error (no message)');
    const headLines = base.split('\n');
    if (ref && !headLines[0].includes(ref)) headLines[0] += ` (reference=${ref})`;
    return `${headLines.join('\n')}${suffix}`;
  }
  if (typeof err === 'string') return err.trim() || '(empty string)';
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  try {
    const text = JSON.stringify(err);
    if (text && text !== '{}') return text;
  } catch {
    // Circular / non-serialisable: fall through to String().
  }
  const text = String(err);
  return text || '(unprintable thrown value)';
}

/**
 * The single-line form: first line of errorDetail, for a line that already has
 * its own prefix. A stack's frames are dropped rather than wrapped. Because
 * errorDetail puts the provider reference id on that first line, this carries
 * `name: message (reference=e_…)` for D1 adapter errors.
 */
export function errorMessage(err: unknown): string {
  return errorDetail(err).split('\n', 1)[0]!;
}
