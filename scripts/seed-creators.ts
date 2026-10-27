#!/usr/bin/env bun
// One-off seed for the /tools/tiktok/<handle>/ creator pages (SLA-1058).
//
// Picks the top creators by followers from the production D1 (creator Sources
// plus distinct Video.creatorHandle with creatorFollowers >= 10,000), then asks
// the MCP Worker to queue one `tools-profile` job per handle through the signed
// /api/tools/internal/refresh endpoint, one handle every 2s. The VPS job worker
// scrapes through the proxy (no Apify), and the result callback publishes each
// page that clears the indexability policy.
//
//   TOOLS_CALLBACK_SECRET=... bun scripts/seed-creators.ts [--dry-run] [--limit 500] [--delay-ms 2000]
//
// Needs wrangler auth for the D1 read (CLOUDFLARE_API_TOKEN) unless --handles-file is given.
// MCP_URL overrides the target Worker (default https://mcp.slashloop.dev).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { normalizeHandle } from '../src/lib/tools-handle.js';
import { producerSignature } from '../src/queue/producer.js';

const REFRESH_PATH = '/api/tools/internal/refresh';
const MIN_FOLLOWERS = 10_000;

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const candidatesSql = (limit: number): string => `
SELECT handle, MAX(followers) AS followers FROM (
  SELECT lower(creatorHandle) AS handle, MAX(creatorFollowers) AS followers
    FROM Video WHERE platform = 'tiktok' AND creatorFollowers >= ${MIN_FOLLOWERS} GROUP BY 1
  UNION ALL
  SELECT lower(ltrim(query, '@')) AS handle, 0 AS followers
    FROM Source WHERE platform = 'tiktok' AND sourceType = 'creator'
) GROUP BY handle ORDER BY followers DESC LIMIT ${Math.floor(limit * 1.2)}`;

function readCandidates(limit: number, handlesFile: string | undefined): string[] {
  let raw: string[];
  if (handlesFile) {
    raw = readFileSync(handlesFile, 'utf8').split(/\s+/);
  } else {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'slashloop', '--remote', '--json', '--command', candidatesSql(limit)], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(out) as Array<{ results: Array<{ handle: string }> }>;
    raw = parsed[0].results.map((r) => r.handle);
  }
  const seen = new Set<string>();
  for (const h of raw) {
    const n = normalizeHandle(h);
    if (n) seen.add(n);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

async function post(base: string, secret: string, body: unknown): Promise<Record<string, unknown>> {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const res = await fetch(`${base}${REFRESH_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slq-timestamp': ts,
      'x-slq-nonce': nonce,
      'x-slq-signature': await producerSignature(secret, 'POST', REFRESH_PATH, ts, nonce, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`refresh endpoint answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = args.includes('--dry-run');
  const limit = Number(flag('--limit') ?? 500);
  const delayMs = Number(flag('--delay-ms') ?? 2000);
  const base = (process.env.MCP_URL ?? 'https://mcp.slashloop.dev').replace(/\/$/, '');
  const secret = process.env.TOOLS_CALLBACK_SECRET?.trim();

  const handles = readCandidates(limit, flag('--handles-file'));
  console.log(`[seed] ${handles.length} candidate handles`);
  if (dryRun) {
    console.log(handles.slice(0, 20).join('\n'));
    return;
  }
  if (!secret) throw new Error('TOOLS_CALLBACK_SECRET is required');

  const week = isoWeek(new Date());
  const tally = { published: 0, deduped: 0, failed: 0 };
  for (const [i, handle] of handles.entries()) {
    try {
      const r = await post(base, secret, { week, reason: 'seed', handles: [handle] });
      tally.published += Number(r.published ?? 0);
      tally.deduped += Number(r.deduped ?? 0);
      tally.failed += Number(r.failed ?? 0);
    } catch (err) {
      tally.failed++;
      console.warn(`[seed] ${handle}: ${(err as Error).message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`[seed] ${i + 1}/${handles.length} ${JSON.stringify(tally)}`);
    if (i < handles.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`[seed] done ${JSON.stringify(tally)}`);
}

if (import.meta.main) await main();
