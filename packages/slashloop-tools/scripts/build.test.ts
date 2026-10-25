import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGES } from "../src/pages/index";
import { build } from "./build";

let out: string;
const missingPublic = "/nonexistent-public-dir";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "slashloop-tools-build-"));
  build(out, missingPublic);
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

const pagePath = (path: string) => (path ? join(out, "tools", path, "index.html") : join(out, "tools", "index.html"));

describe("build", () => {
  test("registry is not empty and includes the tools index", () => {
    expect(PAGES.some((page) => page.path === "")).toBe(true);
  });

  test("writes an index.html for every registry page", () => {
    for (const page of PAGES) expect(existsSync(pagePath(page.path))).toBe(true);
  });

  test("every page has a title, description and canonical tag", () => {
    for (const page of PAGES) {
      expect(page.title.trim()).not.toBe("");
      expect(page.description.trim()).not.toBe("");
      const html = readFileSync(pagePath(page.path), "utf8");
      expect(html).toContain(`<title>${page.title.replace(/&/g, "&amp;")}</title>`);
      expect(html).toMatch(/<meta name="description" content="[^"]+">/);
      const expected = page.path ? `https://slashloop.dev/tools/${page.path}/` : "https://slashloop.dev/tools/";
      expect(html).toContain(`<link rel="canonical" href="${expected}">`);
      expect(html).toContain("Not affiliated with TikTok or Meta.");
      expect(html).not.toContain('name="robots"');
    }
  });

  test("writes a noindex 404 page linking back to the tools index and the site", () => {
    const html = readFileSync(join(out, "tools", "404.html"), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/tools/"');
    expect(html).toContain('href="https://slashloop.dev/"');
  });

  test("pages.json lists every registry path", () => {
    const pages = JSON.parse(readFileSync(join(out, "tools", "pages.json"), "utf8")) as { path: string; title: string; changefreq: string }[];
    expect(pages.map((p) => p.path).sort()).toEqual(PAGES.map((p) => p.path).sort());
    for (const p of pages) expect(p.title).not.toBe("");
  });
});
