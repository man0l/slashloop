// Unit tests for the OpenRouter adapter — pure parts (model mapping, content
// building, error classification), no network. `bun test`.
import { describe, expect, test } from 'bun:test';
import { modelToOpenRouter, buildUserContent, classifyOpenRouterError } from './openrouter.js';
import { tagJobFailure, parseJobLastError } from './gemini-errors.js';

describe('modelToOpenRouter', () => {
  test('maps every model we use to its OpenRouter id', () => {
    expect(modelToOpenRouter('gemini-3.5-flash')).toBe('google/gemini-3.5-flash');
    expect(modelToOpenRouter('gemini-3.5-flash-lite')).toBe('google/gemini-3.5-flash-lite');
    expect(modelToOpenRouter('gemini-3.6-flash')).toBe('google/gemini-3.6-flash');
    expect(modelToOpenRouter('gemini-3.1-flash-lite')).toBe('google/gemini-3.1-flash-lite');
    expect(modelToOpenRouter('gemini-2.5-flash')).toBe('google/gemini-2.5-flash');
    expect(modelToOpenRouter('gemini-2.5-flash-lite')).toBe('google/gemini-2.5-flash-lite');
    expect(modelToOpenRouter('gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
  });

  test('passes through already-qualified ids', () => {
    expect(modelToOpenRouter('google/gemini-3.5-flash')).toBe('google/gemini-3.5-flash');
  });

  test('throws for an unmapped model', () => {
    expect(() => modelToOpenRouter('gpt-4o')).toThrow(/No OpenRouter model mapping/);
  });
});

describe('buildUserContent', () => {
  test('plain string when no images', () => {
    expect(buildUserContent('hello', undefined)).toBe('hello');
  });

  test('rich content array with a base64 image part when images given', () => {
    const parts = buildUserContent('analyze this', [{ mimeType: 'image/jpeg', dataBase64: 'AAAA' }]) as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: 'analyze this' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  });
});

describe('classifyOpenRouterError', () => {
  const make = (status: number, body: string) => `OpenRouter API error ${status}: ${body}`;

  test('402 payment_required -> quota, retryable', () => {
    const c = classifyOpenRouterError(new Error(make(402, '{"error":{"message":"insufficient credits","code":402,"metadata":{"error_type":"payment_required"}}}')));
    expect(c.category).toBe('quota');
    expect(c.retryable).toBe(true);
  });

  test('200 status with error_type payment_required still -> quota', () => {
    const c = classifyOpenRouterError(new Error('OpenRouter API error 200: {"error":{"message":"out of credits","code":402,"metadata":{"error_type":"payment_required"}}}'));
    expect(c.category).toBe('quota');
  });

  test('429 rate_limit_exceeded -> rate_limit', () => {
    const c = classifyOpenRouterError(new Error(make(429, '{"error":{"code":429,"metadata":{"error_type":"rate_limit_exceeded"}}}')));
    expect(c.category).toBe('rate_limit');
    expect(c.retryable).toBe(true);
  });

  test('401 authentication -> auth, not retryable', () => {
    const c = classifyOpenRouterError(new Error(make(401, '{"error":{"code":401,"metadata":{"error_type":"authentication"}}}')));
    expect(c.category).toBe('auth');
    expect(c.retryable).toBe(false);
  });

  test('404 not_found -> invalid_request', () => {
    const c = classifyOpenRouterError(new Error(make(404, '{"error":{"code":404,"metadata":{"error_type":"not_found"}}}')));
    expect(c.category).toBe('invalid_request');
  });

  test('503 provider_overloaded -> server, retryable', () => {
    const c = classifyOpenRouterError(new Error(make(503, '{"error":{"code":503,"metadata":{"error_type":"provider_overloaded"}}}')));
    expect(c.category).toBe('server');
    expect(c.retryable).toBe(true);
  });

  test('500 -> server', () => {
    const c = classifyOpenRouterError(new Error(make(500, '{"error":{"code":500,"metadata":{"error_type":"server"}}}')));
    expect(c.category).toBe('server');
  });

  test('unrecognised -> unknown', () => {
    const c = classifyOpenRouterError(new Error('OpenRouter API error 418: {"error":{"code":418}}'));
    expect(c.category).toBe('unknown');
  });

  test('non-Error input handled', () => {
    expect(classifyOpenRouterError('boom').category).toBe('unknown');
  });
});

describe('gemini-errors integration (tag/parse with OpenRouter 402)', () => {
  test('payment_required -> [gemini_quota] tag round-trips', () => {
    const raw = 'OpenRouter API error 402: payment_required';
    const tagged = tagJobFailure(new Error(raw));
    // classifyGeminiError sees payment_required -> quota -> gemini_quota
    expect(parseJobLastError(tagged)?.errorCode).toBe('gemini_quota');
  });
});
