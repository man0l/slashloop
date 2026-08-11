// Tests for the Prisma DB URL builder — DB_CONNECTION_LIMIT must raise the
// pool size on the worker without editing the DATABASE_URL secret.
import { beforeEach, describe, expect, test } from 'bun:test';
import { effectiveDatabaseUrl } from './db.js';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@host:6543/db?pgbouncer=true&connection_limit=1';
});

describe('effectiveDatabaseUrl', () => {
  test('keeps the URL untouched when DB_CONNECTION_LIMIT is unset', () => {
    delete process.env.DB_CONNECTION_LIMIT;
    expect(effectiveDatabaseUrl()).toBe(process.env.DATABASE_URL!);
  });

  test('replaces an existing connection_limit when DB_CONNECTION_LIMIT is set', () => {
    process.env.DB_CONNECTION_LIMIT = '4';
    const url = effectiveDatabaseUrl()!;
    expect(url).toContain('connection_limit=4');
    expect(url).not.toContain('connection_limit=1');
  });

  test('appends connection_limit when the URL has none', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@host:6543/db';
    process.env.DB_CONNECTION_LIMIT = '4';
    expect(effectiveDatabaseUrl()).toBe('postgresql://u:p@host:6543/db?connection_limit=4');
  });

  test('ignores an invalid limit value', () => {
    process.env.DB_CONNECTION_LIMIT = 'abc';
    expect(effectiveDatabaseUrl()).toBe(process.env.DATABASE_URL!);
  });
});
