import { randomUUID } from 'node:crypto';
import { db, dbDialect, rawBatch, type Dialect, type RawStatement } from '../store.js';
import { resolveBillingWorkspace, InsufficientCreditsError } from '../lib/credits.js';
import { ExperimentError, normalizeRanBy, normalizeTestKey, slideTaskRequestCap, TERMINAL_STATUSES, type Experiment, type NotifyConfig } from './schema.js';
import { buildWebhookPayload, notifyReceipt, webhookIdempotencyKey } from './webhook-payload.js';
import { encodeExperiment } from './document-budget.js';

export async function batch(statements: RawStatement[]): Promise<unknown[][]> {
  if (dbDialect() === 'sqlite') return rawBatch(statements);
  return db.$transaction(async tx => {
    const out: unknown[][] = [];
    for (const s of statements) { let n = 0; out.push(await tx.$queryRawUnsafe(s.sql.replace(/\?/g, () => `$${++n}`), ...(s.params ?? []))); }
    return out;
  });
}
type ExperimentRow = { dataJson: string; ranBy: string | null; testKey?: string | null; notifyJson?: string | null };
/** The indexed columns are authoritative for ranBy and testKey; legacy rows have them NULL. */
const hydrate = (r: ExperimentRow): Experiment => ({ ...JSON.parse(r.dataJson), ranBy: r.ranBy ?? null, testKey: r.testKey ?? null });
const COLUMNS = '"dataJson","ranBy","testKey"';
/** Store access as an injectable seam: the default is the live database; tests pass a fixed executor so they do not depend on process-global module mocks (docs/test-suite-policy.md). */
export type Run = typeof batch;
export async function load(workspaceId: string, id: string, run: Run = batch): Promise<Experiment> {
  const result = await run([{ sql: `SELECT ${COLUMNS} FROM "Experiment" WHERE "id" = ? AND "workspaceId" = ?`, params: [id, workspaceId] }]);
  const row = result[0]?.[0] as ExperimentRow | undefined;
  if (!row) throw new ExperimentError(404, 'experiment_not_found');
  return hydrate(row);
}
export interface ListFilter { ranBy?: string | null; testKey?: string | null }
/**
 * Newest first. limit is capped server-side so a client can't pull unbounded.
 * ranBy and testKey are exact, workspace-scoped matches (each served by its
 * (workspaceId, column, createdAt) index); a blank filter is treated as no
 * filter. A bare string is the ranBy filter.
 */
export async function list(workspaceId: string, limit = 50, offset = 0, filter?: string | null | ListFilter, run: Run = batch): Promise<Experiment[]> {
  const lim = Math.max(1, Math.min(Math.floor(Number(limit) || 50), 50));
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const f: ListFilter = filter && typeof filter === 'object' ? filter : { ranBy: filter };
  const runner = normalizeRanBy(f.ranBy);
  const testKey = normalizeTestKey(f.testKey);
  const result = await run([{
    sql: `SELECT ${COLUMNS} FROM "Experiment" WHERE "workspaceId" = ?${runner ? ' AND "ranBy" = ?' : ''}${testKey ? ' AND "testKey" = ?' : ''} ORDER BY "createdAt" DESC LIMIT ? OFFSET ?`,
    params: [workspaceId, ...(runner ? [runner] : []), ...(testKey ? [testKey] : []), lim, off],
  }]);
  return (result[0] as ExperimentRow[]).map(hydrate);
}
/** Most attempts one test summary reads. A test is a handful of re-runs, not a feed. */
export const TEST_ATTEMPTS_MAX = 200;
export interface TestAttempt { experimentId: string; status: string; creditsCharged: number; maxCredits: number; error: string | null; createdAt: string }
export interface TestSummary {
  testKey: string; attempts: TestAttempt[]; attemptCount: number; creditsChargedTotal: number;
  /** The newest attempt's test_max_credits: the cap the test runs under now. Null = uncapped. */
  testMaxCredits: number | null; creditsRemaining: number | null; latestExperimentId: string | null; latestStatus: string | null;
  /** The newest attempt's goal, runner and source videos (attempts of one test may differ in fixes, not in what they test). */
  goal: string; ranBy: string | null; videoIds: string[];
}
/** Every attempt of one test, oldest first, with their spend added up. Null when the workspace has no experiment with this key. */
export async function testSummary(workspaceId: string, testKey: string, run: Run = batch): Promise<TestSummary | null> {
  const key = normalizeTestKey(testKey);
  if (!key) return null;
  const result = await run([{ sql: `SELECT ${COLUMNS} FROM "Experiment" WHERE "workspaceId" = ? AND "testKey" = ? ORDER BY "createdAt" ASC LIMIT ?`, params: [workspaceId, key, TEST_ATTEMPTS_MAX] }]);
  const rows = (result[0] as ExperimentRow[]).map(hydrate);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1]!;
  const creditsChargedTotal = rows.reduce((n, e) => n + (e.creditsCharged || 0), 0);
  const cap = latest.testMaxCredits ?? null;
  return {
    testKey: key,
    attempts: rows.map(e => ({ experimentId: e.id, status: e.status, creditsCharged: e.creditsCharged || 0, maxCredits: e.maxCredits, error: e.error ? e.error.slice(0, 300) : null, createdAt: e.createdAt })),
    attemptCount: rows.length,
    creditsChargedTotal,
    testMaxCredits: cap,
    creditsRemaining: cap === null ? null : Math.max(0, cap - creditsChargedTotal),
    latestExperimentId: latest.id,
    latestStatus: latest.status,
    goal: latest.instructions.goal,
    ranBy: latest.ranBy ?? null,
    videoIds: latest.inputs.map(i => i.videoId),
  };
}
/** Credits charged by the OTHER attempts of e's test (0 without a test key). */
export async function siblingCharged(e: Experiment, run: Run = batch): Promise<number> {
  if (!e.testKey) return 0;
  const result = await run([{ sql: `SELECT ${COLUMNS} FROM "Experiment" WHERE "workspaceId" = ? AND "testKey" = ? AND "id" <> ? LIMIT ?`, params: [e.workspaceId, e.testKey, e.id, TEST_ATTEMPTS_MAX] }]);
  return (result[0] as ExperimentRow[]).reduce((n, r) => n + (hydrate(r).creditsCharged || 0), 0);
}
/** Experiment owning a task id in this workspace, or null. Tasks live inside dataJson, so this scans text then confirms in JS. */
export async function findByTaskId(workspaceId: string, taskId: string): Promise<Experiment | null> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(taskId)) return null;
  const result = await batch([{ sql: 'SELECT "dataJson" FROM "Experiment" WHERE "workspaceId" = ? AND "dataJson" LIKE ? LIMIT 20', params: [workspaceId, `%"${taskId}"%`] }]);
  for (const row of result[0] as Array<{ dataJson: string }>) {
    const e: Experiment = JSON.parse(row.dataJson);
    if (e.tasks.some(t => t.id === taskId)) return e;
  }
  return null;
}
export async function remove(workspaceId: string, id: string): Promise<boolean> {
  const result = await batch([{ sql: 'DELETE FROM "Experiment" WHERE "id" = ? AND "workspaceId" = ? RETURNING "id"', params: [id, workspaceId] }]);
  return ((result[0] ?? []) as unknown[]).length > 0;
}
export async function create(e: Experiment, key: string, run: Run = batch, notify: NotifyConfig | null = null): Promise<Experiment> {
  const json = encodeExperiment(e);
  await run([{ sql: 'INSERT INTO "Experiment" ("id","workspaceId","status","version","dataJson","createdAt","updatedAt","createKey","ranBy","notifyJson","testKey") VALUES (?,?,?,0,?,?,?,?,?,?,?) ON CONFLICT ("workspaceId","createKey") DO NOTHING RETURNING "id"',
    params: [e.id,e.workspaceId,e.status,json,new Date(e.createdAt),new Date(e.updatedAt),key,normalizeRanBy(e.ranBy),notify ? JSON.stringify(notify) : null,normalizeTestKey(e.testKey)] }]);
  const result = await run([{ sql: `SELECT ${COLUMNS}${notify ? ',"notifyJson"' : ''} FROM "Experiment" WHERE "workspaceId" = ? AND "createKey" = ?`, params: [e.workspaceId,key] }]);
  const row = result[0]![0] as ExperimentRow;
  const prior = hydrate(row);
  if (prior.createFingerprint !== e.createFingerprint) throw new ExperimentError(409, 'idempotency_conflict');
  // A replay reports what the FIRST create stored (including its generated secret), not what this call asked for.
  if (row.notifyJson) prior.notify = notifyReceipt(JSON.parse(row.notifyJson) as NotifyConfig);
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
export function creditStatements(
  e: Experiment,
  next: Experiment & { writeToken: string },
  billingId: string,
  charge: number,
  ref: string,
  dialect: Dialect = dbDialect(),
): RawStatement[] {
  const token = dialect === 'sqlite' ? `json_extract("dataJson", '$.writeToken')` : `("dataJson"::jsonb ->> 'writeToken')`;
  const predicate = `EXISTS (SELECT 1 FROM "Experiment" WHERE "id"=? AND ${token}=?)`;
  const proof = [e.id, next.writeToken];
  const min = dialect === 'sqlite' ? 'MIN' : 'LEAST';
  const max = dialect === 'sqlite' ? 'MAX' : 'GREATEST';
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
/** Outbox INSERT for a transition into a terminal status; selects zero rows unless the stored row is still non-terminal at `e.version` and has notify config. */
export function outboxStatement(e: Experiment, next: Experiment, gate: string, gateParams: unknown[]): RawStatement {
  const terminal = TERMINAL_STATUSES.map(() => '?').join(',');
  return { sql: `INSERT INTO "ExperimentWebhookOutbox" ("id","experimentId","workspaceId","status","version","idempotencyKey","notifyJson","payloadJson","state","attempts","nextAttemptAt","createdAt") SELECT ?,"id","workspaceId",?,?,?,"notifyJson",?,'pending',0,?,? FROM "Experiment" WHERE "id"=? AND "workspaceId"=? AND "version"=? AND "notifyJson" IS NOT NULL AND "status" NOT IN (${terminal})${gate} ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING "id"`,
    params: [randomUUID(),next.status,next.version,webhookIdempotencyKey(e.id,next.status,next.version),JSON.stringify(buildWebhookPayload(next)),new Date(),new Date(),e.id,e.workspaceId,e.version,...TERMINAL_STATUSES,...gateParams] };
}
/** SQL for "credits charged by the other attempts of this test", read from each row's dataJson. */
export function siblingChargedSql(dialect: Dialect = dbDialect()): string {
  const charged = dialect === 'sqlite' ? `CAST(json_extract("dataJson", '$.creditsCharged') AS INTEGER)` : `(("dataJson"::jsonb ->> 'creditsCharged')::numeric)`;
  return `(SELECT COALESCE(SUM(${charged}),0) FROM "Experiment" WHERE "workspaceId"=? AND "testKey"=? AND "id"<>?)`;
}
export const testBudgetExceeded = (e: Experiment, others: number, wanted: number) => new ExperimentError(402, 'test_budget_exceeded',
  `Test "${e.testKey}" is capped at ${e.testMaxCredits} credits across all its experiments; ${others} are already charged by other attempts, so ${wanted} more on this one would pass the cap. Raise test_max_credits on a new attempt only with the user's approval.`);
/** Every API mutation and step acquisition uses this CAS, including cancellation. */
export async function save(e: Experiment, charge = 0, chargeRef?: string, refunds: ReadonlyArray<{ ref: string; amount: number }> = [], run: Run = batch): Promise<boolean> {
  const previous = e.version;
  const refunded = refunds.reduce((n, r) => n + r.amount, 0);
  const next = { ...e, writeToken: randomUUID(), version: previous + 1, updatedAt: new Date().toISOString(), creditsCharged: e.creditsCharged + charge - refunded };
  if (next.creditsCharged > e.maxCredits) throw new ExperimentError(402, 'experiment_budget_exceeded');
  if (charge < 0 && !chargeRef) throw new ExperimentError(500, 'refund_requires_charge_ref');
  // SLA-806: a charge on a capped test must also fit the test's cap, counting every other attempt's spend. Checked here
  // for a clear error, and again inside the CAS so two attempts charging at once cannot both slip under it.
  const testCapped = charge > 0 && !!e.testKey && typeof e.testMaxCredits === 'number';
  if (testCapped) {
    const others = await siblingCharged(e, run);
    if (others + next.creditsCharged > e.testMaxCredits!) throw testBudgetExceeded(e, others, charge);
  }
  const json = encodeExperiment(next);
  const statements: RawStatement[] = [];
  let billingId = '';
  if (charge !== 0 || refunds.length) {
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: e.workspaceId } });
    billingId = (await resolveBillingWorkspace(workspace)).id;
  }
  const walletGate = charge > 0 ? ' AND EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = ? AND "planCredits" + "packCredits" >= ?)' : '';
  const testGate = testCapped ? ` AND ${siblingChargedSql()} + ? <= ?` : '';
  const gate = walletGate + testGate;
  const gateParams = [...(charge > 0 ? [billingId, charge] : []), ...(testCapped ? [e.workspaceId, e.testKey, e.id, next.creditsCharged, e.testMaxCredits] : [])];
  // SLA-617: queue the completion webhook for a non-terminal -> terminal move. It runs BEFORE the UPDATE so it can
  // read the stored (pre-transition) status, under the same id/version/credit predicate as the CAS, and the whole
  // batch is atomic: the event exists if and only if this exact transition committed. Experiments without notify
  // config select no row, and non-terminal saves add no statement at all.
  const queued = (TERMINAL_STATUSES as readonly string[]).includes(next.status);
  if (queued) statements.push(outboxStatement(e, next, gate, gateParams));
  statements.push({ sql: `UPDATE "Experiment" SET "dataJson"=?, "version"=?, "status"=?, "updatedAt"=? WHERE "id"=? AND "workspaceId"=? AND "version"=?${gate} RETURNING "id"`,
    params: [json,next.version,next.status,new Date(next.updatedAt),e.id,e.workspaceId,previous,...gateParams] });
  // Fresh unpredictable receipt only exists if OUR exact JSON CAS succeeded.
  // Ledger and account debit are in the SAME D1 batch: no debit/checkpoint gap.
  if (charge !== 0) {
    statements.push(...creditStatements(e, next, billingId, charge, chargeRef ?? `experiment:${e.id}:${randomUUID()}`));
  }
  // Every additional refund rides the same batch as the experiment CAS, so terminal status and all refunds settle together or not at all.
  for (const r of refunds) statements.push(...creditStatements(e, next, billingId, -r.amount, r.ref));
  const result = await run(statements);
  if (!result[queued ? 1 : 0]?.length) {
    if (charge > 0 && (await load(e.workspaceId,e.id,run)).version === previous) {
      if (testCapped) {
        const others = await siblingCharged(e, run);
        if (others + next.creditsCharged > e.testMaxCredits!) throw testBudgetExceeded(e, others, charge);
      }
      throw new InsufficientCreditsError(e.workspaceId,charge,0);
    }
    return false;
  }
  Object.assign(e,next); return true;
}
export async function candidates(): Promise<Array<{ id: string; workspaceId: string }>> {
  const result = await batch([{ sql: 'SELECT "id","workspaceId" FROM "Experiment" WHERE "status" IN (\'planning\',\'generating\') ORDER BY "updatedAt" ASC LIMIT 3' }]);
  return result[0] as Array<{ id: string; workspaceId: string }>;
}
/** Authorized total: the planning jobs' 2x allowance plus each slide task's frozen cap (explicit retry grants included). */
export function maxProviderRequests(e: Experiment): number {
  const planned = e.variantCount * e.slideCount * slideTaskRequestCap();
  const frozen = e.tasks.filter(t => t.kind === 'slide').reduce((n, t) => n + (t.requestCap ?? slideTaskRequestCap()), 0);
  return 2 * (e.inputs.length + 2) + Math.max(planned, frozen);
}
export function serialize(e: Experiment) {
  const { tasks, commands, createFingerprint, version, allowPartial, ...publicData } = e;
  // Compact per-job projection so the UI can offer manual retry on a single failed job.
  const jobs = tasks.map(({ id, kind, target, index, status, error, attempts, nextAttemptAt, startedAt }) => ({ id, kind, target, index, status, error, attempts, nextAttemptAt, startedAt }));
  return { ...publicData, jobs, inputs: e.inputs.map(({ evidence, ...input }) => input), variants: e.variants.map(({ history, frozenBrief, ...v }) => v),
    providerBudget: { maxRequests: maxProviderRequests(e), requestsStarted: tasks.reduce((n,t) => n+(t.requests ?? t.attempts),0), exactUsdCap: false } };
}
