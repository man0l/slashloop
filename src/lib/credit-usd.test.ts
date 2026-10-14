// SLA-842: every credit amount an MCP tool reports also carries its dollar value.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import {
  annotateCreditText, annotateCreditValue, annotateToolResult, creditsToUsd, formatCredits, withCreditUsd,
} from './credit-usd.js';
import { insufficientCreditsPayload, InsufficientCreditsError } from './credits.js';

describe('creditsToUsd', () => {
  test('1 credit = $0.01, whole cents get two decimals', () => {
    expect(creditsToUsd(0)).toBe('$0.00');
    expect(creditsToUsd(1)).toBe('$0.01');
    expect(creditsToUsd(75)).toBe('$0.75');
    expect(creditsToUsd(3000)).toBe('$30.00');
    expect(creditsToUsd(123400)).toBe('$1,234.00');
  });

  test('fractional credits keep sub-cent precision instead of rounding up', () => {
    expect(creditsToUsd(1.5)).toBe('$0.015');
    expect(creditsToUsd(0.1 + 0.2)).toBe('$0.003');
  });

  test('refunds and negative ledger deltas keep their sign', () => {
    expect(creditsToUsd(-75)).toBe('-$0.75');
  });

  test('formatCredits pairs the count with the dollars', () => {
    expect(formatCredits(1)).toBe('1 credit ($0.01)');
    expect(formatCredits(75)).toBe('75 credits ($0.75)');
  });
});

describe('annotateCreditText', () => {
  test('appends dollars to every credit amount in a sentence', () => {
    expect(annotateCreditText('Costs 5 credits. A 50-video source costs 75 credits.'))
      .toBe('Costs 5 credits ($0.05). A 50-video source costs 75 credits ($0.75).');
    expect(annotateCreditText('1 credit left')).toBe('1 credit ($0.01) left');
    expect(annotateCreditText('1,500 credits')).toBe('1,500 credits ($15.00)');
    expect(annotateCreditText('1.5 credits per video')).toBe('1.5 credits ($0.015) per video');
    expect(annotateCreditText('over the 100-credit hard ceiling')).toBe('over the 100-credit ($1.00) hard ceiling');
  });

  test('is idempotent and leaves credit-free text alone', () => {
    const once = annotateCreditText('needs 30 credits');
    expect(annotateCreditText(once)).toBe(once);
    expect(annotateCreditText('Spends nothing; no credits charged.')).toBe('Spends nothing; no credits charged.');
    expect(annotateCreditText('50 videos')).toBe('50 videos');
  });
});

describe('annotateCreditValue', () => {
  test('credit-named numbers get a …Usd sibling', () => {
    expect(annotateCreditValue({ totalCredits: 75, approvedCredits: 100, videoCount: 3 })).toEqual({
      totalCredits: 75, totalCreditsUsd: '$0.75', approvedCredits: 100, approvedCreditsUsd: '$1.00', videoCount: 3,
    });
  });

  test('money fields inside a credit-named object are covered (balance, ledger rows)', () => {
    const out = annotateCreditValue({
      credits: { total: 3050, planCredits: 3000, packCredits: 50, planKey: 'creator' },
      recentCreditLedger: [{ delta: -5, balanceAfter: 3045, tool: 'analyze_video' }],
    });
    expect(out).toEqual({
      credits: {
        total: 3050, totalUsd: '$30.50',
        planCredits: 3000, planCreditsUsd: '$30.00',
        packCredits: 50, packCreditsUsd: '$0.50',
        planKey: 'creator',
      },
      recentCreditLedger: [{ delta: -5, deltaUsd: '-$0.05', balanceAfter: 3045, balanceAfterUsd: '$30.45', tool: 'analyze_video' }],
    });
  });

  test('does not overwrite a dollar field the tool already reports, or touch cents fields', () => {
    expect(annotateCreditValue({ credits: 5, creditsUsd: 'custom', totalCostCents: 120 }))
      .toEqual({ credits: 5, creditsUsd: 'custom', totalCostCents: 120 });
  });

  test('the insufficient_credits payload reports both sides in dollars', () => {
    const out = annotateCreditValue(insufficientCreditsPayload(new InsufficientCreditsError('ws1', 30, 12))) as Record<string, unknown>;
    expect(out.requiredUsd).toBe('$0.30');
    expect(out.remainingUsd).toBe('$0.12');
    expect(out.message).toContain('needs 30 credits ($0.30); the workspace has 12 credits ($0.12) remaining');
  });
});

describe('annotateToolResult', () => {
  test('keeps JSON text blocks valid JSON with the same indentation', () => {
    const r = annotateToolResult({ content: [{ type: 'text', text: JSON.stringify({ totalCredits: 20 }, null, 2) }] });
    expect(r.content[0].text).toBe(JSON.stringify({ totalCredits: 20, totalCreditsUsd: '$0.20' }, null, 2));
  });

  test('plain text and non-text blocks', () => {
    const r = annotateToolResult({ content: [
      { type: 'text', text: 'Queued: 45 credits reserved.' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ] });
    expect(r.content[0]).toEqual({ type: 'text', text: 'Queued: 45 credits ($0.45) reserved.' });
    expect(r.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });
});

describe('withCreditUsd over a real MCP round-trip', () => {
  async function connect(server: McpServer) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  test('server.tool and registerAppTool: descriptions and results carry dollars', async () => {
    const server = withCreditUsd(new McpServer({ name: 't', version: '0' }));
    server.tool('analyze', 'Run analysis. Costs 5 credits.', { id: z.string() }, async ({ id }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ id, creditsCharged: 5, message: 'Charged 5 credits.' }) }],
    }));
    registerAppTool(server, 'gallery', {
      description: 'Free; no credits charged.',
      _meta: { ui: { resourceUri: 'ui://g' } },
    }, async () => ({ content: [{ type: 'text' as const, text: 'Balance: 3000 credits' }] }));

    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'analyze')?.description).toBe('Run analysis. Costs 5 credits ($0.05).');

    const res = await client.callTool({ name: 'analyze', arguments: { id: 'v1' } });
    const body = JSON.parse((res.content as { text: string }[])[0].text);
    expect(body).toEqual({ id: 'v1', creditsCharged: 5, creditsChargedUsd: '$0.05', message: 'Charged 5 credits ($0.05).' });

    const app = await client.callTool({ name: 'gallery', arguments: {} });
    expect((app.content as { text: string }[])[0].text).toBe('Balance: 3000 credits ($30.00)');
  });
});
