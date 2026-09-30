/**
 * Positional binds for the sqlite CreditLedger INSERT columns
 * `refId`, `createdAt` — in that order.
 *
 * refId is the idempotency key. createdAt is the clock. Swapping them stores
 * the key in createdAt, and Prisma's DateTime read of the ledger throws on
 * the whole findMany (get_usage).
 */
export function creditLedgerRefAndCreatedAt(refId: string, createdAt: Date): [string, Date] {
  return [refId, createdAt];
}
