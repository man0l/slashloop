import { describe, expect, test } from "bun:test";
import { PAGES } from "./index";

const find = (path: string) => PAGES.find((p) => p.path === path)!;

describe("checker pages", () => {
  test("region checker has the required title, canonical, CTA and FAQ JSON-LD", () => {
    const page = find("tiktok-region-checker");
    expect(page.category).toBe("checker");
    const html = page.render();
    expect(html).toContain("<title>TikTok Region Checker: Which Country Does TikTok Think You Are In?</title>");
    expect(html).toContain('<link rel="canonical" href="https://slashloop.dev/tools/tiktok-region-checker/">');
    expect(html).toContain("utm_medium=region-checker");
    expect(html).toContain("Running US accounts from abroad? Research what works on the US For You page first");
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('<script src="/tools/region.js" defer></script>');
    expect(html).toContain("Not affiliated with TikTok or Meta.");
  });

  test("blacklist checker lists all 7 zones with lookup links and no Spamhaus", () => {
    const page = find("blacklist-ip-checker");
    expect(page.category).toBe("checker");
    const html = page.render();
    expect(html).toContain("<title>Blacklist IP Checker: Test an IP Against 7 DNS Blocklists</title>");
    expect(html).toContain('<link rel="canonical" href="https://slashloop.dev/tools/blacklist-ip-checker/">');
    expect(html).toContain("utm_medium=blacklist-checker");
    expect(html).toContain('"@type":"FAQPage"');
    expect((html.match(/<tr data-zone="/g) ?? []).length).toBe(7);
    expect((html.match(/<tbody id="bl-rows">[\s\S]*<\/tbody>/)?.[0].match(/href="https?:\/\//g) ?? []).length).toBe(7);
    expect(html).not.toMatch(/zen\.spamhaus|sbl\.spamhaus/);
  });

  test("client scripts exist in public/ and never reference TikTok hosts", async () => {
    for (const file of ["public/region.js", "public/blacklist.js"]) {
      const src = await Bun.file(new URL(`../../${file}`, import.meta.url)).text();
      expect(src).not.toContain("tiktok.com");
      expect(src).toContain("/tools/api/");
    }
  });
});
