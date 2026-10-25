import { cta, renderPage } from "../layout";
import { renderFaq, type Faq } from "./faq";
import type { ToolPage } from "./index";

const PATH = "tiktok-region-checker";

export const REGION_FAQS: Faq[] = [
  {
    q: "Does a VPN change my TikTok region?",
    a: "It changes the IP address TikTok sees, which is one signal. TikTok also looks at your SIM country, app store region and language settings, so a VPN alone does not always change your region or For You page.",
  },
  {
    q: "Why do datacenter IPs get flagged?",
    a: "Addresses owned by hosting and cloud providers are shared by many users and are common for automation, so platforms tend to treat them as less trustworthy than home or mobile connections. This checker flags a short list of well-known hosting networks, so treat the result as a hint, not a verdict.",
  },
  {
    q: "How can I check my TikTok region without the app?",
    a: "Open this page on the device and network you want to test. It shows the country, region and network that your IP address resolves to, which is the part of the region signal that comes from your connection.",
  },
  {
    q: "Do you store my IP address?",
    a: "No. The page reads the location data Cloudflare attaches to your request and sends it straight back to you. It is not saved or logged by this tool.",
  },
];

const BODY = `<h1>TikTok Region Checker: Which Country Does TikTok Think You Are In?</h1>
<p>See the country, region and network your connection shows to apps like TikTok. This covers the IP address part of the picture only.</p>
<div id="region-result" aria-live="polite">
<table>
<tr><th scope="row">Country</th><td id="r-country">Checking&hellip;</td></tr>
<tr><th scope="row">Region</th><td id="r-region">&mdash;</td></tr>
<tr><th scope="row">City</th><td id="r-city">&mdash;</td></tr>
<tr><th scope="row">ISP / network</th><td id="r-isp">&mdash;</td></tr>
<tr><th scope="row">IP type</th><td id="r-type">&mdash;</td></tr>
<tr><th scope="row">Your IP</th><td id="r-ip">&mdash;</td></tr>
</table>
<p id="r-infers"></p>
<p id="r-error" role="alert" hidden></p>
</div>
<noscript><p>Turn on JavaScript to run the check. It reads your connection details from our server.</p></noscript>
<h2>What TikTok probably infers</h2>
<p>The most likely region from your IP is the country shown above. TikTok also uses your SIM country, app store region and app language, so this is the IP part only. The IP type is a heuristic: we compare your network against a list of well-known hosting providers. Cloudflare only offers bot scores and VPN detection on its Enterprise plan, so we cannot tell you for sure whether an address is a VPN.</p>
<h2>Why US creators abroad see a different For You page</h2>
<p>A For You page is tuned to the region TikTok assigns to an account and device. A US-based creator who travels or works from another country can end up with a feed that reflects that country, with different trends, sounds and audiences. That is useful to know when you research what works for a US audience: what you see abroad may not be what viewers in the United States see.</p>
${renderFaq(REGION_FAQS)}
<script src="/tools/region.js" defer></script>`;

export const tiktokRegionChecker: ToolPage = {
  path: PATH,
  title: "TikTok Region Checker: Which Country Does TikTok Think You Are In?",
  description:
    "Check which country, region and network your IP address shows to TikTok. See whether it looks like a datacenter or home connection. Free, no sign-up.",
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
          href: "https://slashloop.dev/?utm_source=tools&utm_medium=region-checker",
        },
        PATH,
      ),
    });
  },
};
