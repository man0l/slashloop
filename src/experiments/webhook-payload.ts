import { paperclipIssueIdOf, type Experiment, type NotifyConfig } from './schema.js';

export const webhookIdempotencyKey = (experimentId: string, status: string, version: number): string => `${experimentId}:${status}:${version}`;

/** Body of the completion event, minus `metadata` (echoed from the stored notify config at delivery time). */
export function buildWebhookPayload(e: Experiment): Record<string, unknown> {
  return {
    type: `experiment.${e.status}`,
    experimentId: e.id,
    workspaceId: e.workspaceId,
    status: e.status,
    version: e.version,
    occurredAt: e.updatedAt,
    ranBy: e.ranBy ?? null,
    ...(e.error && (e.status === 'failed' || e.status === 'paused') ? { error: e.error.slice(0, 500) } : {}),
    summary: { variants: e.variants.length, spentCredits: e.creditsCharged },
    links: { mcp: 'get_experiment' },
  };
}

/** Receipt returned by create: the stored target, and the signing secret only if we generated it. */
export function notifyReceipt(n: NotifyConfig): NonNullable<Experiment['notify']> {
  return {
    url: n.url,
    paperclipIssueId: paperclipIssueIdOf(n.metadata),
    ...(n.secretGenerated && n.secret ? { signingSecret: n.secret } : {}),
  };
}
