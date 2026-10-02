// ---------------------------------------------------------------------------
// queue-api HTTP server — raw-body-preserving front end over api.ts.
//
// The service reads the exact raw bytes of the body end to end: no generic
// JSON parser is mounted over the signed routes (a re-serialized body would
// break raw-body HMAC). Bodies stream into a capped buffer (64 KiB + 1 byte
// overflow probe); anything larger short-circuits to 413 before auth.
//
// Runtime: plain node:http (works on Bun and Node). Env:
//   QUEUE_API_PORT            default 4100 (never exposed publicly; Traefik
//                             fronts it on queue.slashloop.dev)
//   QUEUE_DATABASE_URL        node-postgres connection string for queue-db
//   QUEUE_API_KEYS_JSON       [{"keyId","secret","state","workspaceIds"?}]
//   QUEUE_API_KEY_ACTIVE_ID / QUEUE_API_KEY_ACTIVE_SECRET (+ _RETIRING_* pair)
//                             (alternative to the JSON blob; rotation-friendly.
//                             Producer side mirrors with QUEUE_API_URL,
//                             QUEUE_API_KEY_ID, QUEUE_API_KEY_SECRET.)
// Metrics: GET /metrics (bind to 127.0.0.1 or the internal network ONLY).
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mapKeyStore, type ProducerKey } from './auth.js';
import { QUEUE_BODY_MAX_BYTES, queueError } from './contract.js';
import { DEFAULT_RATE_LIMITS, handleQueueRequest, memoryRateLimiter, type QueueHttpRequest } from './api.js';
import { PgQueue, type QueueDb } from './pg.js';
import { collectQueueMetrics, recordApiEvent, renderPrometheus } from './metrics.js';

/** Grace period for in-flight requests to drain before the process exits anyway. */
export const SHUTDOWN_GRACE_MS_DEFAULT = 5_000;

export function shutdownGraceMs(): number {
  const n = Number(process.env.QUEUE_SHUTDOWN_GRACE_MS ?? SHUTDOWN_GRACE_MS_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SHUTDOWN_GRACE_MS_DEFAULT;
}

/**
 * Settle window between marking draining and closing the listener: readiness
 * probers and keep-alive producers observe retryable 503s instead of refused
 * connections, so Traefik stops routing before the socket goes away.
 */
export const SHUTDOWN_SETTLE_MS_DEFAULT = 500;

export function shutdownSettleMs(): number {
  const n = Number(process.env.QUEUE_SHUTDOWN_SETTLE_MS ?? SHUTDOWN_SETTLE_MS_DEFAULT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SHUTDOWN_SETTLE_MS_DEFAULT;
}

export interface ShutdownController {
  /** True once a SIGTERM/SIGINT shutdown has started (readiness must fail). */
  isDraining(): boolean;
  /** Idempotent: first call drains, later calls return the same promise. */
  shutdown(signal: string): Promise<void>;
}

export interface ShutdownControllerOptions {
  closeServer: () => Promise<void>;
  closeDb: () => Promise<void>;
  exit?: (code: number) => void;
  graceMs?: number;
  settleMs?: number;
  log?: (msg: string) => void;
}

/**
 * Bounded graceful shutdown: marks draining (so /readyz fails), closes the
 * HTTP listener, then the DB pool, then exits 0. A grace timer forces exit(0)
 * so one stuck in-flight request can never hold a deploy open.
 */
export function createShutdownController(opts: ShutdownControllerOptions): ShutdownController {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const graceMs = opts.graceMs ?? shutdownGraceMs();
  const settleMs = Math.min(opts.settleMs ?? shutdownSettleMs(), graceMs);
  const log = opts.log ?? ((msg: string) => console.log(msg));
  let draining = false;
  let promise: Promise<void> | null = null;

  async function shutdown(signal: string): Promise<void> {
    if (promise) return promise;
    draining = true;
    log(`[queue-api] received ${signal} — draining, ${settleMs}ms settle, ${graceMs}ms grace`);
    promise = (async () => {
      const forced = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          log('[queue-api] shutdown grace exceeded — exiting anyway');
          resolve();
        }, graceMs);
        // Don't hold the event loop open on the timer alone.
        (t as unknown as { unref?: () => void }).unref?.();
      });
      const graceful = (async () => {
        // Let readiness probers + keep-alive producers observe 503s before
        // the listener goes away; in-flight requests keep their connections.
        if (settleMs > 0) await new Promise<void>((r) => setTimeout(r, settleMs));
        try {
          await opts.closeServer();
        } catch (err) {
          log(`[queue-api] server close failed: ${(err as Error).message}`);
        }
        try {
          await opts.closeDb();
        } catch (err) {
          log(`[queue-api] db close failed: ${(err as Error).message}`);
        }
      })();
      await Promise.race([graceful.then(() => undefined), forced]);
      exit(0);
    })();
    return promise;
  }

  return { isDraining: () => draining, shutdown };
}

/** Wire SIGTERM/SIGINT once: first signal drains, a second forces exit(1). */
export function installSignalHandlers(controller: ShutdownController, exit?: (code: number) => void): void {
  const doExit = exit ?? ((code: number) => process.exit(code));
  let secondaries = 0;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      secondaries += 1;
      if (secondaries > 1) {
        console.log(`[queue-api] received second ${sig} — exiting immediately`);
        doExit(1);
        return;
      }
      void controller.shutdown(sig);
    });
  }
}
function loadKeys(): ProducerKey[] {
  const raw = process.env.QUEUE_API_KEYS_JSON;
  if (raw) {
    const arr = JSON.parse(raw) as ProducerKey[];
    return arr.filter((k) => k.keyId && k.secret && k.state);
  }
  const keys: ProducerKey[] = [];
  const activeId = process.env.QUEUE_API_KEY_ACTIVE_ID;
  const activeSecret = process.env.QUEUE_API_KEY_ACTIVE_SECRET;
  if (activeId && activeSecret) keys.push({ keyId: activeId, secret: activeSecret, state: 'active' });
  const retiringId = process.env.QUEUE_API_KEY_RETIRING_ID;
  const retiringSecret = process.env.QUEUE_API_KEY_RETIRING_SECRET;
  if (retiringId && retiringSecret) {
    keys.push({ keyId: retiringId, secret: retiringSecret, state: 'retiring' });
  }
  return keys;
}

/** Minimal node-postgres-compatible pool, loaded lazily (no hard dep). */
async function createDb(): Promise<{ db: QueueDb; closeDb: () => Promise<void> }> {
  const url = process.env.QUEUE_DATABASE_URL;
  if (!url) throw new Error('QUEUE_DATABASE_URL is required');
  // Optional dep: declared in package.json; server refuses to boot without it.
  const mod = (await import('pg')) as unknown as {
    Pool: new (opts: { connectionString: string; max?: number }) => {
      query: (text: string, values?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>;
      end: () => Promise<void>;
    };
  };
  const pool = new mod.Pool({ connectionString: url, max: 10 });
  const db: QueueDb = {
    query: async (text, values) => {
      const r = await pool.query(text, values);
      return { rows: r.rows as never[], rowCount: r.rowCount ?? 0 };
    },
  };
  return { db, closeDb: () => pool.end() };
}

async function readRawBody(req: IncomingMessage): Promise<{ body: Uint8Array; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const cap = QUEUE_BODY_MAX_BYTES + 1;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > cap) return { body: Buffer.concat(chunks), truncated: true };
    chunks.push(buf);
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

export interface ServeQueueApiOptions {
  port?: number;
  host?: string;
  db: QueueDb;
  closeDb?: () => Promise<void>;
  keys: ProducerKey[];
  /** Override for tests; defaults to QUEUE_SHUTDOWN_GRACE_MS / 5000. */
  graceMs?: number;
  /** Override for tests; defaults to QUEUE_SHUTDOWN_SETTLE_MS / 500. */
  settleMs?: number;
  /** Default true. Tests pass false to avoid leaking process handlers. */
  installSignals?: boolean;
  exit?: (code: number) => void;
}

export interface ServedQueueApi {
  server: Server;
  port: number;
  shutdown: (signal: string) => Promise<void>;
  isDraining: () => boolean;
}

/**
 * Injectable serve path (no env reads except the grace default): production
 * goes through startQueueApi below; tests pass a stub db + ephemeral port.
 */
export async function serveQueueApi(opts: ServeQueueApiOptions): Promise<ServedQueueApi> {
  const { db, keys } = opts;
  const port = opts.port ?? Number(process.env.QUEUE_API_PORT ?? 4100);
  const closeDb = opts.closeDb ?? (async () => {});
  const queue = new PgQueue(db);
  const limiter = memoryRateLimiter();

  // Created up front so the SIGTERM handler can close it mid-listen.
  let server!: Server;
  const controller = createShutdownController({
    closeServer: () =>
      new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        // Drop idle keep-alive sockets (Traefik reuses them) so close()
        // resolves instead of waiting out the keep-alive timeout.
        (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    closeDb,
    exit: opts.exit,
    graceMs: opts.graceMs,
    settleMs: opts.settleMs,
  });
  const { isDraining } = controller;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const snapshot = await collectQueueMetrics(db);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(renderPrometheus(snapshot));
        return;
      }
      if (isDraining()) {
        // Liveness stays ok so the orchestrator doesn't SIGKILL us mid-drain;
        // readiness + new work fail fast with a retryable 503 instead of a
        // dropped connection at SIGKILL.
        if (req.method === 'GET' && url.pathname === '/healthz' && !url.search) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify(queueError('queue_unavailable', 'server is shutting down')));
        return;
      }
      const { body, truncated } = await readRawBody(req);
      const qreq: QueueHttpRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search ? url.search.slice(1) : '',
        headers: req.headers as Record<string, string | undefined>,
        rawBody: truncated ? new Uint8Array(QUEUE_BODY_MAX_BYTES + 1) : new Uint8Array(body),
      };
      const out = await handleQueueRequest(qreq, {
        queue,
        keys: mapKeyStore(keys),
        limiter,
        limits: DEFAULT_RATE_LIMITS,
        ping: async () => {
          await db.query('SELECT 1');
          return true;
        },
        nowSeconds: () => Math.floor(Date.now() / 1000),
        onOutcome: (info) => recordApiEvent(info),
      });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: (err as Error).message, retryable: true, jobId: null } }));
    }
  });

  await new Promise<void>((resolve) =>
    (opts.host ? server.listen(port, opts.host, resolve) : server.listen(port, resolve)),
  );
  const boundPort = (server.address() as { port?: number } | null)?.port ?? port;
  console.log(`[queue-api] listening on :${boundPort} with ${keys.length} producer key(s)`);
  if (opts.installSignals !== false) installSignalHandlers(controller, opts.exit);
  return { server, port: boundPort, shutdown: controller.shutdown, isDraining };
}

export async function startQueueApi(port = Number(process.env.QUEUE_API_PORT ?? 4100)): Promise<ServedQueueApi> {
  const keys = loadKeys();
  if (keys.length === 0) throw new Error('no producer keys configured (QUEUE_API_KEYS_JSON or QUEUE_API_KEY_ACTIVE_*)');
  const { db, closeDb } = await createDb();
  return serveQueueApi({ port, db, closeDb, keys });
}

// CLI entry: `bun src/queue/server.ts` (or node with type stripping).
const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  startQueueApi().catch((err) => {
    console.error(`[queue-api] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
