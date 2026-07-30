// Vercel /api function — Web Standard `fetch` handler for the MCP endpoint.
//
// Uses the SDK's WebStandardStreamableHTTPServerTransport, which takes a Web
// Request and returns a Web Response with a ReadableStream body. Vercel flushes
// ReadableStream chunks correctly (unlike Node res.write() SSE, which it buffers
// and causes the MCP handshake to hang until maxDuration).
import { verifySupabaseJwt } from '../remote/auth.js';
import { buildRemoteMcp, type Claims } from '../remote/handlers.js';
import { runWithUser } from '../src/context.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

function originFromWeb(request: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } }),
    { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const origin = originFromWeb(request);
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  let claims: Claims | null = null;
  if (token) {
    try { claims = await verifySupabaseJwt(token); } catch { claims = null; }
  }
  if (!claims) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  // Stateless: fresh transport + server per request. runWithUser keeps the JWT
  // sub bound via AsyncLocalStorage while the server processes the request.
  // NOTE: do NOT call mcp.close() here — the Response body is a ReadableStream
  // that Vercel drains after we return; closing the server prematurely empties
  // it. The server/transport are GC'd once the stream completes.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let response!: Response;
  await runWithUser(claims.sub, async () => {
    const mcp = buildRemoteMcp(claims!);
    await mcp.connect(transport);

    // Temporary, alongside the oninitialized log in remote/handlers.ts: that log
    // fired with capabilities undefined on every call, which is consistent with
    // TWO different explanations — (a) Claude Desktop genuinely never declares
    // capabilities for this connector, or (b) this deployment builds a fresh
    // McpServer per HTTP request (see the comment below), so oninitialized fires
    // on an instance that never itself received the initialize params — the real
    // negotiation happened on an earlier, already-discarded instance. Logging the
    // raw JSON-RPC method(s) in THIS request settles it: if a tools/call for
    // show_gallery arrives with no initialize in the same body, this request
    // never had the chance to see capabilities at all, regardless of what the
    // client declared minutes earlier.
    try {
      const cloned = request.clone();
      const body = await cloned.text();
      const parsed: unknown = JSON.parse(body);
      const methods = Array.isArray(parsed)
        ? parsed.map(m => (m as { method?: string }).method)
        : [(parsed as { method?: string }).method];
      console.log(`[mcp-apps] request method(s): ${JSON.stringify(methods)}`);
    } catch (err) {
      console.log(`[mcp-apps] could not inspect request body: ${(err as Error).message}`);
    }

    response = await transport.handleRequest(request);
  });
  return response;
}

export async function GET(): Promise<Response> { return methodNotAllowed(); }
export async function PUT(): Promise<Response> { return methodNotAllowed(); }
export async function DELETE(): Promise<Response> { return methodNotAllowed(); }
