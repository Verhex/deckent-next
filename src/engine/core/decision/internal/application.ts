import { isDeepStrictEqual } from 'node:util';
import { decisionRecordSchema, encodeCommandProjection, prepareDecisionCase, encodeDecisionAdvice, validateDecisionAdvice, decisionObservationIsFuture, DECISION_ABSTENTIONS,
 type AuditEvent, type VerifiedPrincipal, type ModelInvocationCommand } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { parseModelInvocationResultForCommand } from '#engine/core/model-invocation/index.js';
import { decisionPrepareInputSchema, decisionAskCommandSchema, decisionQuerySchema, decisionRecordCommandSchema, decisionOutcomeCommandSchema,
 DecisionApplicationError, type DecisionDependencies, type DecisionPrepareResult, type DecisionAskResult, type DecisionInspection,
 type DecisionSnapshot, type DecisionRecordResult, type DecisionAction, type DecisionMutationReceipt } from './contract.js';
import { validateDecisionSnapshot } from './snapshot.js';
function publicResult(value:DecisionSnapshot,replayed:boolean):DecisionAskResult {return Object.freeze({schemaVersion:1,status:value.status==='pending'?'unknown':value.status,
 decisionId:value.decisionId,caseDigest:value.caseDigest,advice:value.advice,adviceDigest:value.adviceDigest,thresholds:value.policy.thresholds,
 invocationId:value.invocationId,record:value.record,replayed});}
/** Sole owner of advisory transitions. No operation admission or approval authority is accepted or returned. */
export class DecisionApplication {
 constructor(private readonly deps:DecisionDependencies){}
 private async policy(){const value=await this.deps.policy();if(!value)throw new DecisionApplicationError('DECISION_UNAVAILABLE');return value;}
 private async admission(action:DecisionAction,scopeId:string,id:string,credential?:unknown){
  const principal=await authenticate(this.deps.verifier,credential,scopeId);
  const authorization=await this.deps.authorize(action,scopeId,id,principal);return {principal,authorization};
 }
 private event(value:DecisionSnapshot,principal:VerifiedPrincipal,revision:string,action:'ask'|'record'|'outcome',phase:'admitted'|'observed'):AuditEvent {
  return {schemaVersion:1,eventId:this.deps.eventId(),scopeId:value.scopeId,principal:{issuer:principal.issuer,subject:principal.subject},
   policyRevision:revision,atMs:this.deps.now(),subject:{kind:'decision-port',action,phase,decisionId:value.decisionId,caseDigest:value.caseDigest,
    adviceDigest:value.adviceDigest,selectedOption:value.record?.actor.selectedOption??null}};
 }
 async prepare(input:unknown,credential?:unknown):Promise<DecisionPrepareResult>{
  const command=decisionPrepareInputSchema.parse(input);await this.admission('prepare',command.case.scope,command.case.scope,credential);
  const policy=await this.policy(),prepared=prepareDecisionCase(command.case,policy,this.deps.now());
  return Object.freeze({schemaVersion:1,case:prepared.case,caseDigest:sha256(prepared.canonicalCase),thresholds:policy.thresholds});
 }
 async ask(input:unknown,credential?:unknown,signal?:AbortSignal):Promise<DecisionAskResult>{
  const command=decisionAskCommandSchema.parse(input),{principal,authorization}=await this.admission('ask',command.scopeId,command.commandId,credential);
  if(command.case.scope!==command.scopeId)throw new DecisionApplicationError('DECISION_INVALID');
  const policy=await this.policy(),at=this.deps.now(),prepared=prepareDecisionCase(command.case,policy,at);
  const snapshot:DecisionSnapshot={schemaVersion:1,scopeId:command.scopeId,decisionId:command.commandId,command,requestDigest:sha256(encodeCommandProjection('decision-ask:1',command)),
   caseDigest:sha256(prepared.canonicalCase),policy,principal,policyRevision:authorization.revision,claimedAtMs:at,status:'pending',advice:null,adviceDigest:null,invocationId:null,record:null};
  const store=await this.deps.openStore('write');
  try {
   const claimed=await store.claim(snapshot,this.event(snapshot,principal,authorization.revision,'ask','admitted'));
   const prior=validateDecisionSnapshot(claimed.snapshot);
   if(prior.requestDigest!==snapshot.requestDigest||!isDeepStrictEqual(prior.principal,principal))throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');
   // A pending replay is uncertain custody, never permission to repeat a possibly billed call.
   if(claimed.replayed)return publicResult(prior,true);
   let next:DecisionSnapshot={...prior,status:'unknown'};
   if(signal?.aborted)next={...next,status:'cancelled'};
   else {
    const invocation:ModelInvocationCommand={schemaVersion:1,commandId:command.commandId,scopeId:command.scopeId,...command.invocation,
     nativeRequest:{schemaVersion:1,case:prepared.case}};
    try {
     const result=parseModelInvocationResultForCommand(invocation,await this.deps.invoke(invocation,credential,signal));
     if(result.receipt.actor.id!==principal.id||result.receipt.actor.issuer!==principal.issuer||result.receipt.actor.subject!==principal.subject)throw new DecisionApplicationError('DECISION_CORRUPT');
     next={...next,invocationId:result.receipt.claim.invocationId};
     if(result.response&&result.receipt.outcome?.state==='responded'){
      const checked=validateDecisionAdvice(result.response.native['decisionAdvice'],prepared.case,policy);
      next={...next,status:checked.status,advice:checked.advice,adviceDigest:sha256(encodeDecisionAdvice(checked.advice))};
     }else if(result.receipt.outcome?.state==='not-sent')next={...next,status:'cancelled'};
     else if(result.receipt.outcome?.state==='rejected')next={...next,status:'unavailable'};
    }catch(error){
     const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
     // Unknown settlement has durable invocation custody; all other refused admission remains unavailable advice.
     next={...next,status:code==='MODEL_INVOCATION_OUTCOME_UNKNOWN'?'unknown':signal?.aborted?'cancelled':'unavailable'};
    }
   }
   try{return publicResult(validateDecisionSnapshot(await store.settle(prior,next,this.event(next,principal,authorization.revision,'ask','observed'))),false);}
   catch{return publicResult(prior,false);}
  }finally{store.close();}
 }
 async inspect(input:unknown,credential?:unknown):Promise<DecisionInspection>{
  const query=decisionQuerySchema.parse(input);await this.admission('inspect',query.scopeId,query.decisionId,credential);
  const store=await this.deps.openStore('read');try{const row=await store.load(query.scopeId,query.decisionId);
   if(!row)return {schemaVersion:1,status:'not-found',decisionId:query.decisionId};
   const value=validateDecisionSnapshot(row);if(value.scopeId!==query.scopeId||value.decisionId!==query.decisionId)throw new DecisionApplicationError('DECISION_CORRUPT');
   return {...publicResult(value,true),case:value.command.case};
  }finally{store.close();}
 }
 async decide(input:unknown,credential?:unknown):Promise<DecisionRecordResult>{return this.mutate('record',input,credential);}
 async outcome(input:unknown,credential?:unknown):Promise<DecisionRecordResult>{return this.mutate('outcome',input,credential);}
 private async mutate(action:'record'|'outcome',input:unknown,credential?:unknown):Promise<DecisionRecordResult>{
  const command=action==='record'?decisionRecordCommandSchema.parse(input):decisionOutcomeCommandSchema.parse(input);
  const {principal,authorization}=await this.admission(action,command.scopeId,command.decisionId,credential);
  const fingerprint=sha256(encodeCommandProjection(`decision-${action}:1`,{command,principal}));
  const store=await this.deps.openStore('write');
  try {
   const replay=await store.receipt(command.scopeId,command.commandId);
   if(replay){if(replay.digest!==fingerprint||replay.decisionId!==command.decisionId)throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');return {...replay.result,replayed:true};}
   const row=await store.load(command.scopeId,command.decisionId);if(!row)throw new DecisionApplicationError('DECISION_RECORD_REQUIRED');
   const previous=validateDecisionSnapshot(row);if(previous.scopeId!==command.scopeId||previous.decisionId!==command.decisionId)throw new DecisionApplicationError('DECISION_CORRUPT');
   if(!previous.advice||!previous.adviceDigest||!previous.invocationId)throw new DecisionApplicationError('DECISION_RECORD_REQUIRED');
   let record=previous.record;
   const at=this.deps.now();
   if('selectedOption'in command){
    if(record||![...previous.command.case.options.map(option=>option.id),...DECISION_ABSTENTIONS].includes(command.selectedOption))throw new DecisionApplicationError('DECISION_COMMAND_CONFLICT');
    if(Buffer.byteLength(command.rationale)>previous.policy.limits.maxTextBytes)throw new DecisionApplicationError('DECISION_INVALID');
    record=decisionRecordSchema.parse({schemaVersion:1,id:previous.decisionId,scope:previous.scopeId,caseDigest:previous.caseDigest,
     adviceRef:{invocationId:previous.invocationId,adviceDigest:previous.adviceDigest},actor:{principalId:principal.id,selectedOption:command.selectedOption,rationale:command.rationale,decidedAt:new Date(at).toISOString()},outcome:null});
   }else{
    if(!record||record.outcome)throw new DecisionApplicationError('DECISION_RECORD_REQUIRED');
    if(decisionObservationIsFuture(command.outcome.observedAt,at)||Buffer.byteLength(command.outcome.observation)>previous.policy.limits.maxTextBytes)throw new DecisionApplicationError('DECISION_INVALID');
    record=decisionRecordSchema.parse({...record,outcome:{...command.outcome,principalId:principal.id}});
   }
   const next=validateDecisionSnapshot({...previous,record}),result={schemaVersion:1 as const,replayed:false,record};
   const receipt:DecisionMutationReceipt={scopeId:command.scopeId,commandId:command.commandId,decisionId:command.decisionId,digest:fingerprint,result};
   const saved=await store.mutate(previous,next,receipt,this.event(next,principal,authorization.revision,action,'observed'));
   return {schemaVersion:1,...saved};
  }finally{store.close();}
 }
}
