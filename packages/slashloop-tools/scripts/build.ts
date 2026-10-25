import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cta, renderPage } from "../src/layout";
import { PAGES } from "../src/pages/index";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function render404(): string {
  return renderPage({
    path: "404",
    title: "Page not found | Slashloop free tools",
    description: "This page does not exist. Browse the free Slashloop tools instead.",
    noindex: true,
    body: `<h1>Page not found</h1>
<p>We could not find that page. Try the <a href="/tools/">free tools index</a> or go back to the <a href="https://slashloop.dev/">Slashloop home page</a>.</p>`,
    cta: cta({ headline: "Looking for viral TikTok ideas?", buttonText: "Try Slashloop" }, "404"),
  });
}

export function build(outDir = join(PACKAGE_ROOT, "dist"), publicDir = join(PACKAGE_ROOT, "public")): void {
  rmSync(outDir, { recursive: true, force: true });
  const toolsDir = join(outDir, "tools");
  mkdirSync(toolsDir, { recursive: true });

  if (existsSync(publicDir)) cpSync(publicDir, toolsDir, { recursive: true });

  for (const page of PAGES) {
    const dir = page.path ? join(toolsDir, page.path) : toolsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), page.render());
  }

  writeFileSync(join(toolsDir, "404.html"), render404());
  writeFileSync(
    join(toolsDir, "pages.json"),
    JSON.stringify(PAGES.map((page) => ({ path: page.path, title: page.title, changefreq: page.changefreq ?? "monthly" }))),
  );
}

if (import.meta.main) {
  build();
  console.log(`built ${PAGES.length} page(s) into dist/tools`);
}

