// Unit tests for the provider factory (src/lib/llm.ts). No network.
import { describe, expect, test, afterEach } from 'bun:test';
import { createTextClient, activeProvider } from './llm.js';

const ORIGINAL = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL;
});

describe('createTextClient factory', () => {
  test('selects the OpenRouter adapter when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    expect(createTextClient().provider).toBe('openrouter');
    expect(activeProvider()).toBe('openrouter');
  });

  test('falls back to the Google adapter when only GEMINI_API_KEY exists', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(createTextClient().provider).toBe('google');
  });
});
