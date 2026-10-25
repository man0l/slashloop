import { describe, expect, test } from "bun:test";
import { PAGES } from "./pages/index";
import { cta, renderPage } from "./layout";
import worker, { buildSitemap, type Env } from "./worker";

function makeEnv(dynamic?: unknown, assets?: (req: Request) => Response): Env {
  const pagesJson = JSON.stringify(PAGES.map((p) => ({ path: p.path, title: p.title, changefreq: p.changefreq ?? "monthly" })));
  return {
    ASSETS: {
      fetch: async (input: Request) =>
        assets
          ? assets(input)
          : new URL(input.url).pathname === "/tools/pages.json"
            ? new Response(pagesJson, { headers: { "content-type": "application/json" } })
            : new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    },
    TOOLS_CACHE: { get: async (key: string) => (key === "sitemap:dynamic" && dynamic !== undefined ? JSON.stringify(dynamic) : null) },
    TOOLS_DB: {},
  } as unknown as Env;
}

const get = (path: string, env: Env) => worker.fetch(new Request(`https://slashloop.dev${path}`), env);

describe("sitemap", () => {
  test("includes every registry path", async () => {
    const res = await get("/tools/sitemap.xml", makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const xml = await res.text();
    expect(xml).toContain("<loc>https://slashloop.dev/tools/</loc>");
    for (const page of PAGES) {
      const loc = page.path ? `https://slashloop.dev/tools/${page.path}/` : "https://slashloop.dev/tools/";
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
  });

  test("includes dynamic KV entries and drops entries outside /tools/", async () => {
    const dynamic = [
      { loc: "https://slashloop.dev/tools/creator/alice/", lastmod: "2026-10-01" },
      { loc: "https://evil.example/x/" },
    ];
    const xml = await (await get("/tools/sitemap.xml", makeEnv(dynamic))).text();
    expect(xml).toContain("<loc>https://slashloop.dev/tools/creator/alice/</loc><lastmod>2026-10-01</lastmod>");
    expect(xml).not.toContain("evil.example");
  });

  test("tolerates malformed dynamic KV value", async () => {
    const env = makeEnv();
    (env.TOOLS_CACHE as unknown as { get: () => Promise<string> }).get = async () => "not json";
    const res = await get("/tools/sitemap.xml", env);
    expect(res.status).toBe(200);
  });

  test("escapes XML special characters", () => {
    const xml = buildSitemap([], [{ loc: "https://slashloop.dev/tools/a/?x=1&y=2" }]);
    expect(xml).toContain("x=1&amp;y=2");
  });
});

describe("api", () => {
  test("health", async () => {
    const res = await get("/tools/api/health", makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("unknown /tools/api/x is a JSON 404", async () => {
    const res = await get("/tools/api/x", makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("assets passthrough", () => {
  test("adds Cache-Control to HTML responses and keeps the status", async () => {
    const env = makeEnv(undefined, () => new Response("<html></html>", { status: 404, headers: { "content-type": "text/html", "cache-control": "max-age=0" } }));
    const res = await get("/tools/nope", env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("leaves non-HTML responses untouched", async () => {
    const env = makeEnv(undefined, () => new Response("x", { headers: { "content-type": "text/css", "cache-control": "max-age=5" } }));
    const res = await get("/tools/a.css", env);
    expect(res.headers.get("cache-control")).toBe("max-age=5");
  });
});

describe("layout", () => {
  test("noindex emits robots meta and escapes metadata", () => {
    const html = renderPage({ path: "x", title: 'A "b" <c>', description: "d", body: "<p>b</p>", noindex: true });
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("A &quot;b&quot; &lt;c&gt;");
    expect(html).toContain('<link rel="canonical" href="https://slashloop.dev/tools/x/">');
  });

  test("cta defaults to the utm link", () => {
    expect(cta({ headline: "h", buttonText: "b" }, "calc")).toContain("https://slashloop.dev/?utm_source=tools&amp;utm_medium=calc");
  });
});
