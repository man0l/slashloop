// Unit tests for the OpenRouter adapter — pure parts (model mapping, content
// building, error classification), no network. `bun test`.
import { describe, expect, test } from 'bun:test';
import { modelToOpenRouter, buildUserContent, classifyOpenRouterError, extractFirstJson } from './openrouter.js';
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

  test('passes through any provider-qualified id (google/, qwen/, z-ai/, ...)', () => {
    expect(modelToOpenRouter('google/gemini-3.5-flash')).toBe('google/gemini-3.5-flash');
    expect(modelToOpenRouter('qwen/qwen3.5-flash-02-23')).toBe('qwen/qwen3.5-flash-02-23');
    expect(modelToOpenRouter('z-ai/glm-5v-turbo')).toBe('z-ai/glm-5v-turbo');
    expect(modelToOpenRouter('bytedance-seed/seed-1.6-flash')).toBe('bytedance-seed/seed-1.6-flash');
  });

  test('throws for an unmapped bare model id', () => {
    expect(() => modelToOpenRouter('gpt-4o')).toThrow(/No OpenRouter model mapping/);
  });
});

describe('extractFirstJson', () => {
  test('plain JSON', () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('strips a "Thinking process" preamble from reasoning models', () => {
    const raw = 'Thinking Process:\n1. The user wants JSON.\n\n{"scene":"a forest","characters":"Mole"}';
    expect(extractFirstJson(raw)).toEqual({ scene: 'a forest', characters: 'Mole' });
  });

  test('strips code fences', () => {
    expect(extractFirstJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('extracts the first object out of prose wrap', () => {
    expect(extractFirstJson('Here you go: {"on_screen":"hello"} — hope that helps')).toEqual({ on_screen: 'hello' });
  });

  test('null when nothing parses', () => {
    expect(extractFirstJson('no json here')).toBeNull();
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

  test('labels each image when a carousel of slides is attached', () => {
    const parts = buildUserContent('analyze this', [
      { mimeType: 'image/jpeg', dataBase64: 'AAAA' },
      { mimeType: 'image/jpeg', dataBase64: 'BBBB' },
    ]) as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'text', text: 'Slide 1 of 2:' });
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(parts[3]).toEqual({ type: 'text', text: 'Slide 2 of 2:' });
    expect(parts[4]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } });
  });

  // SLA-522: a QA comparison must name which frame is the source and which is
  // the candidate. Positional "Slide 1 of 2" cannot say that, and a single
  // unlabelled image cannot be named at all.
  test('a named frame is captioned by its name, in order, including the only frame', () => {
    const parts = buildUserContent('verify this', [
      { mimeType: 'image/jpeg', dataBase64: 'AAAA', label: 'Mapped source frame' },
      { mimeType: 'image/jpeg', dataBase64: 'BBBB', label: 'Candidate render to verify' },
    ]) as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'text', text: 'Mapped source frame' });
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(parts[3]).toEqual({ type: 'text', text: 'Candidate render to verify' });
    expect(parts[4]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } });

    const single = buildUserContent('verify this', [{ mimeType: 'image/jpeg', dataBase64: 'AAAA', label: 'Candidate render to verify' }]) as Array<Record<string, unknown>>;
    expect(single[1]).toEqual({ type: 'text', text: 'Candidate render to verify' });
    expect(single[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });

    // An unlabelled frame keeps the pre-existing output exactly.
    const unlabelled = buildUserContent('analyze this', [{ mimeType: 'image/jpeg', dataBase64: 'AAAA' }]) as Array<Record<string, unknown>>;
    expect(unlabelled).toHaveLength(2);
    expect(unlabelled[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  });
});

describe('classifyOpenRouterError', () => {
  const make = (status: number, body: string) => `OpenRouter API error ${status}: ${body}`;

  test('402 payment_required -> quota, NOT retryable', () => {
    const c = classifyOpenRouterError(new Error(make(402, '{"error":{"message":"insufficient credits","code":402,"metadata":{"error_type":"payment_required"}}}')));
    expect(c.category).toBe('quota');
    expect(c.retryable).toBe(false);
  });

  test('200 status with error_type payment_required still -> quota', () => {
    const c = classifyOpenRouterError(new Error('OpenRouter API error 200: {"error":{"message":"out of credits","code":402,"metadata":{"error_type":"payment_required"}}}'));
    expect(c.category).toBe('quota');
    expect(c.retryable).toBe(false);
  });

  // The exact production payload from the SLA-452 log sweep: no error_type, the
  // numeric code only in the body, and a hard $1.00 floor for video requests.
  // A retry gets this identical answer, so it must not be classed retryable.
  test('the "$1.00 in balance for video" 402 is quota and not retryable', () => {
    const c = classifyOpenRouterError(new Error(make(402, '{"error":{"message":"This request requires at least $1.00 in balance for video","code":402,"metadata":{"limit_source":"openrouter_credits"}}}')));
    expect(c.category).toBe('quota');
    expect(c.retryable).toBe(false);
  });

  test('balance message without a usable status code still -> quota, not retryable', () => {
    const c = classifyOpenRouterError(new Error('OpenRouter API error 500: {"error":{"message":"This request requires at least $1.00 in balance for video"}}'));
    expect(c.category).toBe('quota');
    expect(c.retryable).toBe(false);
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

  test('empty upstream choice -> server, retryable (SLA-515)', () => {
    const c = classifyOpenRouterError(new Error('OpenRouter returned no content'));
    expect(c.category).toBe('server');
    expect(c.retryable).toBe(true);
  });

  test('checker timeout -> server, retryable (SLA-515)', () => {
    const c = classifyOpenRouterError(new Error('The operation timed out.'));
    expect(c.category).toBe('server');
    expect(c.retryable).toBe(true);
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
