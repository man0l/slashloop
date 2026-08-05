// Unit tests for the provider factory (src/lib/llm.ts). No network.
import { describe, expect, test, afterEach } from 'bun:test';
import { createTextClient, activeProvider, openRouterVideoConfig, openRouterVideoEnabled } from './llm.js';

const ORIG_OR = process.env.OPENROUTER_API_KEY;
const ORIG_LLM = process.env.LLM_PROVIDER;
const ORIG_MODEL = process.env.OPENROUTER_VIDEO_MODEL;
const ORIG_MODE = process.env.OPENROUTER_VIDEO_MODE;

afterEach(() => {
  restore('OPENROUTER_API_KEY', ORIG_OR);
  restore('LLM_PROVIDER', ORIG_LLM);
  restore('OPENROUTER_VIDEO_MODEL', ORIG_MODEL);
  restore('OPENROUTER_VIDEO_MODE', ORIG_MODE);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('createTextClient factory (OpenRouter default)', () => {
  test('OpenRouter is the default when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    delete process.env.LLM_PROVIDER;
    expect(createTextClient().provider).toBe('openrouter');
  });

  test('LLM_PROVIDER=google forces Google even with an OpenRouter key', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    process.env.LLM_PROVIDER = 'google';
    expect(createTextClient().provider).toBe('google');
  });

  test('LLM_PROVIDER=openrouter forces OpenRouter', () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.LLM_PROVIDER = 'openrouter';
    expect(createTextClient().provider).toBe('openrouter');
  });

  test('falls back to Google with no OpenRouter key and no override', () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_PROVIDER;
    expect(createTextClient().provider).toBe('google');
  });
});

describe('openRouterVideoConfig (env-driven video routing)', () => {
  test('defaults: enabled, qwen model, auto mode', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    delete process.env.OPENROUTER_VIDEO_MODEL;
    delete process.env.OPENROUTER_VIDEO_MODE;
    const cfg = openRouterVideoConfig();
    expect(cfg).toMatchObject({ enabled: true, model: 'qwen/qwen3.5-flash-02-23', mode: 'auto' });
  });

  test('model and mode switch via env', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    process.env.OPENROUTER_VIDEO_MODEL = 'z-ai/glm-5v-turbo';
    process.env.OPENROUTER_VIDEO_MODE = 'base64';
    const cfg = openRouterVideoConfig();
    expect(cfg).toMatchObject({ enabled: true, model: 'z-ai/glm-5v-turbo', mode: 'base64' });
  });

  test('mode=off disables it', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    process.env.OPENROUTER_VIDEO_MODE = 'off';
    expect(openRouterVideoEnabled()).toBe(false);
  });

  test('unknown mode falls back to auto', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
    process.env.OPENROUTER_VIDEO_MODE = 'banana';
    expect(openRouterVideoConfig().mode).toBe('auto');
  });
});
