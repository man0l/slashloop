import { SITE_ORIGIN } from "./layout";

export interface Env {
  ASSETS: Fetcher;
  TOOLS_CACHE: KVNamespace;
  TOOLS_DB: D1Database;
}

type PageEntry = { path: string; title?: string; changefreq?: string };
export type DynamicEntry = { loc: string; lastmod?: string };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CACHE_CONTROL = "public, max-age=3600";
const TOOLS_PREFIX = `${SITE_ORIGIN}/tools/`;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildSitemap(pages: readonly PageEntry[], dynamic: readonly DynamicEntry[] = []): string {
  const urls: string[] = [];
  for (const page of pages) {
    const path = page.path.replace(/^\/+|\/+$/g, "");
    const loc = path ? `${TOOLS_PREFIX}${path}/` : TOOLS_PREFIX;
    const changefreq = page.changefreq ? `<changefreq>${xmlEscape(page.changefreq)}</changefreq>` : "";
    urls.push(`<url><loc>${xmlEscape(loc)}</loc>${changefreq}</url>`);
  }
  for (const entry of dynamic) {
    if (typeof entry?.loc !== "string" || !entry.loc.startsWith(TOOLS_PREFIX)) continue;
    const lastmod = entry.lastmod ? `<lastmod>${xmlEscape(entry.lastmod)}</lastmod>` : "";
    urls.push(`<url><loc>${xmlEscape(entry.loc)}</loc>${lastmod}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function loadPages(request: Request, env: Env): Promise<PageEntry[]> {
  const res = await env.ASSETS.fetch(new Request(new URL("/tools/pages.json", request.url)));
  if (!res.ok) return [];
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as PageEntry[]) : [];
}

async function loadDynamic(env: Env): Promise<DynamicEntry[]> {
  const raw = await env.TOOLS_CACHE.get("sitemap:dynamic");
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? (data as DynamicEntry[]) : [];
  } catch {
    return [];
  }
}

async function sitemap(request: Request, env: Env): Promise<Response> {
  const [pages, dynamic] = await Promise.all([loadPages(request, env), loadDynamic(env)]);
  return new Response(buildSitemap(pages, dynamic), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": CACHE_CONTROL },
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/tools/sitemap.xml" && request.method === "GET") return sitemap(request, env);

  if (pathname.startsWith("/tools/api/")) {
    if (pathname === "/tools/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: JSON_HEADERS });
  }

  const res = await env.ASSETS.fetch(request);
  if (res.headers.get("content-type")?.includes("text/html")) {
    const out = new Response(res.body, res);
    out.headers.set("cache-control", CACHE_CONTROL);
    return out;
  }
  return res;
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
