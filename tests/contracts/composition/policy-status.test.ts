import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { inspectPolicyAdministration } from '../../../src/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { clearConfigCache } from '#platform/index.js';

it.skipIf(process.platform !== 'linux')('SDK, CLI, MCP and doctor share scoped read-only administration readiness; MCP observes but never counts as admin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-policy-status-')), home = join(root, 'home'), data = join(root, 'data');
  await mkdir(home); await mkdir(data, { mode: 0o700 }); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal: { scopeId: 's' } }));
  const owner = { issuer: hostname(), subject: String(userInfo().uid) }, mcp = { ...owner, issuer: `${hostname()}/mcp` };
  const document = JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'admin', effect: 'allow', actions: ['execute'], scopes: ['s'], principals: [owner, mcp], resource: { kind: 'operation', ids: ['policy.administer'] } },
    { id: 'approvals', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['s'], principals: [owner, mcp], resource: { kind: 'approval', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [owner, mcp], resource: { kind: 'scope', ids: ['s'] } },
  ] });
  await writeFile(join(data, 'policy.json'), document, { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home } }, query = { schemaVersion: 1 as const, scopeId: 's' };
  const inspect = (project: string, input: typeof query) => inspectPolicyAdministration(project, input, options);
  const server = createMcpServer(mcpApplications({ inspectRun: async () => null, inspectInventory: async () => null,
    inspectPolicyAdministration: (input: typeof query) => inspect(root, input) }), { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'status-proof', version: '1' });
  try {
    const before = await readdir(data), sdk = await inspect(root, query);
    expect(sdk).toMatchObject({ usableAdminCount: 1, admins: [owner], revision: 'p', identityReadiness: 'not-verified' });
    for (const lang of ['en', 'tr']) {
      let text = '';
      expect(await main(['policy', 'status', '--scope', 's', '--lang', lang], { root, env: options.env, inspectPolicyAdministration: inspect,
        stdout: { write: value => { text += value; } } })).toBe(0);
      expect(text).toContain(owner.issuer); expect(text).toContain(lang === 'tr' ? 'kullanılabilir admin' : 'usable administrators');
    }
    let json = '';
    expect(await main(['policy', 'status', '--scope', 's', '--json'], { root, env: options.env, inspectPolicyAdministration: inspect,
      stdout: { write: value => { json += value; } } })).toBe(0);
    expect(JSON.parse(json)).toEqual(sdk);
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect((await client.listTools()).tools.find(tool => tool.name === 'inspect_policy_administration')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const result = await client.callTool({ name: 'inspect_policy_administration', arguments: query });
    expect(result.structuredContent).toEqual(sdk);
    await expect(inspect(root, { ...query, scopeId: 'foreign' })).rejects.toBeDefined();
    json = '';
    await runKernelCommand(['doctor', '--json'], { root, env: options.env, inspectPolicyAdministration: inspect, stdout: { write: value => { json += value; } } });
    expect(JSON.parse(json)).toMatchObject({ policyAdministration: sdk });
    expect(await readdir(data)).toEqual(before); expect(await readFile(join(data, 'policy.json'), 'utf8')).toBe(document);
  } finally { await client.close(); await server.close(); clearConfigCache(); await rm(root, { recursive: true, force: true }); }
});
