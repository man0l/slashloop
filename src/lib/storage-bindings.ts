// Registry for the Workers R2 bindings (slashloop-thumbs / slashloop-media).
//
// src/lib/storage.ts is imported by every runtime; on Workers the buckets are
// reached through the bindings registered here by src/cf/env.ts (no S3 keys,
// no sigv4), while Node/Bun runtimes keep the S3-API path. Bindings are stable
// per isolate, so a globalThis stash is the same pattern as the Prisma client.

export interface R2BindingPair {
  /** The public thumbs bucket (slashloop-thumbs). */
  thumbs: R2Bucket;
  /** The private media bucket (slashloop-media). */
  media: R2Bucket;
}

const globalForR2 = globalThis as unknown as { __slashloopR2Bindings?: R2BindingPair };

export function setR2Bindings(bindings: R2BindingPair): void {
  globalForR2.__slashloopR2Bindings = bindings;
}

export function getR2Bindings(): R2BindingPair | null {
  return globalForR2.__slashloopR2Bindings ?? null;
}
