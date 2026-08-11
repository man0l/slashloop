import { PrismaClient } from '@prisma/client';

/**
 * The worker (VPS, two containers) must multi-task on the shared pool
 * (prisma.pgbouncer uses one shared connection per Deployment/MaybeTimeout),
 * but Vercel's per-request MCP is fine with 1. DB_CONNECTION_LIMIT lets a
 * deploy raise the pool size without editing the DATABASE_URL secret; both
 * slashloop-worker services set it to 4 in docker-compose.prod.yml.
 */
export function effectiveDatabaseUrl(): string {
  const limit = process.env.DB_CONNECTION_LIMIT;
  const url = process.env.DATABASE_URL;
  if (!url || !limit) return url ?? '';
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return url;
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('connection_limit', String(n));
  return `${base}?${params.toString()}`;
}
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: effectiveDatabaseUrl() } },
    log: process.env.PRISMA_LOG === '1' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
