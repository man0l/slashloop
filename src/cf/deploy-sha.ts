/** Stamped by deploy-worker immediately before `wrangler deploy`.
 * Local, tests, and any bundle that skipped the stamp stay "dev".
 * GET /health returns this as `commit` so the live worker can be identified
 * without reading GitHub.
 */
export const DEPLOY_SHA = "dev";
