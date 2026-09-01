// Vercel /api function — Web Standard `fetch` handler for the MCP endpoint.
//
// Uses the SDK's WebStandardStreamableHTTPServerTransport, which takes a Web
// Request and returns a Web Response with a ReadableStream body. Vercel flushes
// ReadableStream chunks correctly (unlike Node res.write() SSE, which it buffers
// and causes the MCP handshake to hang until maxDuration).
import { verifySupabaseJwt } from '../remote/auth.js';
import { buildRemoteMcp, type Claims } from '../remote/mcp-server.js';
import { runWithUser } from '../src/context.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getUiCapability } from '@modelcontextprotocol/ext-apps/server';

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

    // NOTE on client-capability detection, since it looks tempting here and is
    // not available: this deployment is stateless, so `initialize` and a later
    // `tools/call` land on DIFFERENT McpServer instances. By the time a tool
    // runs, `getClientCapabilities()` on THIS instance has never seen the
    // client's declared extensions — the negotiation happened on an instance
    // that was already discarded. That is why show_gallery cannot branch on
    // whether the host supports MCP Apps, and instead always returns both an
    // inline ui:// resource and a signed /gallery link (src/tools/gallery.ts).
    response = await transport.handleRequest(request);

    // The one moment the client's declared capabilities are visible: the
    // request that carried `initialize`. Per SEP-1865 the negotiation is
    // one-directional — the HOST advertises `io.modelcontextprotocol/ui` here
    // and servers only check it; there is nothing for us to advertise back. So
    // this line is the only way to tell "the host will not render MCP Apps"
    // apart from "the host tried and failed" (ext-apps#671), which otherwise
    // look identical from the tool side.
    //
    // Cheap by construction: getClientCapabilities() returns undefined on every
    // non-initialize request, so this logs roughly once per connection.
    const ui = getUiCapability(mcp.server.getClientCapabilities());
    if (ui !== undefined) {
      console.log(`mcp-apps host=${JSON.stringify(mcp.server.getClientVersion()?.name ?? '?')} ui=true mimeTypes=${JSON.stringify(ui.mimeTypes ?? [])}`);
    } else if (mcp.server.getClientCapabilities() !== undefined) {
      console.log(`mcp-apps host=${JSON.stringify(mcp.server.getClientVersion()?.name ?? '?')} ui=false (no io.modelcontextprotocol/ui at initialize — gallery will not render inline; /gallery link is the path)`);
    }
  });
  return response;
}

export async function GET(): Promise<Response> { return methodNotAllowed(); }
export async function PUT(): Promise<Response> { return methodNotAllowed(); }
export async function DELETE(): Promise<Response> { return methodNotAllowed(); }
