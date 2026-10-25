export const SITE_ORIGIN = "https://slashloop.dev";

export type PageInput = {
  path: string;
  title: string;
  description: string;
  body: string;
  cta?: string;
  noindex?: boolean;
};

export type CtaInput = { headline: string; buttonText: string; href?: string };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export function canonicalUrl(path: string): string {
  const clean = trimSlashes(path);
  return clean ? `${SITE_ORIGIN}/tools/${clean}/` : `${SITE_ORIGIN}/tools/`;
}

export function cta({ headline, buttonText, href }: CtaInput, path = ""): string {
  const target = href ?? `${SITE_ORIGIN}/?utm_source=tools&utm_medium=${encodeURIComponent(trimSlashes(path) || "index")}`;
  return `<aside class="cta"><h2>${escapeHtml(headline)}</h2><p><a class="button" href="${escapeHtml(target)}">${escapeHtml(buttonText)}</a></p></aside>`;
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
header,footer{padding:16px 0;border-bottom:1px solid #e5e5e5}
footer{border-bottom:0;border-top:1px solid #e5e5e5;margin-top:48px;font-size:14px;color:#555}
header .wrap{display:flex;justify-content:space-between;align-items:center}
a{color:#0b57d0}
.wordmark{font-weight:700;font-size:20px;color:#1a1a1a;text-decoration:none}
h1{line-height:1.2}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e5e5}
th{background:#f6f6f6}
.cta{margin:32px 0;padding:20px;border:1px solid #e5e5e5;border-radius:8px;background:#f9fafb}
.button{display:inline-block;padding:10px 18px;border-radius:6px;background:#0b57d0;color:#fff;text-decoration:none;font-weight:600}
`.trim();

export function renderPage({ path, title, description, body, cta: ctaHtml = "", noindex = false }: PageInput): string {
  const canonical = canonicalUrl(path);
  const robots = noindex ? `\n<meta name="robots" content="noindex">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">${robots}
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap"><a class="wordmark" href="${SITE_ORIGIN}/">Slashloop</a><nav><a href="/tools/">Free tools</a></nav></div></header>
<main class="wrap">
${body}
${ctaHtml}
</main>
<footer><div class="wrap"><p>Not affiliated with TikTok or Meta. Figures are estimates for information only.</p><p><a href="${SITE_ORIGIN}/privacy">Privacy</a> &middot; <a href="${SITE_ORIGIN}/terms">Terms</a></p></div></footer>
</body>
</html>
`;
}
