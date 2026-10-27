import { describe, expect, test } from 'bun:test';
import { candidatesSql, isoWeek } from './seed-creators.js';

describe('seed-creators helpers', () => {
  test('isoWeek follows ISO-8601 across year boundaries', () => {
    expect(isoWeek(new Date('2026-10-27T05:00:00Z'))).toBe('2026-W44');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });

  test('candidate SQL ranks by followers, applies the 10K floor and over-selects to survive dedupe', () => {
    const sql = candidatesSql(500);
    expect(sql).toContain('creatorFollowers >= 10000');
    expect(sql).toContain("sourceType = 'creator'");
    expect(sql).toContain('ORDER BY followers DESC LIMIT 600');
  });
});
