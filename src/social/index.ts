// Public surface of the social scheduler library. Consumers (api/social.ts,
// the cron routes) build a SocialConfig from env and call these — nothing in
// the library reads process.env or global bindings itself.

export * from './types.js';
export { BadBodyError, ReconnectError, RefreshTokenError } from './errors.js';
export { createRegistry, getProvider } from './registry.js';
export { signOAuthState, verifyOAuthState } from './oauth-state.js';
export { socialEngineTick, socialRefreshScan, type TickOptions, type TickReport, type RefreshReport } from './engine.js';
export * as socialStore from './store.js';
