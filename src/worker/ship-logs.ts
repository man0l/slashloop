// ---------------------------------------------------------------------------
// Best-effort async log shipping from the VPS worker to indiestack.
// POSTs buffered console output to INDIESTACK_LOG_URL (full /log/<token> URL).
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
//     try/caught with a short timeout, and a failed batch is dropped, not
//     retried into an ever-growing backlog
//   * bodies are measured to stay under indiestack's 8KB cap
//
// Bun/Node only. Never imported by the Cloudflare Worker.
// ---------------------------------------------------------------------------

import { hostname } from 'node:os';

/** indiestack keeps 8KB per POST — stay comfortably under it. */
const MAX_BODY_BYTES = 7 * 1024;
/** Longest single line kept; TikTok API error dumps can run to KBs. */
const MAX_LINE_CHARS = 500;
/** Most lines retained between flushes (memory bound). */
const MAX_BUFFER_LINES = 400;
/** Lines per POST at most (with truncation above, always under the byte cap). */
const MAX_LINES_PER_POST = 40;

const FLUSH_TIMEOUT_MS = 10_000;

export interface LogShipper {
  /** Append one pre-formatted line (drops oldest past the cap). */
  push(line: string): void;
  /** Send one batch now. Never throws. */
  flush(): Promise<void>;
  /** Buffered line count (tests/diagnostics). */
  size(): number;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    const s = JSON.stringify(arg);
    return typeof s === 'string' ? s : String(arg);
  } catch {
    return String(arg);
  }
}

/** One console call → one line, truncated. Pure (unit-tested). */
export function formatLine(level: string, args: unknown[]): string {
  const text = args.map(formatArg).join(' ');
  const line = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
  return level === 'log' ? line : `[${level}] ${line}`;
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
  const buf: string[] = [];
  let flushing = false;

  function buildBody(lines: string[]): string {
    return JSON.stringify({
      service: opts.service,
      host: opts.host ?? safeHostname(),
      ts: new Date(now()).toISOString(),
      lines,
    });
  }

  return {
    push(line: string): void {
      buf.push(line);
      while (buf.length > MAX_BUFFER_LINES) buf.shift();
    },

    size(): number {
      return buf.length;
    },

    async flush(): Promise<void> {
      if (flushing || buf.length === 0) return;
      flushing = true;
      try {
        // Shift only what fits this post; the rest waits for the next tick
        // (still bounded by the push-time cap).
        const overhead = Buffer.byteLength(buildBody([]));
        const batch: string[] = [];
        let bytes = overhead;
        while (buf.length > 0 && batch.length < MAX_LINES_PER_POST) {
          const lb = Buffer.byteLength(buf[0]!) + 3; // quotes + comma/edge
          if (bytes + lb > MAX_BODY_BYTES && batch.length > 0) break;
          bytes += lb;
          batch.push(buf.shift()!);
        }
        if (batch.length === 0) return;
        const controller = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FLUSH_TIMEOUT_MS) : undefined;
        await fetchImpl(opts.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: buildBody(batch),
          ...(controller ? { signal: controller } : {}),
        }).catch(() => null);
        // Response intentionally ignored: ok or not, the batch is dropped.
        // Retrying a dead endpoint would backlog memory; the next tick ships
        // fresh lines instead.
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
        shipper.push(formatLine(level, args));
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
