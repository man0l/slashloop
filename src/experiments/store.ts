import { randomUUID } from 'node:crypto';
import { db, dbDialect, rawBatch, type RawStatement } from '../store.js';
import { resolveBillingWorkspace, InsufficientCreditsError } from '../lib/credits.js';
import { ExperimentError, type Experiment } from './schema.js';
import { encodeExperiment } from './document-budget.js';

export async function batch(statements: RawStatement[]): Promise<unknown[][]> {
  if (dbDialect() === 'sqlite') return rawBatch(statements);
  return db.$transaction(async tx => {
    const out: unknown[][] = [];
    for (const s of statements) { let n = 0; out.push(await tx.$queryRawUnsafe(s.sql.replace(/\?/g, () => `$${++n}`), ...(s.params ?? []))); }
    return out;
  });
}
export async function load(workspaceId: string, id: string): Promise<Experiment> {
  const result = await batch([{ sql: 'SELECT "dataJson" FROM "Experiment" WHERE "id" = ? AND "workspaceId" = ?', params: [id, workspaceId] }]);
  const row = result[0]?.[0] as { dataJson: string } | undefined;
  if (!row) throw new ExperimentError(404, 'experiment_not_found');
  return JSON.parse(row.dataJson);
}
export async function list(workspaceId: string): Promise<Experiment[]> {
  const result = await batch([{ sql: 'SELECT "dataJson" FROM "Experiment" WHERE "workspaceId" = ? ORDER BY "createdAt" DESC LIMIT 50', params: [workspaceId] }]);
  return (result[0] as Array<{ dataJson: string }>).map(r => JSON.parse(r.dataJson));
}
export async function create(e: Experiment, key: string): Promise<Experiment> {
  const json = encodeExperiment(e);
  await batch([{ sql: 'INSERT INTO "Experiment" ("id","workspaceId","status","version","dataJson","createdAt","updatedAt","createKey") VALUES (?,?,?,0,?,?,?,?) ON CONFLICT ("workspaceId","createKey") DO NOTHING RETURNING "id"',
    params: [e.id,e.workspaceId,e.status,json,new Date(e.createdAt),new Date(e.updatedAt),key] }]);
  const result = await batch([{ sql: 'SELECT "dataJson" FROM "Experiment" WHERE "workspaceId" = ? AND "createKey" = ?', params: [e.workspaceId,key] }]);
  const prior: Experiment = JSON.parse((result[0]![0] as { dataJson: string }).dataJson);
  if (prior.createFingerprint !== e.createFingerprint) throw new ExperimentError(409, 'idempotency_conflict');
  return prior;
}
/**
 * Ledger + debit/restore rows for one credit movement, gated on our exact
 * experiment CAS. charge > 0 splits the debit across plan/pack buckets by the
 * balance actually available (a zero-delta row keeps the bucket split exact);
 * charge < 0 refunds by mirroring the original charge rows with inverted
 * deltas under each bucket ref + ':refund' — the deterministic ids make a duplicate
 * refund violate the ledger primary key instead of double-crediting.
 */
export function creditStatements(e: Experiment, next: Experiment & { writeToken: string }, billingId: string, charge: number, ref: string): RawStatement[] {
  const token = dbDialect() === 'sqlite' ? `json_extract("dataJson", '$.writeToken')` : `("dataJson"::jsonb ->> 'writeToken')`;
  const predicate = `EXISTS (SELECT 1 FROM "Experiment" WHERE "id"=? AND ${token}=?)`;
  const proof = [e.id, next.writeToken];
  const min = dbDialect() === 'sqlite' ? 'MIN' : 'LEAST';
  const max = dbDialect() === 'sqlite' ? 'MAX' : 'GREATEST';
  if (charge < 0) {
    const amount = -charge;
    return [
      { sql: `INSERT INTO "CreditLedger" ("id","workspaceId","delta","bucket","reason","tool","balanceAfter","refId","createdAt") SELECT l."id"||':refund',l."workspaceId",-l."delta",l."bucket",'refund','experiment',(SELECT w."planCredits"+w."packCredits" FROM "Workspace" w WHERE w."id"=?)+?,l."refId"||':refund',? FROM "CreditLedger" l WHERE l."workspaceId"=? AND ((l."refId"=? AND l."bucket"='plan') OR (l."refId"=? AND l."bucket"='pack')) AND l."delta"<0 AND ${predicate} RETURNING "id"`,
        params: [billingId,amount,new Date(),billingId,`${ref}:plan`,`${ref}:pack`,...proof] },
      { sql: `UPDATE "Workspace" SET "planCredits"="planCredits"+COALESCE((SELECT SUM("delta") FROM "CreditLedger" WHERE "refId"=? AND "workspaceId"=? AND "bucket"='plan'),0),"packCredits"="packCredits"+COALESCE((SELECT SUM("delta") FROM "CreditLedger" WHERE "refId"=? AND "workspaceId"=? AND "bucket"='pack'),0) WHERE "id"=? AND ${predicate} RETURNING "id"`,
        params: [`${ref}:plan:refund`,billingId,`${ref}:pack:refund`,billingId,billingId,...proof] },
    ];
  }
  return [
    ...(['plan', 'pack'] as const).map((bucket): RawStatement => {
      const deltaExpr = bucket === 'plan' ? `${min}("planCredits",?)` : `${max}(0,?-"planCredits")`;
      const balanceExpr = bucket === 'plan' ? `"planCredits"+"packCredits"-${min}("planCredits",?)` : `"planCredits"+"packCredits"-?`;
      return { sql: `INSERT INTO "CreditLedger" ("id","workspaceId","delta","bucket","reason","tool","balanceAfter","refId","createdAt") SELECT ?,?,-${deltaExpr},?,'tool_call','experiment',${balanceExpr},?,? FROM "Workspace" WHERE "id"=? AND ${predicate} RETURNING "id"`,
        params: [randomUUID(),billingId,charge,bucket,charge,`${ref}:${bucket}`,new Date(),billingId,...proof] };
    }),
    { sql: `UPDATE "Workspace" SET "planCredits"="planCredits"-${min}("planCredits",?), "packCredits"="packCredits"-${max}(0,?-"planCredits") WHERE "id"=? AND ${predicate} RETURNING "id"`,
      params: [charge,charge,billingId,...proof] },
  ];
}
/** Every API mutation and step acquisition uses this CAS, including cancellation. */
export async function save(e: Experiment, charge = 0, chargeRef?: string): Promise<boolean> {
  const previous = e.version;
  const next = { ...e, writeToken: randomUUID(), version: previous + 1, updatedAt: new Date().toISOString(), creditsCharged: e.creditsCharged + charge };
  if (next.creditsCharged > e.maxCredits) throw new ExperimentError(402, 'experiment_budget_exceeded');
  if (charge < 0 && !chargeRef) throw new ExperimentError(500, 'refund_requires_charge_ref');
  const json = encodeExperiment(next);
  const statements: RawStatement[] = [];
  let billingId = '';
  if (charge !== 0) {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: e.workspaceId } });
    billingId = (await resolveBillingWorkspace(workspace)).id;
  }
  const gate = charge > 0 ? ' AND EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = ? AND "planCredits" + "packCredits" >= ?)' : '';
  statements.push({ sql: `UPDATE "Experiment" SET "dataJson"=?, "version"=?, "status"=?, "updatedAt"=? WHERE "id"=? AND "workspaceId"=? AND "version"=?${gate} RETURNING "id"`,
    params: [json,next.version,next.status,new Date(next.updatedAt),e.id,e.workspaceId,previous,...(charge > 0 ? [billingId,charge] : [])] });
  // Fresh unpredictable receipt only exists if OUR exact JSON CAS succeeded.
  // Ledger and account debit are in the SAME D1 batch: no debit/checkpoint gap.
  if (charge !== 0) {
    statements.push(...creditStatements(e, next, billingId, charge, chargeRef ?? `experiment:${e.id}:${randomUUID()}`));
  }
  const result = await batch(statements);
  if (!result[0]?.length) {
    if (charge > 0 && (await load(e.workspaceId,e.id)).version === previous) throw new InsufficientCreditsError(e.workspaceId,charge,0);
    return false;
  }
  Object.assign(e,next); return true;
}
export async function candidates(): Promise<Array<{ id: string; workspaceId: string }>> {
  const result = await batch([{ sql: 'SELECT "id","workspaceId" FROM "Experiment" WHERE "status" IN (\'planning\',\'generating\') ORDER BY "updatedAt" ASC LIMIT 3' }]);
  return result[0] as Array<{ id: string; workspaceId: string }>;
}
export function serialize(e: Experiment) {
  const { tasks, commands, createFingerprint, version, allowPartial, ...publicData } = e;
  return { ...publicData, inputs: e.inputs.map(({ evidence, ...input }) => input), variants: e.variants.map(({ history, frozenBrief, ...v }) => v),
    providerBudget: { maxRequests: 2 * (e.inputs.length + 2 + e.variantCount * e.slideCount), requestsStarted: tasks.reduce((n,t) => n+t.attempts,0), exactUsdCap: false } };
}
