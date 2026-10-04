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
 * A Cloudflare D1 / Prisma driver adapter error (or anything else) carries its
 * real cause object on `error.cause` — the `kind` / `extendedCode` / message
 * of the underlying driver failure. Print it inline (one line each) so the
 * failure is diagnosable without a rebuild. Bounded depth so a pathological
 * cause chain cannot recurse forever.
 */
function causeChain(err: Error, depth = 5): string[] {
  const parts: string[] = [];
  let cur: unknown = err.cause;
  let guard = 0;
  while (cur !== undefined && parts.length < depth && guard++ < depth + 1) {
    if (cur instanceof Error) {
      const head = `${cur.name}: ${cur.message}`.trim();
      const ref = referenceId(cur.message, cur);
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
 * The `reference = e_...` id that D1/Prisma adapters attach to their errors —
 * the handle for the provider's own error log. Promote it so it survives
 * single-line truncation (errorMessage keeps the head, where it now sits).
 */
function referenceId(message: string | undefined, err: unknown): string | undefined {
  const fromMessage = /reference\s*=\s*(e_[A-Za-z0-9_]+)/.exec(message ?? '')?.[1];
  if (fromMessage) return fromMessage;
  const e = err as Record<string, unknown> | undefined;
  for (const key of ['reference', 'refId', 'ref']) {
    const v = e?.[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Best-effort human-readable detail for a caught value.
 *
 * Order matters: a stack is the most actionable, then a message, then whatever
 * the value stringifies to. Every step uses a truthiness test, never `??`, so
 * `''` and `0` fall through instead of being printed as the detail.
 *
 * For an Error, the cause chain (and its reference id, if any) is appended
 * AFTER the stack/message: the head line keeps its existing shape, and
 * errorMessage's first-line truncation still carries name + message + reference.
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const extras = causeChain(err);
    const head = referenceId(err.message, err);
    if (head && !err.message.includes(`reference = ${head}`)) {
      extras.push(`reference=${head}`);
    }
    const suffix = extras.length ? `\n${extras.map((p) => `cause: ${p}`).join('\n')}` : '';
    const stack = typeof err.stack === 'string' ? err.stack.trim() : '';
    if (stack) return `${stack}${suffix}`;
    const message = typeof err.message === 'string' ? err.message.trim() : '';
    if (message) return `${message}${suffix}`;
    return (err.name || 'Error (no message)') + suffix;
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
 * its own prefix. A stack's frames are dropped rather than wrapped.
 */
export function errorMessage(err: unknown): string {
  return errorDetail(err).split('\n', 1)[0]!;
}
