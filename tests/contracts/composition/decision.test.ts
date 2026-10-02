import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { prepareConfiguredDecision, askConfiguredDecision, recordConfiguredDecision, outcomeConfiguredDecision, inspectConfiguredDecision } from '#composition/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity, decisionHttpAdapter } from '#adapters/index.js';
import { modelInvocationTargetId } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { decisionCommand } from '#surfaces/core/cli-decision/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';
const roots:string[]=[],servers:Server[]=[];
afterEach(async()=>{clearConfigCache();await Promise.all(servers.splice(0).map(async server=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const sqlite={busyTimeoutMs:1000,journalMode:'delete' as const,durability:'full' as const};
const reference={providerId:'provider',providerVersion:1,modelId:'model',modelVersion:1};
const catalog={schemaVersion:1,revision:'catalog',providers:[{id:'provider',version:1,models:[{id:'model',version:1,nativeId:'configured-model',protocols:[{...decisionHttpAdapter.protocol,capabilities:[]}]}]}]};
const policy={schemaVersion:1,limits:{maxCaseBytes:16384,maxEvidence:8,maxOptions:8,maxChecks:8,maxTextBytes:1024},thresholds:{choice:.8,sufficiency:.7}};
const inputCase={schemaVersion:1,objective:'Choose safe action',scope:'scope',revision:'r1',constraints:['No authority from advice'],unknowns:['Outcome not observed'],evidence:[{id:'e',source:'fixture',observedAt:'2026-10-01T00:00:00Z',observation:'Source inspected'}],options:[{id:'a',action:'Record advice',tradeoffs:['Gain provenance; loss overhead'],evidenceIds:['e']}],checks:[{id:'c',instructions:'Evidence adequate?',evidenceIds:['e']}],process:{stage:'implementation',currentState:'prepared',acceptedDecisions:['Port only'],nextStep:'Review',reopenReason:null}};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'deckent-decision-composition-'));roots.push(root);const project=join(root,'project'),data=join(root,'data'),home=join(root,'home');
 await Promise.all([mkdir(join(project,'.deckent'),{recursive:true,mode:0o700}),mkdir(data,{mode:0o700}),mkdir(home,{mode:0o700})]);
 let requests=0;const server=createServer((request,res)=>{requests++;request.resume();request.on('end',()=>res.end(JSON.stringify({model:'resolved-model',answers:{selection:{type:'choice',choice:'a',probabilities:{a:.9,none_of_the_above:.05,insufficient_information:.05},confidence:.85},sufficiency:{type:'noul',noul:.9},check_0:{type:'noul',noul:.8}},usage:{input_tokens:30,output_tokens:15}})));});servers.push(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('fixture');
 const definition={encodingVersion:1 as const,provider:{id:'provider',version:1},model:catalog.providers[0]!.models[0]!};
 const binding={encodingVersion:1 as const,algorithm:'sha256' as const,digest:createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex')};
 const profile={schemaVersion:1,id:'decision-profile',version:1,scopeId:'scope',reference,bindingDigest:binding.digest,protocol:decisionHttpAdapter.protocol,adapter:{id:decisionHttpAdapter.id,version:decisionHttpAdapter.version,definition:{endpoint:`http://127.0.0.1:${address.port}/`,authentication:{type:'none'},tariff:{kind:'operator-static',version:1,currency:'USD',inputMinorUnitsPerMillionTokens:0,outputMinorUnitsPerMillionTokens:0}}},allocation:{id:'allocation',maxCalls:4,maxInFlight:1},limits:{requestMaxBytes:16384,responseMaxBytes:16384,timeoutMs:5000}};
 await writeFile(join(project,'.deckent/config.json'),JSON.stringify({layout:{root:data},storage:{driver:'sqlite',sqlite},decision:policy,provider_catalog:catalog,provider_invocation_profiles:{schemaVersion:1,profiles:[profile]},provider_spending:fixtureBudget('scope')}),{mode:0o600});
 const ledger=await prepareProductFile(resolveProductLayout({projectRoot:project,root:data}),'ledger',['-wal','-shm','-journal']);
 const principal={...readLocalOsIdentity(),scopeIds:['scope']};const actor={id:principal.id,issuer:principal.issuer,subject:principal.subject,assurance:principal.assurance};const store=await openSqliteModelActivationStore(ledger,sqlite);
 await store.admit({command:{schemaVersion:1,action:'activate',commandId:'activate',scopeId:'scope',reference,expectedRevision:0,catalogRevision:'catalog',expectedBinding:binding},actor,authorization:{revision:'seed',ruleId:'seed'},admittedAtMs:1,definition});store.close();
 const setPolicy=async(invocationAllowed=true,decisionActions=['prepare','ask','record','outcome','inspect'])=>{await writeFile(join(data,'policy.json'),JSON.stringify({schemaVersion:1,revision:invocationAllowed?'allow':'deny-invoke',restrictions:[],grants:[{id:'decisions',effect:'allow',actions:decisionActions,scopes:['scope'],principals:[{issuer:principal.issuer,subject:principal.subject}],resource:{kind:'decision',ids:'all'}},...(invocationAllowed?[{id:'invoke',effect:'allow',actions:['invoke','inspect'],scopes:['scope'],principals:[{issuer:principal.issuer,subject:principal.subject}],resource:{kind:'model-invocation',ids:[modelInvocationTargetId(reference)]}}]:[])]}),{mode:0o600});};
 await setPolicy();const env={HOME:home,USERPROFILE:home,PATH:process.env.PATH??'/usr/bin:/bin'};const command={schemaVersion:1,commandId:'ask',scopeId:'scope',case:inputCase,invocation:{reference,catalogRevision:'catalog',expectedBinding:binding}};
 return {project,ledger,env,command,setPolicy,requests:()=>requests};
}
it('configured SDK → invocation → HTTP → sealed ledger → CLI and MCP inspection preserve advice and actor data',async()=>{
 const f=await fixture(),options={env:f.env};const prepared=await prepareConfiguredDecision(f.project,{schemaVersion:1,case:inputCase},options);expect(prepared.caseDigest).toMatch(/^[a-f0-9]{64}$/);
 const advice=await askConfiguredDecision(f.project,f.command,options);expect(advice.status).toBe('advised');expect(advice.advice).toMatchObject({choice:'a',checks:{c:.8},probabilities:{none_of_the_above:.05,insufficient_information:.05}});
 expect((await askConfiguredDecision(f.project,f.command,options)).replayed).toBe(true);expect(f.requests()).toBe(1);
 const record={schemaVersion:1,commandId:'record',scopeId:'scope',decisionId:'ask',selectedOption:'a',rationale:'Bounded choice'};
 expect((await recordConfiguredDecision(f.project,record,options)).record.actor.selectedOption).toBe('a');expect((await recordConfiguredDecision(f.project,record,options)).replayed).toBe(true);
 const outcome={schemaVersion:1,commandId:'outcome',scopeId:'scope',decisionId:'ask',outcome:{observedAt:'2026-10-02T00:00:00Z',observation:'Targeted proof verified'}};
 expect((await outcomeConfiguredDecision(f.project,outcome,options)).record.outcome?.observation).toBe('Targeted proof verified');expect((await outcomeConfiguredDecision(f.project,outcome,options)).replayed).toBe(true);
 const query={schemaVersion:1 as const,scopeId:'scope',decisionId:'ask'},before=await readFile(f.ledger);let stdout='';
 await decisionCommand(['decide','inspect','--input','-','--lang','tr'],{root:f.project,env:f.env,stdin:Readable.from([JSON.stringify(query)]),stdout:{write(text){stdout+=text;}},inspectDecision:inspectConfiguredDecision});expect(stdout).toContain('insufficient_information');expect(stdout).toContain('none_of_the_above');
 const mcp=createMcpServer({inspectRun:async()=>({}),inspectInventory:async()=>({}),inspectDecision:input=>inspectConfiguredDecision(f.project,input,options)},{maxConcurrentCalls:2,responseMaxBytes:65536},'en');
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await mcp.connect(serverTransport);
 const client=new Client({name:'decision-composition-test',version:'1'});await client.connect(clientTransport);
 const response=await client.callTool({name:'inspect_decision',arguments:query});await client.close();await mcp.close();expect(JSON.stringify(response)).toContain('Targeted proof verified');expect(await readFile(f.ledger)).toEqual(before);expect(f.requests()).toBe(1);
 const db=new DatabaseSync(f.ledger,{readOnly:true});try{expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='decision-port'").get()?.n).toBe(4);}finally{db.close();}
 await f.setPolicy(false);const refused=await askConfiguredDecision(f.project,{...f.command,commandId:'next'},options);expect(refused.status).toBe('unavailable');expect(refused.advice).toBeNull();expect(f.requests()).toBe(1);
});
it('lost decision settlement rolls audit back, replays unknown and never sends twice',async()=>{
 const f=await fixture();const db=new DatabaseSync(f.ledger);db.exec("CREATE TRIGGER lose_decision BEFORE UPDATE ON decision_cases BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
 const first=await askConfiguredDecision(f.project,f.command,{env:f.env});expect(first.status).toBe('unknown');expect(first.advice).toBeNull();
 const replay=await askConfiguredDecision(f.project,f.command,{env:f.env});expect(replay.status).toBe('unknown');expect(replay.replayed).toBe(true);expect(f.requests()).toBe(1);
 const read=new DatabaseSync(f.ledger,{readOnly:true});try{expect(read.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='decision-port'").get()?.n).toBe(1);}finally{read.close();}
});
it('requires current record policy and refuses tampered stored advice',async()=>{
 const f=await fixture();await askConfiguredDecision(f.project,f.command,{env:f.env});await f.setPolicy(true,['prepare','ask','inspect']);
 await expect(recordConfiguredDecision(f.project,{schemaVersion:1,commandId:'record',scopeId:'scope',decisionId:'ask',selectedOption:'a',rationale:'No grant'},{env:f.env})).rejects.toMatchObject({code:'POLICY_DENIED'});
 const db=new DatabaseSync(f.ledger);const raw=JSON.parse(String(db.prepare('SELECT snapshot FROM decision_cases').get()?.snapshot));raw.value.advice.choice='none_of_the_above';db.prepare('UPDATE decision_cases SET snapshot=?').run(JSON.stringify(raw));db.close();
 await expect(inspectConfiguredDecision(f.project,{schemaVersion:1,scopeId:'scope',decisionId:'ask'},{env:f.env})).rejects.toMatchObject({code:'DECISION_CORRUPT'});
});
