// Unit tests for Gemini error classification — pure string parsing, no network
// or DB. `bun test`.
import { describe, expect, test } from 'bun:test';
import {
  classifyGeminiError,
  errorCodeFor,
  tagJobFailure,
  parseJobLastError,
  friendlyGeminiMessage,
} from './gemini-errors.js';

describe('classifyGeminiError', () => {
  test('429 RESOURCE_EXHAUSTED -> quota, retryable', () => {
    const info = classifyGeminiError(new Error('Gemini generateContent failed (429): {"error":{"status":"RESOURCE_EXHAUSTED"}}'));
    expect(info.category).toBe('quota');
    expect(info.retryable).toBe(true);
  });

  test('"quota exceeded" text -> quota', () => {
    const info = classifyGeminiError(new Error('Gemini text API error 429: quota exceeded for model'));
    expect(info.category).toBe('quota');
    expect(errorCodeFor(info.category)).toBe('gemini_quota');
  });

  test('bare (429) with no qualifier -> quota (assume key budget spent)', () => {
    const info = classifyGeminiError(new Error('Gemini upload failed (429): too many requests'));
    expect(info.category).toBe('quota');
  });

  test('RATE_LIMIT_EXCEEDED -> rate_limit, still retryable', () => {
    const info = classifyGeminiError(new Error('Gemini text API error 429: RATE_LIMIT_EXCEEDED'));
    expect(info.category).toBe('rate_limit');
    expect(info.retryable).toBe(true);
  });

  test('403 invalid API key -> auth, NOT retryable', () => {
    const info = classifyGeminiError(new Error('Gemini generateContent failed (403): API key not valid'));
    expect(info.category).toBe('auth');
    expect(info.retryable).toBe(false);
  });

  test('400 INVALID_ARGUMENT -> invalid_request, NOT retryable', () => {
    const info = classifyGeminiError(new Error('Gemini generateContent failed (400): INVALID_ARGUMENT'));
    expect(info.category).toBe('invalid_request');
    expect(info.retryable).toBe(false);
  });

  test('500 -> server, retryable', () => {
    const info = classifyGeminiError(new Error('Gemini generateContent failed (500): internal error'));
    expect(info.category).toBe('server');
    expect(info.retryable).toBe(true);
  });

  test('503 UNAVAILABLE -> server, retryable', () => {
    const info = classifyGeminiError(new Error('Gemini text API error 503: UNAVAILABLE'));
    expect(info.category).toBe('server');
    expect(info.retryable).toBe(true);
  });

  test('timeout -> timeout, retryable', () => {
    const info = classifyGeminiError(new Error('Gemini file processing timed out after 60s'));
    expect(info.category).toBe('timeout');
    expect(info.retryable).toBe(true);
  });

  test('OpenRouter balance-for-video 402 -> quota, retryable', () => {
    const info = classifyGeminiError(new Error('OpenRouter API error 402: This request requires at least $1.00 in balance for video'));
    expect(info.category).toBe('quota');
    expect(info.retryable).toBe(true);
    expect(errorCodeFor(info.category)).toBe('gemini_quota');
  });

  test('unrelated failure (Apify download) -> unknown, maps to "other"', () => {
    const info = classifyGeminiError(new Error('Downloaded file too small'));
    expect(info.category).toBe('unknown');
    expect(info.retryable).toBe(false);
    expect(errorCodeFor(info.category)).toBe('other');
  });

  test('non-Error input is handled as a string', () => {
    const info = classifyGeminiError('boom');
    expect(info.message).toBe('boom');
    expect(info.category).toBe('unknown');
  });
});

describe('tagJobFailure / parseJobLastError round-trip', () => {
  test('tag prefixes the code and keeps the raw message', () => {
    const raw = 'Gemini generateContent failed (429): RESOURCE_EXHAUSTED';
    const tagged = tagJobFailure(new Error(raw));
    expect(tagged.startsWith('[gemini_quota] ')).toBe(true);
    expect(tagged).toContain(raw);
  });

  test('parseJobLastError recovers the code and the original message', () => {
    const raw = 'Gemini generateContent failed (429): RESOURCE_EXHAUSTED';
    const parsed = parseJobLastError(tagJobFailure(new Error(raw)));
    expect(parsed).toEqual({ errorCode: 'gemini_quota', message: raw });
  });

  test('untagged messages parse as "other" and pass the text through', () => {
    const parsed = parseJobLastError('Downloaded file too small');
    expect(parsed).toEqual({ errorCode: 'other', message: 'Downloaded file too small' });
  });

  test('null lastError -> null', () => {
    expect(parseJobLastError(null)).toBeNull();
  });
});

describe('friendlyGeminiMessage', () => {
  test('quota has a user-facing, non-technical label', () => {
    const msg = friendlyGeminiMessage('gemini_quota');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.toLowerCase()).toContain('credits');
  });

  test('unknown code falls back to the detail message', () => {
    expect(friendlyGeminiMessage('other', 'Downloaded file too small')).toBe('Downloaded file too small');
  });
});
