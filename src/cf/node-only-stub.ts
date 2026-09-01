// Alias target for Node-only dependencies (see "alias" in wrangler.jsonc).
//
// The Worker bundle must never include native/Node-only packages (impit,
// playwright, @prisma/client's engine…). Shared modules reach them only via
// runtime-guarded dynamic imports that never execute on Workers; aliasing
// them here lets esbuild resolve those imports without following the real
// package graph. Importing anything from these at runtime on a Worker is a
// programming error — the stub returns undefined properties so the failure
// is a clean TypeError at the misuse site, not a bundling failure at deploy.
export default new Proxy(
  {},
  { get(_target, prop) {
      throw new Error(`Node-only module member "${String(prop)}" is unavailable in Workers`);
    } },
);
