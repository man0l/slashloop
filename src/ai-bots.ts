import type { IncomingMessage } from 'node:http';

/**
 * AI bot tracking for indiestack analytics (vendored — zero deps).
 * Pre-filters known AI bot user-agents on document paths and reports the
 * fetch to the indiestack worker, which is the source of truth for
 * classification, category and IP verification. Best-effort: never throws.
 */

const KNOWN_BOTS: Array<{ re: RegExp; agent: string }> = [
  { re: /gptbot/i, agent: 'GPTBot' },
  { re: /oai-searchbot/i, agent: 'OAI-SearchBot' },
  { re: /chatgpt-user/i, agent: 'ChatGPT-User' },
  { re: /claudebot|claude-web|anthropic-ai/i, agent: 'ClaudeBot' },
  { re: /claude-user|claude-searchbot/i, agent: 'Claude-User' },
  { re: /perplexitybot|perplexity-user/i, agent: 'PerplexityBot' },
  { re: /google-extended/i, agent: 'Google-Extended' },
  { re: /googlebot/i, agent: 'Googlebot' },
  { re: /applebot/i, agent: 'Applebot' },
  { re: /bytespider/i, agent: 'Bytespider' },
  { re: /ccbot/i, agent: 'CCBot' },
  { re: /amazonbot/i, agent: 'Amazonbot' },
  { re: /meta-externalagent|facebookagent/i, agent: 'meta-externalagent' },
  { re: /bingbot/i, agent: 'Bingbot' },
  { re: /duckduckbot/i, agent: 'DuckDuckBot' },
];

const ASSET_RE = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz)$/i;
const INTERNAL_RE = /^\/(api|_app|hit|event|beat|log|mcp|favicon\.ico|health)\b/;
const BOT_DOCS = /\/(robots\.txt|llms\.txt|llms-full\.txt|sitemap\.xml)$/i;

const ENDPOINT = 'https://indiestack.manol-trendafilov.workers.dev/api/ai-bots';
const WEBSITE_ID = '3bbb58275fd1433cae14d4f7b36d575a'; // slashloop analytics site

/** Web-standard request flavor for the Vercel /api functions. */
export async function trackAIBot(request: Request, response: Response): Promise<void> {
  try {
    const ua = request.headers.get('user-agent') ?? '';
    if (!ua) return;
    const url = new URL(request.url);
    const path = url.pathname.slice(0, 200);
    const isDoc = !ASSET_RE.test(path) && !INTERNAL_RE.test(path);
    if (!isDoc && !BOT_DOCS.test(path)) return;
    const bot = KNOWN_BOTS.find((b) => b.re.test(ua));
    if (!bot) return;
    const xff = request.headers.get('x-forwarded-for') ?? '';
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId: WEBSITE_ID,
        path,
        hostname: url.hostname,
        ua: ua.slice(0, 200),
        status: response.status,
        crawlerIp: xff.split(',')[0]?.trim() || null,
        ts: Date.now(),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* tracking is best-effort */
  }
}

// Node-flavored alias for handlers that receive IncomingMessage.
export async function trackAIBotNode(req: IncomingMessage, status: number): Promise<void> {
  const ua = String(req.headers['user-agent'] ?? '');
  if (!ua) return;
  let path = (req.url ?? '/').slice(0, 200);
  const isDoc = !ASSET_RE.test(path) && !INTERNAL_RE.test(path);
  if (!isDoc && !BOT_DOCS.test(path)) return;
  if (!KNOWN_BOTS.some((b) => b.re.test(ua))) return;
  const xff = String(req.headers['x-forwarded-for'] ?? '');
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        websiteId: WEBSITE_ID,
        path,
        hostname: 'slashloop.dev',
        ua: ua.slice(0, 200),
        status,
        crawlerIp: xff.split(',')[0]?.trim() || null,
        ts: Date.now(),
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* tracking is best-effort */
  }
}
