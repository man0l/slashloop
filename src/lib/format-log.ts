// Pure console-args → single-line message formatter. Shared by the VPS log
// shipper (src/worker/ship-logs.ts) and the Cloudflare Worker console patch
// (src/cf/console-format.ts). No Node-only imports: it must bundle into the Worker.

import { causeChain, referenceId } from './error-detail.js';

/** Longest single message kept; TikTok API error dumps can run to KBs. */
const MAX_MESSAGE_CHARS = 2000;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    // Compact single-line form: `name: message`, then the cause chain and the
    // provider reference id (SLA-386). The full stack stays in `docker logs`
    // via the original console passthrough; indiestack gets the diagnostic
    // essentials on one line.
    const head = `${arg.name}: ${arg.message}`.trim();
    const extras = causeChain(arg);
    const ref = referenceId(arg);
    if (ref && !extras.some((p) => p.includes(`reference=${ref}`))) {
      extras.push(`reference=${ref}`);
    }
    return extras.length ? `${head} ${extras.join(' ')}` : head;
  }
  try {
    const s = JSON.stringify(arg);
    return typeof s === 'string' ? s : String(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Expand printf-style specifiers in the first arg against the rest, rendering
 * each substituted value through `formatArg` (so an Error becomes its compact
 * one-line form rather than a multi-line inspect that the char cap would clip
 * before the cause). Mirrors `util.format`'s directive set without its
 * single-quoting of string args. Unknown directives and `%%` pass through.
 */
function expandSpecs(spec: string, args: unknown[]): string {
  let out = '';
  let argIndex = 0;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === '%' && i + 1 < spec.length) {
      const next = spec[i + 1];
      if (next === '%') { out += '%'; i += 1; continue; }
      if (/^[sdifjoOc]$/.test(next)) {
        out += formatArg(args[argIndex]);
        argIndex += 1;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  while (argIndex < args.length) out += ` ${formatArg(args[argIndex++])}`;
  return out;
}

/** True when the first arg is a printf-style spec string with further args to substitute. */
export function hasPrintfSpecs(args: unknown[]): boolean {
  return args.length > 1 && typeof args[0] === 'string' && /%[sdifjoOc%]/.test(args[0]);
}

/**
 * Console args → one message string, truncated. Pure (unit-tested).
 *
 * When the first arg is a printf-style spec string with further args — the
 * shape the Prisma D1 adapter uses, `console.error("Error in performIO: %O",
 * err)` — the specifiers are expanded so `%O` renders the object instead of
 * shipping the literal `%O` with the detail object dropped. Error args become
 * their compact one-line form (name + message + cause + provider reference id,
 * SLA-386); the full stack stays in `docker logs` via the original console
 * passthrough.
 */
export function formatMessage(args: unknown[]): string {
  const text = hasPrintfSpecs(args) ? expandSpecs(args[0] as string, args.slice(1)) : args.map(formatArg).join(' ');
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}
