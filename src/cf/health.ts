import { DEPLOY_SHA } from './deploy-sha.js';

/** Body of GET /health and GET /. `commit` is the published git SHA.
 * "dev" means this bundle was not stamped by deploy-worker. Read `commit`,
 * not the latest Actions conclusion, to see which build is serving.
 */
export function healthBody(origin: string, authorizationServer: string) {
  return {
    ok: true as const,
    service: 'slashloop' as const,
    mode: 'remote' as const,
    public_url: origin,
    as: authorizationServer,
    tools: 'full' as const,
    db: 'parallel' as const,
    commit: DEPLOY_SHA,
  };
}
