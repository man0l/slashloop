// ---------------------------------------------------------------------------
// Config — load and merge workspace analysis config with defaults
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import type { AnalysisConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { openRouterVideoEnabled } from '../lib/llm.js';

export async function loadAnalysisConfig(workspaceId: string): Promise<AnalysisConfig> {
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { ...DEFAULT_CONFIG };

  try {
    const stored = JSON.parse(workspace.analysisConfigJson) as Partial<AnalysisConfig>;
    return {
      backend: stored.backend ?? (openRouterVideoEnabled() ? 'openrouter-video' : DEFAULT_CONFIG.backend),
      fallback: stored.fallback ?? DEFAULT_CONFIG.fallback,
      geminiModel: stored.geminiModel ?? DEFAULT_CONFIG.geminiModel,
      fallbackModel: stored.fallbackModel ?? DEFAULT_CONFIG.fallbackModel,
    };
  } catch {
    return { ...DEFAULT_CONFIG, backend: openRouterVideoEnabled() ? 'openrouter-video' : DEFAULT_CONFIG.backend };
  }
}

export async function updateAnalysisConfig(
  workspaceId: string,
  updates: Partial<AnalysisConfig>,
): Promise<AnalysisConfig> {
  const current = await loadAnalysisConfig(workspaceId);
  const merged: AnalysisConfig = { ...current, ...updates };

  await db.workspace.update({
    where: { id: workspaceId },
    data: { analysisConfigJson: JSON.stringify(merged) },
  });

  return merged;
}