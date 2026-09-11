// Request-scoped waitUntil, for work that must outlive a client abort.
//
// workerd cancels promises created in a request's IoContext when the client
// disconnects, and does not reject them — they hang forever. Caching those
// promises at isolate scope (Prisma engine start, the DB turn, lazy imports)
// then poisons every later request on the isolate. ctx.waitUntil() extends
// the IoContext so the promise can still settle; we stash the method on
// AsyncLocalStorage so db/cache code that has no ctx parameter can pin work.
//
// Never destructure `ctx.waitUntil` — that throws "Illegal invocation".

import { AsyncLocalStorage } from 'node:async_hooks';

export type WaitUntilFn = (promise: Promise<unknown>) => void;

const als = new AsyncLocalStorage<{ waitUntil: WaitUntilFn }>();

export function runWithWaitUntil<T>(waitUntil: WaitUntilFn | undefined, fn: () => T): T {
  if (!waitUntil) return fn();
  return als.run({ waitUntil }, fn);
}

/**
 * Pin `promise` to the current request's IoContext. Returns true when a
 * waitUntil is installed (Worker fetch/scheduled); false on Node/tests, where
 * abort-cancellation does not apply.
 */
export function keepAlive(promise: Promise<unknown>): boolean {
  const store = als.getStore();
  if (!store) return false;
  // Swallow rejection so waitUntil matches allSettled semantics and does not
  // surface as an unhandled rejection; the original awaiter still sees the error.
  store.waitUntil(promise.then(() => {}, () => {}));
  return true;
}
