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
//   QUEUE_KEY_ACTIVE_ID / QUEUE_KEY_RETIRING_ID + matching _SECRET vars
//                             (alternative to the JSON blob; rotation-friendly)
// Metrics: GET /metrics (bind to 127.0.0.1 or the internal network ONLY).
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mapKeyStore, type ProducerKey } from './auth.js';
import { QUEUE_BODY_MAX_BYTES } from './contract.js';
import { DEFAULT_RATE_LIMITS, handleQueueRequest, memoryRateLimiter, type QueueHttpRequest } from './api.js';
import { PgQueue, type QueueDb } from './pg.js';
import { collectQueueMetrics, recordApiEvent, renderPrometheus } from './metrics.js';

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
async function createDb(): Promise<QueueDb> {
  const url = process.env.QUEUE_DATABASE_URL;
  if (!url) throw new Error('QUEUE_DATABASE_URL is required');
  // Optional dep: declared in package.json; server refuses to boot without it.
  const mod = (await import('pg')) as unknown as {
    Pool: new (opts: { connectionString: string; max?: number }) => {
      query: (text: string, values?: unknown[]) => Promise<{ rows: never[]; rowCount: number }>;
    };
  };
  const pool = new mod.Pool({ connectionString: url, max: 10 });
  return {
    query: async (text, values) => {
      const r = await pool.query(text, values);
      return { rows: r.rows as never[], rowCount: r.rowCount ?? 0 };
    },
  };
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

export async function startQueueApi(port = Number(process.env.QUEUE_API_PORT ?? 4100)): Promise<void> {
  const keys = loadKeys();
  if (keys.length === 0) throw new Error('no producer keys configured (QUEUE_API_KEYS_JSON or QUEUE_API_KEY_ACTIVE_*)');
  const db = await createDb();
  const queue = new PgQueue(db);
  const limiter = memoryRateLimiter();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const snapshot = await collectQueueMetrics(db);
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(renderPrometheus(snapshot));
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
        onPublish: (info) => recordApiEvent(info),
      });
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: (err as Error).message, retryable: true, jobId: null } }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`[queue-api] listening on :${port} with ${keys.length} producer key(s)`);
}

// CLI entry: `bun src/queue/server.ts` (or node with type stripping).
const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  startQueueApi().catch((err) => {
    console.error(`[queue-api] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
