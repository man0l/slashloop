// Local HTTP + OAuth surface (NOT used by Vercel — Vercel builds api/ functions).
// Not part of the published slashloop-mcp npm package.
import { createServer } from 'node:http';
import {
  originFrom,
  send,
  handleHealth,
  handleWellKnown,
  handleLogin,
  handleConsent,
  handleMcp,
} from './handlers.js';

const PORT = Number(process.env.PORT ?? 8788);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('[slashloop] Missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy .env.example → .env.');
  process.exit(1);
}

createServer(async (req, res) => {
  const origin = originFrom(req);
  const url = new URL(req.url ?? '/', origin);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health'))
      return handleHealth(req, res, origin);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource')
      return handleWellKnown(req, res, origin);
    if (req.method === 'GET' && url.pathname === '/login') return handleLogin(req, res);
    if (req.method === 'GET' && url.pathname === '/oauth/consent') return handleConsent(req, res);
    if (url.pathname === '/mcp') {
      if (req.method === 'POST') return await handleMcp(req, res, origin);
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } }),
      );
    }
    return send(res, 404, { error: 'not_found', path: url.pathname });
  } catch (err) {
    console.error('[slashloop] request error:', err);
    return send(res, 500, { error: 'internal', message: String(err) });
  }
}).listen(PORT, () => {
  console.log(`[slashloop] remote MCP on http://localhost:${PORT}`);
  console.log(`[slashloop]   POST /mcp  |  GET /login  |  GET /oauth/consent`);
});
