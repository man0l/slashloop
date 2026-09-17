import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
const originalDialect = process.env.DB_DIALECT;
afterEach(() => { if (originalDialect === undefined) delete process.env.DB_DIALECT; else process.env.DB_DIALECT = originalDialect; });
import { creditStatements } from './store.js';
import type { Experiment } from './schema.js';
import { step, type EngineDeps } from './engine.js';
import { SafeFailure } from './providers.js';

test('SQLite refunds restore original credit buckets and reject a duplicate refund', () => {
  process.env.DB_DIALECT = 'sqlite';
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE Workspace(id TEXT PRIMARY KEY, planCredits INTEGER, packCredits INTEGER);
    CREATE TABLE Experiment(id TEXT PRIMARY KEY, dataJson TEXT);
    CREATE TABLE CreditLedger(id TEXT PRIMARY KEY, workspaceId TEXT, delta INTEGER, bucket TEXT, reason TEXT, tool TEXT, balanceAfter INTEGER NOT NULL, refId TEXT, createdAt TEXT);
    INSERT INTO Workspace VALUES ('w',2,10);`);
  const e = { id: 'e' } as Experiment;
  const next = { id: 'e', version: 1 } as Experiment;
  db.run('INSERT INTO Experiment VALUES (?,?)', ['e',JSON.stringify(next)]);
  function apply(charge: number) {
    db.transaction(() => {
      for (const s of creditStatements(e,next,'w',charge,'attempt-1')) {
        db.query(s.sql).all(...(s.params ?? []).map(v => v instanceof Date ? v.toISOString() : v) as any[]);
      }
    })();
  }
  apply(5);
  expect(db.query('SELECT planCredits,packCredits FROM Workspace').get()).toEqual({planCredits:0,packCredits:7});
  apply(-5);
  expect(db.query('SELECT planCredits,packCredits FROM Workspace').get()).toEqual({planCredits:2,packCredits:10});
  expect(() => apply(-5)).toThrow();
  expect(db.query('SELECT planCredits,packCredits FROM Workspace').get()).toEqual({planCredits:2,packCredits:10});
  db.close();
});

test('engine rejection atomically restores SQL balances while unknown outcomes retain them', async () => {
  process.env.DB_DIALECT = 'sqlite';
  for (const known of [true, false]) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE Workspace(id TEXT PRIMARY KEY, planCredits INTEGER, packCredits INTEGER);
      CREATE TABLE Experiment(id TEXT PRIMARY KEY, dataJson TEXT);
      CREATE TABLE CreditLedger(id TEXT PRIMARY KEY, workspaceId TEXT, delta INTEGER, bucket TEXT, reason TEXT, tool TEXT, balanceAfter INTEGER NOT NULL, refId TEXT, createdAt TEXT);
      INSERT INTO Workspace VALUES ('w',2,10);`);
    let row: Experiment = { id:'e', workspaceId:'w', version:0, status:'planning', creditsCharged:0, maxCredits:20,
      createdAt:'2026-09-16',updatedAt:'2026-09-16',variantCount:1,slideCount:3,report:null,error:null,
      instructions:{goal:'Test',brand:'',audience:'',language:'English',direction:'',lockedConstraints:[],variables:['hook'],mode:'controlled'},
      generationBasis:'text-directed',assetPolicy:'retained',commands:{},createFingerprint:'test',
      tasks:[{id:'t',kind:'analysis',target:'v',status:'pending',attempts:0,charged:0}],
      inputs:[{videoId:'v',status:'pending',analysisId:null,jobId:null,error:null,coverage:null,evidence:[]}],variants:[],allowPartial:false };
    db.run('INSERT INTO Experiment VALUES (?,?)',['e',JSON.stringify(row)]);
    const deps: EngineDeps = {
      load: async () => structuredClone(row), now: () => 1000,
      prepare: async () => ({execute: async () => { throw known ? new SafeFailure('rejected') : new Error('connection lost'); }}),
      save: async (e,charge=0,ref) => {
        if(e.version!==row.version)return false;
        const next={...e,version:e.version+1,creditsCharged:e.creditsCharged+charge};
        db.transaction(() => {
          db.run('UPDATE Experiment SET dataJson=? WHERE id=?',[JSON.stringify(next),e.id]);
          if(charge)for(const s of creditStatements(e,next,'w',charge,ref!)) db.query(s.sql).all(...(s.params??[]).map(v=>v instanceof Date?v.toISOString():v) as any[]);
        })();
        row=structuredClone(next);Object.assign(e,next);return true;
      },
    };
    await step('w','e',deps);
    await step('w','e',deps);
    expect(db.query('SELECT planCredits,packCredits FROM Workspace').get()).toEqual(known?{planCredits:2,packCredits:10}:{planCredits:0,packCredits:7});
    expect(row.creditsCharged).toBe(known?0:5);
    expect(row.status).toBe(known?'failed':'paused');
    expect(db.query("SELECT COUNT(*) AS n FROM CreditLedger WHERE reason='refund'").get()).toEqual({n:known?2:0});
    db.close();
  }
});
