// Astra 2180 R2 reviewer test (proof/ASTRA-2179-2180-2026-09-29/k/tests/contracts/adapters/astra-2180-dynamic-ref.test.ts), copied unchanged
// except its unused imports (lint) and its one expectation (MCP-SCHEMA-VALIDATOR, proof astra-2180-adaptation.md): Deckent's own validator refuses a `$dynamicRef` schema
// when it compiles, so the call is refused before anything is sent (`invalid-output-schema`, no `call` in the server log) instead of being
// sent and answered with an output-schema error. On 0a69a70 (cf-worker) it failed open: answered.result with structuredContent `{v:123}`.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClientPool, mcpToolPinDigest, type McpClientSettings, type McpLiveTool } from '#adapters/index.js';

// MCP-CLIENT (owner 2026-09-28): Deckent as an MCP client of the owner's local stdio servers — both protocol eras (2025-11-25 `initialize`
// and 2026-07-28 `server/discover`), the pinned tool list, bounded redacted results, timeouts and a bounded restart. Every server here is a
// real SDK process (tests/fixtures/mcp-stdio-server.mjs); what reached it is read from its own log.
const FIXTURE = resolve('tests/fixtures/mcp-stdio-server.mjs');
const roots: string[] = [], pools: McpClientPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const echo: McpLiveTool & { behavior?: string } = { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true } };
const tool = (name: string, behavior: string, extra: Partial<McpLiveTool> = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, behavior, ...extra });
function fixture(mode: 'legacy' | 'dual' | 'modern', tools: unknown[] = [echo], extraArgs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-mcp-client-')); roots.push(root);
  const toolsFile = join(root, 'tools.json'), logFile = join(root, 'log.jsonl');
  writeFileSync(toolsFile, JSON.stringify(tools)); appendFileSync(logFile, '');
  const events = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; name?: string; cursor?: string | null; arguments?: unknown; aborted?: boolean; pid: number });
  return { root, toolsFile, events, setTools: (next: unknown[]) => writeFileSync(toolsFile, JSON.stringify(next)),
    server: (pins: readonly { name: string; digest: string; alwaysAsk?: boolean }[], id = 'fx') => ({ id, command: process.execPath,
      args: [FIXTURE, '--mode', mode, '--tools', toolsFile, '--log', logFile, ...extraArgs], env: {}, realm: 'host' as const,
      tools: pins.map(pin => ({ alwaysAsk: false, ...pin })) }) };
}
const settings = (servers: McpClientSettings['servers'], extra: Partial<McpClientSettings> = {}): McpClientSettings => ({ connectTimeoutMs: 10_000,
  callTimeoutMs: 10_000, resultMaxBytes: 4_096, maxRestarts: 1, inputMaxBytes: 1_048_576, servers, ...extra });
const context = (root: string) => ({ cwd: root, environment: { PATH: process.env['PATH'] }, sandboxes: [] });
const pool = () => { const created = new McpClientPool(new AbortController().signal); pools.push(created); return created; };
const pinOf = (live: McpLiveTool) => ({ name: live.name, digest: mcpToolPinDigest(live) });

it('Astra: nested dynamicRef output must not be accepted as schema-valid',async()=>{
 const outputSchema={$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://astra.invalid/tree',$dynamicAnchor:'node',type:'object',properties:{v:{type:'string'},children:{type:'array',items:{$dynamicRef:'#node'}}}};
 const live={...tool('tree','structured',{outputSchema}),structured:{v:'ok',children:[{v:123}]}};
 const f=fixture('dual',[live]),server=f.server([pinOf(live)]),p=pool();
 expect(await p.open(server,settings([server]),context(f.root))).toMatchObject({ok:true});
 const answer=await p.call(server.id,'tree',pinOf(live).digest,{}, {timeoutMs:5000,signal:new AbortController().signal});
 console.log('ASTRA_DYNAMIC_REF',JSON.stringify(answer));
 expect(answer).toMatchObject({outcome:'refused',reason:'invalid-output-schema'});
 expect(f.events().filter(event=>event.event==='call')).toHaveLength(0);
},30000);

// Lead addition (2026-09-29): recursion itself is supported — a draft 2020-12 schema that recurses through a plain `$ref` (not `$dynamicRef`)
// compiles, a conforming structured result passes and a nonconforming one is an answered output-schema error (sent once).
describe('MCP client: a recursive outputSchema through plain $ref', () => {
  const outputSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['v'],
    properties: { v: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } } };
  it.each([
    ['valid', { v: 'ok', children: [{ v: 'x' }] }, { outcome: 'answered', result: { structuredContent: { v: 'ok', children: [{ v: 'x' }] } } }],
    ['invalid', { v: 'ok', children: [{ v: 123 }] }, { outcome: 'answered', error: { code: -32602, kind: 'output-schema' } }],
  ] as const)('a %s nested result', async (_label, structured, outcome) => {
    const live = { ...tool('tree', 'structured', { outputSchema }), structured };
    const f = fixture('dual', [live]), server = f.server([pinOf(live)]), p = pool();
    expect(await p.open(server, settings([server]), context(f.root))).toMatchObject({ ok: true });
    expect(await p.call(server.id, 'tree', pinOf(live).digest, {}, { timeoutMs: 5000, signal: new AbortController().signal })).toMatchObject(outcome);
    expect(f.events().filter(event => event.event === 'call')).toHaveLength(1);
  }, 30000);
});
