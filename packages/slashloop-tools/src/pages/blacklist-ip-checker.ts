import { DNSBL_LISTS } from "../calc/dnsbl";
import { cta, escapeHtml, renderPage } from "../layout";
import { renderFaq, type Faq } from "./faq";
import type { ToolPage } from "./index";

const PATH = "blacklist-ip-checker";

export const BLACKLIST_FAQS: Faq[] = [
  {
    q: "What is a DNS blocklist?",
    a: "A DNS blocklist (DNSBL) is a public list of IP addresses that have been linked to spam or abuse. Mail servers and other services look an address up in these lists to decide whether to trust it.",
  },
  {
    q: "Why does this checker skip Spamhaus?",
    a: "Spamhaus refuses queries that come through public DNS resolvers and can return misleading answers, so a result from here would not be reliable. Check Spamhaus directly on their own site.",
  },
  {
    q: "What does unknown mean?",
    a: "The list did not answer in time or returned an error, so we cannot say whether the address is listed. Try again in a minute.",
  },
  {
    q: "How do I get delisted?",
    a: "Find and fix the cause first, such as a compromised device or an open mail relay. Then use the removal link on the list's own site. Many lists expire entries on their own after a quiet period.",
  },
  {
    q: "Does this support IPv6?",
    a: "Not yet. Only IPv4 addresses can be checked.",
  },
];

const rows = DNSBL_LISTS.map(
  (l) =>
    `<tr data-zone="${escapeHtml(l.zone)}"><td><a href="${escapeHtml(l.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(l.name)}</a><br><small>${escapeHtml(l.zone)}</small></td><td class="status">&mdash;</td></tr>`,
).join("\n");

const BODY = `<h1>Blacklist IP Checker: Test an IP Against 7 DNS Blocklists</h1>
<p>Check whether an IPv4 address is listed on common spam and abuse blocklists. Your own IP is filled in for you.</p>
<form id="bl-form" novalidate>
<p><label for="bl-ip">IPv4 address</label><br><input id="bl-ip" name="ip" inputmode="decimal" autocomplete="off" placeholder="203.0.113.7" size="20"> <button class="button" type="submit">Check</button></p>
</form>
<p id="bl-summary" aria-live="polite"></p>
<p id="bl-error" role="alert" hidden></p>
<table>
<thead><tr><th scope="col">Blocklist</th><th scope="col">Result</th></tr></thead>
<tbody id="bl-rows">
${rows}
</tbody>
</table>
<p><small>Each list is queried over DNS-over-HTTPS with a 3 second timeout. Results are cached for 10 minutes and checks are limited to 30 per hour.</small></p>
<h2>What to do if listed</h2>
<ol>
<li>Find the cause. Look for a compromised device, malware, or a mail server that relays for strangers.</li>
<li>Fix it before asking for removal, or the address will be listed again.</li>
<li>Open the list's own site (the name in the table links to it) and follow its removal steps.</li>
<li>If the address is a shared or rented one, ask your provider. Listings often come from a previous user.</li>
<li>Run the check again after a day. Many lists expire entries on their own.</li>
</ol>
${renderFaq(BLACKLIST_FAQS)}
<script src="/tools/blacklist.js" defer></script>`;

export const blacklistIpChecker: ToolPage = {
  path: PATH,
  title: "Blacklist IP Checker: Test an IP Against 7 DNS Blocklists",
  description:
    "Check whether an IPv4 address is on spam and abuse DNS blocklists such as SpamCop, Barracuda and DroneBL. Free, instant, no sign-up.",
  category: "checker",
  changefreq: "monthly",
  render() {
    return renderPage({
      path: PATH,
      title: this.title,
      description: this.description,
      body: BODY,
      cta: cta(
        {
          headline: "Running US accounts from abroad? Research what works on the US For You page first",
          buttonText: "Try Slashloop",
          href: "https://slashloop.dev/?utm_source=tools&utm_medium=blacklist-checker",
        },
        PATH,
      ),
    });
  },
};
