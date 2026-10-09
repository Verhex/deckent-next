import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, CURRENT_LEDGER_VERSION, DECISION_PORT_LEDGER_VERSION, RUN_PARKING_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_V45_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const options={journalMode:'delete' as const,durability:'full' as const,busyTimeoutMs:1000};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'deckent-decision-migration-'));roots.push(root);const path=join(root,'ledger.db'),backups=join(root,'backups');await mkdir(backups,{mode:0o700});openSqliteLedger(path,options).close();const db=new DatabaseSync(path);db.exec(DOWNGRADE_TO_V45_LEDGER_SQL);return {path,backups,db};}
// Batch-27 integration: the lane's v45 is renumbered to v46 because A1/A3 (Run snapshot v4) own v45.
it('pins the decision port after A1/A3 run parking: v45 is Run parking, v46 decision custody',()=>{
 expect(RUN_PARKING_LEDGER_VERSION).toBe(45);expect(DECISION_PORT_LEDGER_VERSION).toBe(46);expect(CURRENT_LEDGER_VERSION).toBe(50);expect(PREVIOUS_LEDGER_VERSION).toBe(49);
});
it('v45 backup retains original rows and v46 adds only decision tables',async()=>{
 const f=await fixture();f.db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool','original-policy');f.db.close();
 const upgrade=await upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'));expect(upgrade).toMatchObject({from:45,to:CURRENT_LEDGER_VERSION});
 const current=new DatabaseSync(f.path,{readOnly:true}),backup=new DatabaseSync(upgrade!.backupPath,{readOnly:true});
 try{expect(current.prepare('SELECT * FROM execution_pools').all()).toEqual(backup.prepare('SELECT * FROM execution_pools').all());expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(45);expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
  expect(backup.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decision_%'").all()).toEqual([]);expect(current.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decision_%' ORDER BY name").all()).toHaveLength(2);
 }finally{current.close();backup.close();}
});
it('refuses a v45 same-name decision table even when columns superficially match and rolls version back',async()=>{
 const f=await fixture();f.db.exec('CREATE TABLE decision_cases(scope_id TEXT,decision_id TEXT,snapshot TEXT)');f.db.close();
 await expect(upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'))).rejects.toThrow();
 const check=new DatabaseSync(f.path,{readOnly:true});try{expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(45);expect(check.prepare("SELECT name FROM sqlite_master WHERE name='decision_command_receipts'").all()).toHaveLength(0);}finally{check.close();}
});
it('an upgraded v46 ledger is never reopened by a reader whose current version is older',async()=>{
 const f=await fixture();f.db.close();await upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'));
 // The version rule every Next build applies (schema.ts requireLedgerVersion/migrateLedger): user_version above its CURRENT is refused.
 // Simulated here as the next newer schema; the batch-26 (CURRENT 45) build refusing this exact v46 ledger is integration proof.
 const raw=new DatabaseSync(f.path);raw.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION+1}`);raw.close();
 expect(()=>openSqliteLedger(f.path,options,'forbid')).toThrow(expect.objectContaining({code:'ATTEMPT_STORE_VERSION'}));
 expect(()=>openSqliteLedger(f.path,options,'allow')).toThrow(expect.objectContaining({code:'ATTEMPT_STORE_VERSION'}));
});
it('lets the exact tables this migration created stand when a ledger is re-marked v45 (v39-v44 convention), and still records v46',async()=>{
 const f=await fixture();f.db.exec(`CREATE TABLE decision_cases(scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,snapshot TEXT NOT NULL,
  PRIMARY KEY(scope_id,decision_id));`);f.db.close();
 // decision_cases pre-exists byte-identical to the migration's own CREATE text; decision_command_receipts is created by the upgrade.
 const upgrade=await upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'));expect(upgrade).toMatchObject({from:45,to:CURRENT_LEDGER_VERSION});
 const check=new DatabaseSync(f.path,{readOnly:true});try{expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
  expect(check.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decision_%' ORDER BY name").all().map(row=>row.name)).toEqual(['decision_cases','decision_command_receipts']);}finally{check.close();}
});
