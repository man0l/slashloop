// ---------------------------------------------------------------------------
// Best-effort async log shipping from the VPS worker to indiestack.
// POSTs one JSON object per console line:
//   { service, host, ts, level, message }
//
// Fail-open by construction — a dead/slow endpoint must never affect the
// worker loop:
//
//   * disabled entirely when INDIESTACK_LOG_URL is unset (zero overhead,
//     zero behaviour change)
//   * console interception calls through to the originals first, so
//     `docker logs` keeps working exactly as before
//   * bounded in-memory buffer (oldest dropped past the cap — memory cannot
//     grow, even if the endpoint is down for days)
//   * background interval flush that nothing awaits; each flush is
//     try/caught with a short per-request timeout, and failed lines are
//     dropped, not retried into an ever-growing backlog
//
// Bun/Node only. Never imported by the Cloudflare Worker.
// ---------------------------------------------------------------------------

import { hostname } from 'node:os';

/** Longest single message kept; TikTok API error dumps can run to KBs. */
const MAX_MESSAGE_CHARS = 2000;
/** Most entries retained between flushes (memory bound). */
const MAX_BUFFER_ENTRIES = 400;
/** Entries shipped per flush at most (keeps the burst small). */
const MAX_ENTRIES_PER_FLUSH = 30;
/** Parallel POSTs per flush at most. */
const FLUSH_CONCURRENCY = 4;

const POST_TIMEOUT_MS = 10_000;

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  ts: number;
}

export interface LogShipper {
  /** Append one entry (drops oldest past the cap). */
  push(level: LogLevel, message: string): void;
  /** Ship one batch now. Never throws. */
  flush(): Promise<void>;
  /** Buffered entry count (tests/diagnostics). */
  size(): number;
}

/**
 * The `reference = e_...` id D1/Prisma driver adapters attach to their errors
 * — the handle into the provider's own error log. Surfaced explicitly so it
 * survives both the one-line shipper view and `errorMessage` first-line
 * truncation (SLA-386: it used to live only inside the dropped `%O` object).
 */
function referenceId(err: Error): string | undefined {
  const fromMessage = /reference\s*=\s*(e_[A-Za-z0-9_]+)/.exec(err.message ?? '')?.[1];
  if (fromMessage) return fromMessage;
  const cand = err as unknown as Record<string, unknown>;
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

/** One compact rendering of an Error's cause chain (empty array when none). */
function causeChain(err: Error): string[] {
  const parts: string[] = [];
  let cur: unknown = err.cause;
  while (cur !== undefined && parts.length < 3) {
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
  while (argIndex < args.length) out += ` ${formatArg(args[argIndex])}`;
  return out;
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
  const usesSpecs = args.length > 1 && typeof args[0] === 'string' && /%[sdifjoOc%]/.test(args[0]);
  const text = usesSpecs ? expandSpecs(args[0] as string, args.slice(1)) : args.map(formatArg).join(' ');
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

export interface ShipperOptions {
  url: string;
  service: string;
  host?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createLogShipper(opts: ShipperOptions): LogShipper {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const host = opts.host ?? safeHostname();
  const buf: LogEntry[] = [];
  let flushing = false;

  function postOne(entry: LogEntry): Promise<void> {
    const controller = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(POST_TIMEOUT_MS) : undefined;
    return fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: opts.service,
        host,
        ts: new Date(entry.ts).toISOString(),
        level: entry.level === 'log' ? 'info' : entry.level,
        message: entry.message,
      }),
      ...(controller ? { signal: controller } : {}),
    }).then(
      () => undefined,
      () => undefined, // failed lines are dropped, never requeued
    );
  }

  return {
    push(level: LogLevel, message: string): void {
      buf.push({ level, message, ts: now() });
      while (buf.length > MAX_BUFFER_ENTRIES) buf.shift();
    },

    size(): number {
      return buf.length;
    },

    async flush(): Promise<void> {
      if (flushing || buf.length === 0) return;
      flushing = true;
      try {
        const batch = buf.splice(0, Math.min(buf.length, MAX_ENTRIES_PER_FLUSH));
        for (let i = 0; i < batch.length; i += FLUSH_CONCURRENCY) {
          await Promise.all(batch.slice(i, i + FLUSH_CONCURRENCY).map(postOne));
        }
      } catch {
        // Never let shipping throw into the worker loop.
      } finally {
        flushing = false;
      }
    },
  };
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

type ConsoleMethod = 'log' | 'warn' | 'error';

let installed = false;

/**
 * Wire console.* through the shipper and start the background flush loop.
 * Idempotent. No-op when INDIESTACK_LOG_URL is unset. The loop is unref'd
 * so it never keeps the process alive on its own.
 */
export function initLogShipping(kinds: string[]): void {
  if (installed) return;
  installed = true;
  const url = (process.env.INDIESTACK_LOG_URL ?? '').trim();
  if (!url) return;

  const shipper = createLogShipper({ url, service: `slashloop-worker:${kinds.join(',') || 'all'}` });
  const originals: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  (Object.keys(originals) as ConsoleMethod[]).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      try {
        originals[level](...args);
      } catch {
        // stdout gone (daemon teardown) — still buffer nothing, just return.
        return;
      }
      try {
        shipper.push(level, formatMessage(args));
      } catch {
        // Buffering must never break logging.
      }
    };
  });

  const intervalMs = Number(process.env.INDIESTACK_LOG_INTERVAL_MS ?? 30_000);
  const every = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;
  const timer = setInterval(() => {
    void shipper.flush();
  }, every);
  // Unref so a hung endpoint can't hold the event loop past shutdown — and
  // so the timer itself never delays the SIGTERM exit path.
  (timer as unknown as { unref?: () => void }).unref?.();
}
