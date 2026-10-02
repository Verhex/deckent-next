import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DecisionApplication, type DecisionStore, type DecisionSnapshot } from '#engine/core/decision/index.js';
import { resolveModelBindingDefinition, encodeModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationClaimReceipt, createModelInvocationResponseRecord, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
const now = Date.parse('2026-10-02T12:00:00Z');
const principal = { id:'actor',issuer:'os',subject:'1',assurance:'os-user' as const,scopeIds:['scope'] };
const policy = {schemaVersion:1 as const,limits:{maxCaseBytes:16384,maxEvidence:8,maxOptions:8,maxChecks:8,maxTextBytes:1024},thresholds:{choice:0.8,sufficiency:0.7}};
const caseInput = {schemaVersion:1,objective:'Choose a bounded path',scope:'scope',revision:'r1',constraints:['No automatic action'],unknowns:[],evidence:[{id:'e1',source:'proof',observedAt:'2026-10-02T11:00:00Z',observation:'Evidence inspected'}],options:[{id:'a',action:'Prepare',tradeoffs:['Gain safety; loss time'],evidenceIds:['e1']}],checks:[{id:'c1',instructions:'Bounded?',evidenceIds:['e1']}],process:{stage:'implementation',currentState:'ready',acceptedDecisions:['Port'],nextStep:'Review',reopenReason:null}};
const reference = {providerId:'provider',providerVersion:1,modelId:'model',modelVersion:1};
const definition = resolveModelBindingDefinition({schemaVersion:1,revision:'catalog',providers:[{id:'provider',version:1,models:[{id:'model',version:1,nativeId:'native-model',protocols:[{family:'decision',version:'1',capabilities:[]}]}]}]},reference)!;
const binding={encodingVersion:1 as const,algorithm:'sha256' as const,digest:createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex')};
const command={schemaVersion:1,commandId:'ask1',scopeId:'scope',case:caseInput,invocation:{reference,catalogRevision:'catalog',expectedBinding:binding}};
const advice={schemaVersion:1,choice:'a',probabilities:{a:0.9,none_of_the_above:0.05,insufficient_information:0.05},confidence:0.85,sufficiency:0.75,checks:{c1:0.9},model:'configured-model',usage:{inputTokens:100,outputTokens:20},latencyMs:10};
function harness() {
 const rows=new Map<string,DecisionSnapshot>(); const events:unknown[]=[];
 let failSettle=false;
 const store:DecisionStore={load:async(s,id)=>rows.get(`${s}/${id}`)??null,claim:async(snapshot,event)=>{const key=`${snapshot.scopeId}/${snapshot.decisionId}`;const prior=rows.get(key);if(prior)return {replayed:true,snapshot:prior};rows.set(key,snapshot);events.push(event);return {replayed:false,snapshot};},settle:async(previous,next,event)=>{if(failSettle)throw Error('lost record');rows.set(`${previous.scopeId}/${previous.decisionId}`,next);events.push(event);return next;},mutate:async(previous,next,_receipt,event)=>{rows.set(`${previous.scopeId}/${previous.decisionId}`,next);events.push(event);return {replayed:false,record:next.record!};},receipt:async()=>null,close(){}};
 const invoke=vi.fn(async(nativeCommand)=>{
 const profile={schemaVersion:1 as const,id:'profile',version:1,scopeId:'scope',reference,bindingDigest:binding.digest,protocol:{family:'decision',version:'1'},adapter:{id:'adapter',version:1,definition:{}},allocation:{id:'allocation',maxCalls:3,maxInFlight:1},limits:{requestMaxBytes:16384,responseMaxBytes:16384,timeoutMs:1000}};
 const claim=createModelInvocationClaimReceipt({command:nativeCommand,requestDigest:modelInvocationRequestDigest(nativeCommand),actor:{id:principal.id,issuer:principal.issuer,subject:principal.subject,assurance:principal.assurance},authorization:{revision:'policy',ruleId:'allow'},definition,activation:{schemaVersion:1,scopeId:'scope',reference,revision:1,state:'active',catalogRevision:'catalog',definition,binding},profile,profileDigest:modelInvocationProfileDigest(profile),invocationId:'inv1',claimedAtMs:now});
 const response={schemaVersion:1 as const,native:{decisionAdvice:advice},usage:{input_tokens:100,output_tokens:20}};
 const record=createModelInvocationResponseRecord(claim,response,now+10);return {replayed:false,receipt:record.receipt,response,contentStatus:'retained' as const,purge:null};});
 const authorize=vi.fn(async()=>({revision:'policy',ruleId:'allow'}));
 const app=new DecisionApplication({verifier:{verify:async()=>principal},authorize,policy:async()=>policy,openStore:async()=>store,invoke,now:()=>now,eventId:()=>`event-${events.length}`});
 return {app,invoke,authorize,events,rows,fail:()=>{failSettle=true;}};
}
describe('decision application owns advisory records only',()=>{
 it('asks through one existing invocation and replays without another paid call',async()=>{const h=harness();const first=await h.app.ask(command);expect(first.status).toBe('advised');expect(first.advice?.probabilities.insufficient_information).toBe(0.05);expect((await h.app.ask(command)).replayed).toBe(true);expect(h.invoke).toHaveBeenCalledTimes(1);expect(h.events).toHaveLength(2);});
 it('lost result recording leaves unknown and never automatically pays twice',async()=>{const h=harness();h.fail();expect((await h.app.ask(command)).status).toBe('unknown');expect((await h.app.ask(command)).status).toBe('unknown');expect(h.invoke).toHaveBeenCalledTimes(1);});
 it('actor selection records data and never invokes or admits the selected operation',async()=>{const h=harness();await h.app.ask(command);const result=await h.app.decide({schemaVersion:1,commandId:'record1',scopeId:'scope',decisionId:'ask1',selectedOption:'a',rationale:'Bounded'});expect(result.record.actor.selectedOption).toBe('a');expect(result.record).not.toHaveProperty('authority');expect(h.invoke).toHaveBeenCalledTimes(1);expect(h.authorize).toHaveBeenLastCalledWith('record','scope','ask1',principal);});
 it('refuses mismatching scopes before invocation',async()=>{const h=harness();await expect(h.app.ask({...command,case:{...caseInput,scope:'other'}})).rejects.toThrow();expect(h.invoke).not.toHaveBeenCalled();});
 it('cancelled before call is typed without fake advice or transport',async()=>{const h=harness();const controller=new AbortController();controller.abort();const result=await h.app.ask(command,undefined,controller.signal);expect(result.status).toBe('cancelled');expect(result.advice).toBeNull();expect(h.invoke).not.toHaveBeenCalled();});
 it('does not expose a cross-scope record to inspection',async()=>{const h=harness();await h.app.ask(command);await expect(h.app.inspect({schemaVersion:1,scopeId:'other',decisionId:'ask1'})).rejects.toThrow();});
 it('same command cannot change case or actor',async()=>{const h=harness();await h.app.ask(command);await expect(h.app.ask({...command,case:{...caseInput,objective:'Changed'}})).rejects.toThrow('DECISION_COMMAND_CONFLICT');expect(h.invoke).toHaveBeenCalledTimes(1);});
});
it('outcome observedAt never accepts a future fraction beyond the trusted clock',async()=>{
 const h=harness();await h.app.ask(command);await h.app.decide({schemaVersion:1,commandId:'record-future',scopeId:'scope',decisionId:'ask1',selectedOption:'a',rationale:'Bounded'});
 await expect(h.app.outcome({schemaVersion:1,commandId:'future-outcome',scopeId:'scope',decisionId:'ask1',outcome:{observedAt:'2026-10-02T12:00:00.000001Z',observation:'Not observed yet'}})).rejects.toThrow('DECISION_INVALID');
});
