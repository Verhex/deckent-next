import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { decisionRecordSchema, encodeCommandProjection, type AuditEvent } from '#domain/index.js';
import { DecisionApplicationError, validateDecisionSnapshot, type DecisionStore, type DecisionSnapshot, type DecisionMutationReceipt } from '#engine/index.js';
import { AuditApplication } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, DECISION_PORT_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
class SqliteDecisionStore implements DecisionStore {
 private readonly audit:AuditApplication;
 constructor(private readonly db:DatabaseSync,private readonly integrity:IntegrityAuthority){this.audit=new AuditApplication(new SqliteAuditStore(db),integrity);}
 private seal(value:unknown){const body=encodeCommandProjection('decision-store:1',value);return JSON.stringify({value,keyId:this.integrity.keyId,mac:this.integrity.sign(body)});}
 private decode(input:unknown):unknown {try{const sealed=JSON.parse(String(input)) as {value:unknown;mac:string;keyId:string};
  if(!this.integrity.verify(encodeCommandProjection('decision-store:1',sealed.value),sealed.mac,sealed.keyId))throw Error();return sealed.value;
 }catch{throw new DecisionApplicationError('DECISION_CORRUPT');}}
 private transaction<T>(work:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{/* uncertain commit remains unknown */}throw error;}}
 private read(scopeId:string,decisionId:string){const row=this.db.prepare('SELECT snapshot FROM decision_cases WHERE scope_id=? AND decision_id=?').get(scopeId,decisionId);
  if(!row)return null;const value=validateDecisionSnapshot(this.decode(row.snapshot));if(value.scopeId!==scopeId||value.decisionId!==decisionId)throw new DecisionApplicationError('DECISION_CORRUPT');return value;}
 async load(scopeId:string,decisionId:string){return this.read(scopeId,decisionId);}
 async claim(input:DecisionSnapshot,event:AuditEvent){const snapshot=validateDecisionSnapshot(input);return this.transaction(()=>{
  const prior=this.read(snapshot.scopeId,snapshot.decisionId);if(prior)return {replayed:true,snapshot:prior};
  if(this.readReceipt(snapshot.scopeId,snapshot.decisionId))throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');
  this.audit.record(event);this.db.prepare('INSERT INTO decision_cases(scope_id,decision_id,snapshot) VALUES(?,?,?)').run(snapshot.scopeId,snapshot.decisionId,this.seal(snapshot));
  return {replayed:false,snapshot};});}
 async settle(previous:DecisionSnapshot,input:DecisionSnapshot,event:AuditEvent){const next=validateDecisionSnapshot(input);return this.transaction(()=>{
  this.assertCurrent(previous);if(previous.status!=='pending'||next.status==='pending')throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');
  this.audit.record(event);this.write(next);return next;});}
 private assertCurrent(previous:DecisionSnapshot){if(!isDeepStrictEqual(this.read(previous.scopeId,previous.decisionId),previous))throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');}
 private write(next:DecisionSnapshot){this.db.prepare('UPDATE decision_cases SET snapshot=? WHERE scope_id=? AND decision_id=?').run(this.seal(next),next.scopeId,next.decisionId);}
 private readReceipt(scopeId:string,commandId:string):DecisionMutationReceipt|null {const row=this.db.prepare('SELECT decision_id,receipt FROM decision_command_receipts WHERE scope_id=? AND command_id=?').get(scopeId,commandId);
  if(!row)return null;const receipt=this.decode(row.receipt) as DecisionMutationReceipt;
  if(receipt.scopeId!==scopeId||receipt.commandId!==commandId||receipt.decisionId!==row.decision_id||!decisionRecordSchema.safeParse(receipt.result.record).success)throw new DecisionApplicationError('DECISION_CORRUPT');return receipt;}
 async receipt(scopeId:string,commandId:string){return this.readReceipt(scopeId,commandId);}
 async mutate(previous:DecisionSnapshot,input:DecisionSnapshot,receipt:DecisionMutationReceipt,event:AuditEvent){const next=validateDecisionSnapshot(input);return this.transaction(()=>{
  const replay=this.readReceipt(receipt.scopeId,receipt.commandId);if(replay){if(replay.digest!==receipt.digest)throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');return {replayed:true,record:replay.result.record};}
  if(this.read(receipt.scopeId,receipt.commandId))throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');
  this.assertCurrent(previous);if(!next.record)throw new DecisionApplicationError('DECISION_CORRUPT');
  this.audit.record(event);this.write(next);this.db.prepare('INSERT INTO decision_command_receipts(scope_id,command_id,decision_id,receipt) VALUES(?,?,?,?)').run(receipt.scopeId,receipt.commandId,receipt.decisionId,this.seal(receipt));
  return {replayed:false,record:next.record};});}
 close(){this.db.close();}
}
export function openSqliteDecisionStore(path:string,options:SqliteLedgerOptions,integrity:IntegrityAuthority,access:'read'|'write'):DecisionStore {
 if(access==='write')return new SqliteDecisionStore(openSqliteLedger(path,options,'forbid'),integrity);
 const {DatabaseSync:NativeDatabase}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
 const db=new NativeDatabase(path,{readOnly:true,timeout:options.busyTimeoutMs,enableForeignKeyConstraints:true});
 try{requireLedgerVersion(db,DECISION_PORT_LEDGER_VERSION);return new SqliteDecisionStore(db,integrity);}catch(error){db.close();throw error;}
}
