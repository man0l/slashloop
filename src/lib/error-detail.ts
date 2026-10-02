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
 * Best-effort human-readable detail for a caught value.
 *
 * Order matters: a stack is the most actionable, then a message, then whatever
 * the value stringifies to. Every step uses a truthiness test, never `??`, so
 * `''` and `0` fall through instead of being printed as the detail.
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack.trim() : '';
    if (stack) return stack;
    const message = typeof err.message === 'string' ? err.message.trim() : '';
    if (message) return message;
    return err.name || 'Error (no message)';
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
