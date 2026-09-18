import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createReadOnlyMcpServer } from '#surfaces/index.js';
import { getPolicyVocabulary, inspectRun } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { admitRunAttempts } from '../support/admission.js';
it('advertises real schemas and bounds concurrent calls, response size and error disclosure', async () => {
  let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const server = createReadOnlyMcpServer({ async inspectRun() { entered(); await gate; return { oversized: 'x'.repeat(1000) }; }, async inspectInventory() { throw new Error('/private secret'); } }, { maxConcurrentCalls: 1, responseMaxBytes: 100 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); const client = new Client({ name: 'test', version: '1' }); await client.connect(ct);
  try {
    const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toEqual(['inspect_run', 'inspect_inventory', 'policy_vocabulary']);
    expect(tools.tools[0]!.inputSchema.required).toContain('scopeId');
    const first = client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r' } }); await waiting;
    expect(JSON.stringify(await client.callTool({ name: 'policy_vocabulary', arguments: {} }))).toContain('MCP_BUSY'); release();
    expect(JSON.stringify(await first)).toContain('MCP_RESPONSE_LIMIT');
    const failed = JSON.stringify(await client.callTool({ name: 'inspect_inventory', arguments: { schemaVersion: 1, scopeId: 's' } }));
    expect(failed).toContain('MCP_TOOL_FAILED'); expect(failed).not.toContain('secret');
    expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: { schemaVersion: 1, scopeId: 's', runId: 'r', principal: 'admin' } }))).toContain('MCP_INPUT_INVALID');
  } finally { release(); await client.close(); await server.close(); }
});
it.skipIf(process.platform === 'win32')('serves the same configured Run as SDK over a real stdio MCP connection and observes policy revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-')); const project = join(root, 'project'); const data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const env = { HOME: join(root, 'home') }; const { store } = await openConfiguredAttemptStore(project, { env });
  try { await admitRunAttempts(store, [{ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]); } finally { store.close(); }
  const writePolicy = async (allow: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: allow ? [
    { id: 'read', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'run', ids: ['r'] } },
  ] : [] }), { mode: 0o600 });
  await writePolicy(true);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/composition/core/mcp/internal/entry.js')], cwd: project, env, stderr: 'pipe' });
  const client = new Client({ name: 'deckent-proof', version: '1' });
  try {
    await client.connect(transport); const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
    const result = await client.callTool({ name: 'inspect_run', arguments: query }); expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(await inspectRun(project, query, { env }));
    expect((await client.callTool({ name: 'policy_vocabulary', arguments: {} })).structuredContent).toEqual(getPolicyVocabulary());
    await writePolicy(false); expect(JSON.stringify(await client.callTool({ name: 'inspect_run', arguments: query }))).toContain('POLICY_DENIED');
    expect((await client.listTools()).tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);
