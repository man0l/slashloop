import { cta, escapeHtml, renderPage } from "../layout";

export type Category = "calculator" | "checker" | "specs" | "data" | "generator";

export type ToolPage = {
  path: string;
  title: string;
  description: string;
  category: Category;
  render(): string;
  changefreq?: string;
};

const CATEGORY_LABELS: Record<Category, string> = {
  calculator: "Calculators",
  checker: "Checkers",
  specs: "Specs and sizes",
  data: "Data",
  generator: "Generators",
};

function renderIndexBody(pages: readonly ToolPage[]): string {
  const tools = pages.filter((page) => page.path !== "");
  const sections = (Object.keys(CATEGORY_LABELS) as Category[])
    .map((category) => {
      const inCategory = tools.filter((page) => page.category === category);
      if (inCategory.length === 0) return "";
      const items = inCategory
        .map((page) => `<li><a href="/tools/${escapeHtml(page.path)}/">${escapeHtml(page.title)}</a> &mdash; ${escapeHtml(page.description)}</li>`)
        .join("\n");
      return `<h2>${CATEGORY_LABELS[category]}</h2>\n<ul>\n${items}\n</ul>`;
    })
    .filter(Boolean)
    .join("\n");
  return `<h1>Free tools for TikTok and Instagram creators</h1>
<p>Simple, free utilities for short-form video creators. No sign-up needed.</p>
${sections || "<p>New tools are on the way. Check back soon.</p>"}`;
}

const indexPage: ToolPage = {
  path: "",
  title: "Free tools for TikTok and Instagram creators | Slashloop",
  description: "Free calculators, checkers and generators for TikTok and Instagram creators. No sign-up required.",
  category: "data",
  changefreq: "weekly",
  render() {
    return renderPage({
      path: "",
      title: this.title,
      description: this.description,
      body: renderIndexBody(PAGES),
      cta: cta({ headline: "Turn winning ideas into TikTok slideshows", buttonText: "Try Slashloop" }, "index"),
    });
  },
};

export const PAGES: ToolPage[] = [indexPage];
