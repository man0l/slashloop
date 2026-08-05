// Unit tests for backend/model attempt planning — the part of analyzeVideo that
// decides native(primary model) -> native(fallback model) -> text fallback.
// Pure function, no DB/network. `bun test`.
import { describe, expect, test } from 'bun:test';
import { planBackendAttempts } from './index.js';
import { DEFAULT_CONFIG, type AnalysisConfig } from './types.js';

function cfg(over: Partial<AnalysisConfig>): AnalysisConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

describe('planBackendAttempts', () => {
  test('default config: native(primary) -> native(fallback model) -> text', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { orVideoEnabled: false });
    expect(attempts).toEqual([
      { backendId: 'gemini-native' },
      { backendId: 'gemini-native', model: 'gemini-3.5-flash-lite', label: ' (fallback model)', fallback: true },
      { backendId: 'gemini-text', label: ' (fallback)', fallback: true },
    ]);
  });

  test('no model fallback when fallbackModel equals geminiModel', () => {
    const attempts = planBackendAttempts(cfg({ geminiModel: 'gemini-3.5-flash', fallbackModel: 'gemini-3.5-flash' }), { orVideoEnabled: false });
    expect(attempts.map(a => a.backendId)).toEqual(['gemini-native', 'gemini-text']);
  });

  test('no model fallback when fallbackModel is unset (legacy config rows)', () => {
    const attempts = planBackendAttempts(cfg({ fallbackModel: undefined }), { orVideoEnabled: false });
    expect(attempts.map(a => a.backendId)).toEqual(['gemini-native', 'gemini-text']);
  });

  test('text backend config: single text attempt, no duplicates', () => {
    const attempts = planBackendAttempts(cfg({ backend: 'gemini-text', fallback: 'gemini-text' }));
    expect(attempts).toEqual([{ backendId: 'gemini-text' }]);
  });

  test('forceBackend=gemini-text short-circuits to text', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { forceBackend: 'gemini-text' });
    expect(attempts).toEqual([{ backendId: 'gemini-text' }]);
  });

  test('forceBackend=gemini-native still plans the model fallback', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { forceBackend: 'gemini-native' });
    expect(attempts[1]).toMatchObject({ backendId: 'gemini-native', model: 'gemini-3.5-flash-lite', fallback: true });
  });

  test('flipToFallback (2 consecutive failures) goes straight to the configured fallback', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { flipToFallback: true, orVideoEnabled: true });
    expect(attempts).toEqual([{ backendId: 'gemini-text' }]);
  });

  test('openrouter-video is slotted between native and text when enabled', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { orVideoEnabled: true });
    expect(attempts.map(a => a.backendId)).toEqual(['gemini-native', 'gemini-native', 'openrouter-video', 'gemini-text']);
    expect(attempts[2]).toMatchObject({ backendId: 'openrouter-video', fallback: true });
  });

  test('openrouter-video is omitted when disabled', () => {
    const attempts = planBackendAttempts(DEFAULT_CONFIG, { orVideoEnabled: false });
    expect(attempts.map(a => a.backendId)).toEqual(['gemini-native', 'gemini-native', 'gemini-text']);
  });

  test('openrouter-video is omitted for text-configured workspaces', () => {
    const attempts = planBackendAttempts(cfg({ backend: 'gemini-text', fallback: 'gemini-text' }), { orVideoEnabled: true });
    expect(attempts).toEqual([{ backendId: 'gemini-text' }]);
  });

  test('no duplicate when fallback backend equals native (model-fallback only)', () => {
    const attempts = planBackendAttempts(cfg({ fallback: 'gemini-native' }), { orVideoEnabled: false });
    // primary native + model fallback; the 'gemini-native' fallback equals the
    // primary so it must not be repeated; text is not configured.
    expect(attempts.map(a => a.backendId + (a.model ? ':' + a.model : ''))).toEqual([
      'gemini-native',
      'gemini-native:gemini-3.5-flash-lite',
    ]);
  });
});
