import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runConfiguredMcpCommand } from '#composition/core/agent-turn/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, {recursive:true,force:true}))); });
it('revoking MCP trust while its call awaits approval prevents dispatch from the stale card', async () => {
 const root=mkdtempSync(join(tmpdir(),'astra-mcp-revoke-')); roots.push(root);
 const toolsFile=join(root,'tools.json'), logFile=join(root,'log.jsonl');
 writeFileSync(toolsFile,JSON.stringify([{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}])); appendFileSync(logFile,'');
 const f=await runtime({extraGrants:[
 {id:'mcp-tool',effect:'allow',actions:['invoke'],scopes:['scope'],principals:me,resource:{kind:'agent-tool',ids:['mcp__fx__echo']}},
 {id:'mcp-op',effect:'allow',actions:['execute'],scopes:['scope'],principals:me,resource:{kind:'operation',ids:['mcp.tool.call']}},
 {id:'decide',effect:'allow',actions:['inspect','decide'],scopes:['scope'],principals:me,resource:{kind:'approval',ids:'all'}}]}); await f.start();
 mkdirSync(join(f.project,'.deckent'),{recursive:true});
 writeFileSync(join(f.project,'.deckent','mcp.json'),JSON.stringify({mcpServers:{fx:{command:process.execPath,args:[resolve('tests/fixtures/mcp-stdio-server.mjs'),'--mode','dual','--tools',toolsFile,'--log',logFile],realm:'host'}}}));
 await runConfiguredMcpCommand(f.project,{verb:'approve',name:'fx',alwaysAsk:[]},{env:f.env},async()=>true);
 f.state.script=[{toolCall:{name:'mcp__fx__echo',arguments:JSON.stringify({text:'after revoke'})}},{content:'Done.'}];
 const client=f.client(),pending:Promise<unknown>[]=[]; let revokedStatus:unknown;
 await client.chatTurn({schemaVersion:1,scopeId:'scope',turnId:'revoke',sessionId:'session-m',messages:[{role:'user',content:'use'}]},event=>{
  if(event.kind==='approval.requested') pending.push((async()=>{
   await runConfiguredMcpCommand(f.project,{verb:'reset',name:'fx'},{env:f.env},async()=>null);
   revokedStatus=await runConfiguredMcpCommand(f.project,{verb:'get',name:'fx'},{env:f.env},async()=>null);
   await client.decideApproval({schemaVersion:1,scopeId:'scope',approvalId:event.approvalId,commandId:`allow-${event.approvalId}`,expectedRevision:event.revision,decision:'allow',reason:'old card'});
  })());
 });
 await Promise.all(pending);
 const calls=readFileSync(logFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.event==='call');
 console.log('ASTRA_REVOKE_EVIDENCE',JSON.stringify({revokedStatus,calls,effects:f.rows('SELECT target_kind,state FROM effect_intents')}));
 expect(revokedStatus).toMatchObject({server:{status:'pending-approval',trust:null,pinnedTools:0}});
 expect(calls).toEqual([]);
},60000);
