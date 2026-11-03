// Synthetic fault-capable CLI using the A0 event/MCP shapes, not a retained provider observation.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { initLine, assistantLine, resultLine } from './stream.js';
import { codexAnswer } from './codex.js';
import { headlessIsolationSeal } from '#adapters/core/native-cli-headless/index.js';
import { testIsolation } from './connection.js';

/** Unsupported hosts still exercise the typed refusal; the Linux journey is explicitly unmeasured there. No skipped security case. */
export async function nativeAgentRealmAvailable(file: string, test: string): Promise<boolean> {
  const observed = await testIsolation();
  if (process.platform === 'linux' && observed.status === 'available') return true;
  const code = await headlessIsolationSeal(async () => observed).then(() => null, (error: unknown) => (error as { code?: unknown })?.code);
  if (code !== 'HEADLESS_ISOLATION_UNAVAILABLE') throw new Error('UNSUPPORTED_NATIVE_AGENT_REALM_NOT_REFUSED');
  console.info('verify-not-run: ' + JSON.stringify({ file, test, variant: 'native-agent-linux-realm', platform: process.platform,
    reason: process.platform === 'linux' ? 'isolation-unavailable' : 'platform-unsupported' }));
  return false;
}
export interface FakeAgentScenario {
  readonly turns?: readonly (Omit<FakeAgentScenario, 'turns'> & { when: string })[];
  readonly traceFile?: string;
  readonly calls?: readonly { name: string; arguments: Record<string, unknown> }[];
  readonly answer?: string;
  readonly preamble?: string;
  readonly pluginMismatch?: boolean;
  readonly nativeItem?: boolean;
  readonly echoToken?: boolean;
  readonly loginCanary?: string;
  readonly hang?: boolean;
}
export async function writeFakeAgentCli(dir: string, family: string, scenario: FakeAgentScenario = {}) {
  const entry = nativeCliAgent(family)!;
  const flags = [...new Set([...entry.agent.args, ...entry.headless.args].filter(arg => arg.startsWith('--'))),
    entry.command.modelFlag, entry.headless.systemPromptFlag, ...(entry.command.capabilities.reasoningEffort?.requiredFlags ?? [])];
  const setup = { entry, scenario, help: flags.join('\n'), init: initLine(), assistant: assistantLine(''), result: resultLine(''), codex: codexAnswer('') };
  const path = join(dir, 'fake-agent');
  await writeFile(path, `#!${process.execPath}
const fs = require('node:fs'), http = require('node:http');
const s = ${JSON.stringify(setup)}, e = s.entry; let x = s.scenario; const argv = process.argv.slice(2), claude = e.agent.transport.kind === 'claude-mcp';
if (argv[0] === '--version') { console.log((claude ? '' : 'codex-cli ') + '9.1.0'); process.exit(0); }
if (argv.includes('--help')) { console.log(s.help); process.exit(0); }
if (argv[0] === '--max-turns') { console.error(e.command.capabilities.maxTurns.hiddenHelpProbe.refusal); process.exit(1); }
if (argv.length === 2 && argv[1] === e.headless.systemPromptFlag) { console.error("option '" + e.headless.systemPromptFlag + " <file>' argument missing"); process.exit(1); }
if (argv.includes('status')) { if (claude) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',configDirectory:process.env[e.headless.env.configDir]})); else console.error('Logged in using ChatGPT'); process.exit(0); }
const chunks=[]; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => main().catch(() => { console.error('fixture-agent-error'); process.exitCode=1; }));
const line = value => new Promise(resolve => { if(s.scenario.traceFile) fs.appendFileSync(s.scenario.traceFile,JSON.stringify(value)+'\\n'); process.stdout.write(JSON.stringify(value)+'\\n', resolve); });
async function main() {
 const prompt=Buffer.concat(chunks).toString('utf8'); const selected=(x.turns??[]).filter(row=>prompt.includes(row.when)).sort((a,b)=>prompt.lastIndexOf(b.when)-prompt.lastIndexOf(a.when))[0]; if(selected) x={...x,...selected};
 const model = argv[argv.indexOf(e.command.modelFlag)+1], agent = claude ? argv.includes('--mcp-config') : argv.some(a => a.startsWith('mcp_servers.'));
 if (!agent) { if (claude) { await line({...s.init,cwd:process.cwd(),model}); await line({...s.assistant,message:{...s.assistant.message,model,content:[{type:'text',text:'text-only still available'}]}}); await line({...s.result,result:'text-only still available',modelUsage:{[model]:{inputTokens:2,outputTokens:9}}}); }
 else for (const value of s.codex) await line(value.item?.type === 'agent_message' ? {...value,item:{...value.item,text:'text-only still available'}} : value); return; }
 let token, server;
 if (claude) { const file=argv[argv.indexOf('--mcp-config')+1]; server=JSON.parse(fs.readFileSync(file,'utf8')).mcpServers[e.bridge.serverName]; token=server.headers[e.bridge.tokenHeaderName].slice('Bearer '.length);
  try { fs.appendFileSync(file,' '); throw new Error('mcp-config-writable'); } catch(error) { if (error.message==='mcp-config-writable') throw error; }
  if (process.env[e.bridge.tokenEnvName]) throw new Error('claude-token-in-env');
 } else { token=process.env[e.bridge.tokenEnvName]; if (!token || argv.some(a => a.includes(token))) throw new Error('token-channel'); }
 const url = 'http://'+e.bridge.sentinelHost+e.bridge.path, proxy=new URL(process.env.HTTP_PROXY); let sessionId, rpcId=0;
 async function rpc(method,params) { const id=++rpcId; return new Promise((resolve,reject) => { const req=http.request({host:proxy.hostname,port:proxy.port,path:url,method:'POST',headers:{host:e.bridge.sentinelHost,'content-type':'application/json',accept:'application/json, text/event-stream',[e.bridge.tokenHeaderName]:'Bearer '+token,...(sessionId?{'mcp-session-id':sessionId}:{})}},res=>{
  sessionId ??= res.headers['mcp-session-id']; let out='';res.on('data',c=>out+=c);res.on('error',reject);res.on('end',()=>{ try { const frames=out.split('\\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5))); const result=frames.find(v=>v.id===id) ?? JSON.parse(out); if (res.statusCode!==200 || result.error) reject(new Error('rpc-failed')); else resolve(result.result); } catch {reject(new Error('rpc-invalid'));} }); });req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id,method,params})); }); }
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-agent',version:'1'}});
 const listed = await rpc('tools/list',{});
 if (claude) { await line({...s.init,cwd:process.cwd(),model,tools:listed.tools.map(t=>e.bridge.toolPrefix+t.name),mcp_servers:[{name:e.bridge.serverName,status:'connected'}],...(x.pluginMismatch?{plugins:[{name:'unexpected',path:'fixture',source:'fixture'}]}:{})}); await new Promise(r=>setTimeout(r,100)); }
 else { await line(s.codex[0]); await line(s.codex[1]); if(x.nativeItem) { await line({type:'item.started',item:{id:'native-bad',type:'command_execution',command:'unchanged risky request'}}); await new Promise(r=>setTimeout(r,100)); } }
 if (x.hang) { if(claude) await line({...s.assistant,message:{...s.assistant.message,model,content:[{type:'text',text:'K16-WAITING '}]}}); else await line({type:'item.completed',item:{id:'waiting',type:'agent_message',text:'K16-WAITING '}}); await new Promise(()=>setInterval(()=>{},1000)); }
 if (x.preamble) { if(claude) await line({...s.assistant,message:{...s.assistant.message,model,content:[{type:'text',text:x.preamble}]}}); else await line({type:'item.completed',item:{id:'preamble',type:'agent_message',text:x.preamble}}); }
 let n=0;
 for (const call of x.calls ?? []) { const id='use-'+(++n), itemId='item-'+n;
  if (claude) await line({...s.assistant,message:{...s.assistant.message,model,content:[{type:'tool_use',id,name:e.bridge.toolPrefix+call.name,input:call.arguments}]}});
  else await line({type:'item.started',item:{id:itemId,type:'mcp_tool_call',server:e.bridge.serverName,tool:call.name,arguments:call.arguments,status:'in_progress',result:null,error:null}});
  const result=await rpc('tools/call',{name:call.name,arguments:call.arguments,_meta:claude?{'claudecode/toolUseId':id}:{callId:'call-'+n,itemId:'fc-'+n}});
  if (!claude) await line({type:'item.completed',item:{id:itemId,type:'mcp_tool_call',server:e.bridge.serverName,tool:call.name,arguments:call.arguments,status:'completed',result,error:null}});
  else await line({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:result.content}]},parent_tool_use_id:null});
 }
 const text=(x.answer ?? 'agent completed')+(x.echoToken?' '+token:'')+(x.loginCanary?' '+x.loginCanary:'');
 if (x.loginCanary) console.error(x.loginCanary); if(x.echoToken) console.error(token);
 if (claude) { const half=Math.floor(text.length/2); await line({...s.assistant,message:{...s.assistant.message,model,content:[{type:'text',text:text.slice(0,half)},{type:'text',text:text.slice(half)}]}}); await line({...s.result,result:text,modelUsage:{[model]:{inputTokens:2,outputTokens:9}}}); }
 else { await line({type:'item.completed',item:{id:'answer',type:'agent_message',text}}); await line(s.codex.at(-1)); }
}
`, { mode: 0o700 });
  return path;
}
