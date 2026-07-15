import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'file:/home/z/my-project/mcp-server/prisma/slashloop.db',
    },
  },
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;