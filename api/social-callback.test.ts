import { describe, expect, test } from 'bun:test';
import { safeHandle } from './social-callback.js';

describe('social callback safeHandle', () => {
  test('keeps platform handles and strips everything else', () => {
    expect(safeHandle('@my.handle_1')).toBe('my.handle_1');
    expect(safeHandle('<script>alert(1)</script>')).toBe('scriptalert1script');
    expect(safeHandle('a'.repeat(100))).toHaveLength(64);
    expect(safeHandle('')).toBe('');
  });
});
