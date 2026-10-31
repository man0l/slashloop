// Fetches to slashloop.dev from this Worker must go through the SITE service
// binding: a same-zone fetch() skips the zone's Worker routes and reaches the
// origin instead (404). The binding is registered once per isolate by
// src/cf/env.ts; Node/Bun runtimes have none and use the global fetch.

const SITE_HOSTS = new Set(['slashloop.dev', 'www.slashloop.dev']);

const globalForSite = globalThis as unknown as { __slashloopSiteBinding?: { fetch: typeof fetch } };

export function setSiteBinding(binding: { fetch: typeof fetch } | undefined): void {
  globalForSite.__slashloopSiteBinding = binding;
}

export function isSiteUrl(url: string): boolean {
  try {
    return SITE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const siteAwareFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const binding = globalForSite.__slashloopSiteBinding;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (binding && isSiteUrl(url)) return binding.fetch(input, init);
  return fetch(input, init);
}) as typeof fetch;
