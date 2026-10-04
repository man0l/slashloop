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

  // SLA-386: a DriverAdapterError's real detail lives on `error.cause` and its
  // provider handle in a `reference = e_...` id. errorDetail must surface both
  // so the next D1 blip is diagnosable from the log.
  test('appends the cause chain and the provider reference id', () => {
    const ref = 'e_PVSMDp_9815dd15af20413aa71d75290955446f';
    const cause = { kind: 'sqlite', extendedCode: 1, message: 'internal error' };
    const err = new Error(`internal error; reference = ${ref}`);
    err.name = 'DriverAdapterError';
    err.cause = cause;

    const detail = errorDetail(err);
    expect(detail).toContain('internal error');
    expect(detail).toContain(ref);
    // the driver cause object is rendered, not dropped
    expect(detail).toContain('sqlite');
    // the cause is labelled, so it reads as a cause, not the head message
    expect(detail).toMatch(/cause:/);
  });

  test('a cause with its own reference id is surfaced too', () => {
    const causeRef = 'e_abc123';
    const cause = new Error(`boom; reference = ${causeRef}`);
    cause.name = 'HttpError';
    const err = new Error('outer failure');
    err.name = 'DriverAdapterError';
    err.cause = cause;

    const detail = errorDetail(err);
    expect(detail).toContain(causeRef);
    expect(detail).toContain('HttpError: boom');
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
