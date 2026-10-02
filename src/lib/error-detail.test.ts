import { describe, expect, test } from 'bun:test';

import { errorDetail, errorMessage } from './error-detail.js';

// SLA-141: the worker printed
//
//   [worker] experiment tick failed (streak 1, next attempt in ~5s):
//
// in production — no detail at all — because the site read
// `err.stack ?? err.message`. `??` only falls through on null/undefined, so an
// Error carrying an empty string for either field logged nothing. These pin
// every shape a catch can actually receive.
describe('errorDetail', () => {
  test('prefers the stack, which is what makes a worker failure diagnosable', () => {
    const err = new Error('boom');
    expect(err.stack).toBeTruthy();
    expect(errorDetail(err)).toBe(err.stack!);
    expect(errorDetail(err)).toContain('boom');
  });

  test('an Error with an EMPTY stack falls through to its message', () => {
    // The production shape: `??` stopped here and logged ''.
    const err = new Error('sqlite is locked');
    err.stack = '';
    expect(errorDetail(err)).toBe('sqlite is locked');
  });

  test('an Error with empty stack AND empty message still names something', () => {
    const err = new Error('');
    err.stack = '';
    expect(errorDetail(err)).toBe('Error');
    err.name = 'DbBusyError';
    expect(errorDetail(err)).toBe('DbBusyError');
  });

  test('a whitespace-only stack and message do not read as detail', () => {
    const err = new Error('   ');
    err.stack = '\n\n';
    expect(errorDetail(err)).toBe('Error');
  });

  test('a thrown string passes through, and an empty one is not blank', () => {
    expect(errorDetail('upstream 503')).toBe('upstream 503');
    expect(errorDetail('')).toBe('(empty string)');
  });

  test('null and undefined are named instead of stringifying to themselves silently', () => {
    expect(errorDetail(null)).toBe('null');
    expect(errorDetail(undefined)).toBe('undefined');
  });

  test('a plain object is serialised, so an AggregateError-like shape is readable', () => {
    expect(errorDetail({ code: 'E_PROXY', status: 429 })).toBe('{"code":"E_PROXY","status":429}');
  });

  test('an empty object does not print as {}', () => {
    expect(errorDetail({})).toBe('[object Object]');
  });

  test('a circular object still yields something', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorDetail(circular).length).toBeGreaterThan(0);
  });
});

describe('errorMessage', () => {
  test('collapses a stack to its first line so the prefix stays on one line', () => {
    const err = new Error('boom');
    expect(errorMessage(err)).toBe('Error: boom');
    expect(errorMessage(err)).not.toContain('\n');
  });

  test('still legible when the stack is empty', () => {
    const err = new Error('lease lost');
    err.stack = '';
    expect(errorMessage(err)).toBe('lease lost');
  });

  test('a thrown string is returned verbatim', () => {
    expect(errorMessage('rate limited')).toBe('rate limited');
  });
});
