// ---------------------------------------------------------------------------
// Credits → US dollars, on every MCP tool surface (SLA-842).
//
// The user wants the money, not just the meter: whenever a tool reports
// credits — a cost, an estimate, a balance, a charge — the dollar amount
// rides along. Rather than hand-editing every message in every tool, the
// server is wrapped once (withCreditUsd) and each tool result and tool
// description is annotated on the way out:
//
//   - strings:  "75 credits"  → "75 credits ($0.75)"
//               "100-credit cap" → "100-credit ($1.00) cap"
//   - numbers:  { totalCredits: 75 } → { totalCredits: 75, totalCreditsUsd: "$0.75" }
//               and inside a credit-named object ({ credits: { total } },
//               recentCreditLedger rows) the money-bearing fields too.
//
// Annotation is idempotent — an already-annotated string or an existing
// `…Usd` sibling is left alone — so a double wrap or a tool that already
// reports dollars itself can't print the amount twice.
// ---------------------------------------------------------------------------

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** 1 credit = $0.01 (src/lib/credits.ts). */
export const CREDIT_USD = 0.01;

/** "$0.75", "$1,234.00", "$0.015" (1.5 credits). Whole cents get 2 decimals;
 *  fractional-credit amounts keep up to 4 so a 1.5-credit/video rate isn't
 *  rounded to a misleading "$0.02". */
export function creditsToUsd(credits: number): string {
  const sign = credits < 0 ? '-' : '';
  // Round on cents first so float noise (0.1 + 0.2) can't leak into the label.
  const cents = Math.round(Math.abs(credits) * 100) / 100;
  const dollars = cents / 100;
  return sign + '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** "75 credits ($0.75)", "1 credit ($0.01)". */
export function formatCredits(credits: number): string {
  return `${credits} credit${credits === 1 ? '' : 's'} (${creditsToUsd(credits)})`;
}

// "75 credits", "1,500 credits", "1.5 credits/video", "100-credit" — not one
// already followed by "($…)".
const CREDIT_AMOUNT_RE = /(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s+|-)(credits?)\b(?!\s*\(\$)/g;

/** Append the dollar amount to every "N credits" phrase in a string. */
export function annotateCreditText(text: string): string {
  if (!/credit/i.test(text)) return text;
  return text.replace(CREDIT_AMOUNT_RE, (match, int: string, frac: string | undefined) => {
    const credits = Number(int.replace(/,/g, '') + (frac ?? ''));
    return Number.isFinite(credits) ? `${match} (${creditsToUsd(credits)})` : match;
  });
}

const CREDIT_KEY_RE = /credit/i;
// Inside a credit-named object these numeric fields are credit amounts too
// ({ credits: { total } }, recentCreditLedger rows, insufficient_credits).
const CREDIT_CHILD_KEYS = new Set([
  'total', 'delta', 'balance', 'balanceAfter', 'required', 'remaining',
  'cost', 'charged', 'refunded', 'cap', 'ceiling', 'estimate', 'amount',
]);

function isCreditNumber(key: string, value: unknown, inCreditScope: boolean): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (/usd|cents|count|percent/i.test(key) && !/credits?$/i.test(key)) return false;
  return CREDIT_KEY_RE.test(key) || (inCreditScope && CREDIT_CHILD_KEYS.has(key));
}

/** Deep-annotate a JSON value: strings get "($…)", credit numbers get a `…Usd` sibling. */
export function annotateCreditValue(value: unknown, inCreditScope = false): unknown {
  if (typeof value === 'string') return annotateCreditText(value);
  if (Array.isArray(value)) return value.map(v => annotateCreditValue(v, inCreditScope));
  if (!value || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const scope = inCreditScope || src.error === 'insufficient_credits';
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) {
    out[key] = annotateCreditValue(v, scope || CREDIT_KEY_RE.test(key));
    const usdKey = `${key}Usd`;
    if (isCreditNumber(key, v, scope) && !(usdKey in src)) out[usdKey] = creditsToUsd(v);
  }
  return out;
}

type ContentItem = { type: string; text?: string } & Record<string, unknown>;
type ToolResult = { content?: ContentItem[]; structuredContent?: unknown } & Record<string, unknown>;

/** Annotate one MCP tool result. JSON text blocks keep their indentation. */
export function annotateToolResult<T>(result: T): T {
  const r = result as ToolResult;
  if (!r || typeof r !== 'object') return result;
  const out: ToolResult = { ...r };
  if (Array.isArray(r.content)) {
    out.content = r.content.map((item) => {
      if (item?.type !== 'text' || typeof item.text !== 'string' || !/credit/i.test(item.text)) return item;
      return { ...item, text: annotateJsonOrText(item.text) };
    });
  }
  if (r.structuredContent !== undefined) out.structuredContent = annotateCreditValue(r.structuredContent);
  return out as T;
}

function annotateJsonOrText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const indent = /^[[{]\n( +)/.exec(trimmed)?.[1].length ?? 0;
      return JSON.stringify(annotateCreditValue(parsed), null, indent || undefined);
    } catch {
      // Not JSON after all — fall through to plain-text annotation.
    }
  }
  return annotateCreditText(text);
}

/**
 * Patch `server.tool` / `server.registerTool` so every tool registered after
 * this call reports credits in dollars too — in its description and its
 * results. registerAppTool goes through registerTool, so MCP Apps are covered.
 */
export function withCreditUsd<S extends McpServer>(server: S): S {
  const wrapHandler = (fn: unknown) => typeof fn !== 'function' ? fn
    : async function (this: unknown, ...args: unknown[]) {
      return annotateToolResult(await (fn as (...a: unknown[]) => unknown).apply(this, args));
    };

  const tool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as { tool: unknown }).tool = (...args: unknown[]) => {
    // tool(name, description?, schema?, annotations?, handler): the handler is
    // last; a description is the 2nd arg only when it's a string.
    const patched = [...args];
    patched[patched.length - 1] = wrapHandler(patched[patched.length - 1]);
    if (typeof patched[1] === 'string') patched[1] = annotateCreditText(patched[1]);
    return tool(...patched);
  };

  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: { description?: string }, handler: unknown) =>
    registerTool(
      name,
      typeof config?.description === 'string' ? { ...config, description: annotateCreditText(config.description) } : config,
      wrapHandler(handler),
    );

  return server;
}
