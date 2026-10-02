import { randomUUID } from 'node:crypto';
import { DecisionApplication, DecisionPolicyAuthorization, decisionPrepareInputSchema, decisionAskCommandSchema, decisionRecordCommandSchema, decisionOutcomeCommandSchema, decisionQuerySchema, type DecisionAction } from '#engine/index.js';
import { openSqliteDecisionStore, readDecisionPolicy, openLocalIntegrityAuthority } from '#adapters/index.js';
import { SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { userInfo } from 'node:os';
async function execute(projectRoot:string,action:DecisionAction,input:unknown,options:ConfigLoadOptions,signal?:AbortSignal){
 try{
  const parsed=(action==='prepare'?decisionPrepareInputSchema:action==='ask'?decisionAskCommandSchema:action==='record'?decisionRecordCommandSchema:action==='outcome'?decisionOutcomeCommandSchema:decisionQuerySchema).parse(input);
  const scopeId='scopeId'in parsed?parsed.scopeId:parsed.case.scope; const access=action==='prepare'||action==='inspect'?'read':'write';
  const context=await loadConfiguredScopeContext(projectRoot,scopeId,{...options,heal:false},access);
  const source=createLayoutPolicySource(context.layout,userInfo().uid,context.config.inspection.policyMaxBytes); const clock=new SystemTrustedClock(); const app=new DecisionApplication({verifier:{verify:async()=>context.principal},policy:async()=>readDecisionPolicy(context.config),
   authorize:(...args)=>new DecisionPolicyAuthorization(source).authorize(...args),openStore:async(mode)=>{
    // Queries never create an integrity key, a database or a migration. The service owns backed-up upgrades.
    const integrity=await openLocalIntegrityAuthority(context.layout,context.config.approvals.keyFile,mode==='write');
    return openSqliteDecisionStore(await context.path(),context.config.storage.sqlite,integrity,mode);
   },invoke:async(command,_credential,abort)=>invokeConfiguredModel(projectRoot,command,{...options,heal:false},abort),now:()=>clock.sample().wallMs,eventId:randomUUID});
  if(action==='prepare')return await app.prepare(parsed);
  if(action==='ask')return await app.ask(parsed,undefined,signal);
  if(action==='record')return await app.decide(parsed);
  if(action==='outcome')return await app.outcome(parsed);
  return await app.inspect(parsed);
 }catch(error){throw queryFailure(error);}
}
export function prepareConfiguredDecision(projectRoot:string,input:unknown,options:ConfigLoadOptions={}){return execute(projectRoot,'prepare',input,options) as ReturnType<DecisionApplication['prepare']>;}
export function askConfiguredDecision(projectRoot:string,input:unknown,options:ConfigLoadOptions={},signal?:AbortSignal){return execute(projectRoot,'ask',input,options,signal) as ReturnType<DecisionApplication['ask']>;}
export function recordConfiguredDecision(projectRoot:string,input:unknown,options:ConfigLoadOptions={}){return execute(projectRoot,'record',input,options) as ReturnType<DecisionApplication['decide']>;}
export function outcomeConfiguredDecision(projectRoot:string,input:unknown,options:ConfigLoadOptions={}){return execute(projectRoot,'outcome',input,options) as ReturnType<DecisionApplication['outcome']>;}
export function inspectConfiguredDecision(projectRoot:string,input:unknown,options:ConfigLoadOptions={}){return execute(projectRoot,'inspect',input,options) as ReturnType<DecisionApplication['inspect']>;}
