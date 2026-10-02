import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { upgradeExistingProductLedger } from '#adapters/index.js';
import { DOWNGRADE_TO_PREVIOUS_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const options={journalMode:'delete' as const,durability:'full' as const,busyTimeoutMs:1000};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'deckent-decision-migration-'));roots.push(root);const path=join(root,'ledger.db'),backups=join(root,'backups');await mkdir(backups,{mode:0o700});openSqliteLedger(path,options).close();const db=new DatabaseSync(path);db.exec(DOWNGRADE_TO_PREVIOUS_LEDGER_SQL);return {path,backups,db};}
it('v44 backup retains original rows and v45 adds only decision tables',async()=>{
 const f=await fixture();f.db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('pool','original-policy');f.db.close();
 const upgrade=await upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'));expect(upgrade).toMatchObject({from:44,to:45});
 const current=new DatabaseSync(f.path,{readOnly:true}),backup=new DatabaseSync(upgrade!.backupPath,{readOnly:true});
 try{expect(current.prepare('SELECT * FROM execution_pools').all()).toEqual(backup.prepare('SELECT * FROM execution_pools').all());expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(44);
  expect(backup.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decision_%'").all()).toEqual([]);expect(current.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decision_%' ORDER BY name").all()).toHaveLength(2);
 }finally{current.close();backup.close();}
});
it('refuses a v44 same-name decision table even when columns superficially match and rolls version back',async()=>{
 const f=await fixture();f.db.exec('CREATE TABLE decision_cases(scope_id TEXT,decision_id TEXT,snapshot TEXT)');f.db.close();
 await expect(upgradeExistingProductLedger(f.path,options,f.backups,new Date('2026-10-02T12:00:00Z'))).rejects.toThrow();
 const check=new DatabaseSync(f.path,{readOnly:true});try{expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(44);expect(check.prepare("SELECT name FROM sqlite_master WHERE name='decision_command_receipts'").all()).toHaveLength(0);}finally{check.close();}
});
