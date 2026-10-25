import { escapeHtml } from "../layout";

export type Faq = { q: string; a: string };

export function renderFaq(faqs: readonly Faq[]): string {
  const items = faqs.map((f) => `<h3>${escapeHtml(f.q)}</h3>\n<p>${escapeHtml(f.a)}</p>`).join("\n");
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  const jsonLd = JSON.stringify(ld).replace(/</g, "\\u003c");
  return `<h2>Frequently asked questions</h2>\n${items}\n<script type="application/ld+json">${jsonLd}</script>`;
}
