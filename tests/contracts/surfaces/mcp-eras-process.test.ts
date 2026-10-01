import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, type VersionNegotiationMode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';

// MCP-CLIENT "in" (owner 2026-09-28): the compiled `deckent-mcp` stdio entry serves both protocol eras to real SDK clients — a 2025-11-25
// client (`initialize`), a negotiating client (`server/discover` probe → 2026-07-28) and a client pinned to 2026-07-28 — with the same tool
// list and a bounded tool call.
const entry = resolve('dist/composition/core/mcp/internal/entry.js');
const roots: string[] = [], clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-eras-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 }); await mkdir(join(root, '.deckent'), { mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ mcp: { responseMaxBytes: 65_536, inputMaxBytes: 65_536, maxConcurrentCalls: 2 } }), { mode: 0o600 });
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}

it.each([['legacy', 'legacy', '2025-11-25'], ['auto', 'modern', '2026-07-28'], [{ pin: '2026-07-28' }, 'modern', '2026-07-28']] as const)(
  'a %j client reaches the %s era (%s): the same tool list and a policy_vocabulary call', async (mode, era, version) => {
    const { root, env } = await project();
    const client = new Client({ name: 'deckent-eras-proof', version: '1' }, { versionNegotiation: { mode: mode as VersionNegotiationMode, probe: { timeoutMs: 5_000 } } });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--project', root], cwd: root, env, stderr: 'ignore' }));
    expect(client.getProtocolEra()).toBe(era);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    expect(client.getServerVersion()).toMatchObject({ name: 'deckent' });
    const listed = await client.listTools(undefined, { cacheMode: 'bypass' });
    const names = listed.tools.map(tool => tool.name);
    expect(names.slice(0, 3)).toEqual(['inspect_run', 'inspect_inventory', 'policy_vocabulary']);
    const vocabulary = await client.callTool({ name: 'policy_vocabulary', arguments: {} });
    expect(vocabulary.isError).not.toBe(true);
    const [first] = vocabulary.content as { type: string; text: string }[];
    expect(first?.type).toBe('text');
    expect(JSON.parse(first!.text)).toEqual(vocabulary.structuredContent);
  }, 30_000);

it('the modern tools/list answer carries the cache fields the 2026-07-28 revision requires', async () => {
  const { root, env } = await project();
  const client = new Client({ name: 'deckent-eras-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--project', root], cwd: root, env, stderr: 'ignore' }));
  const listed = await client.listTools(undefined, { cacheMode: 'bypass' }) as { ttlMs?: unknown; cacheScope?: unknown };
  expect(typeof listed.ttlMs).toBe('number');
  expect(['private', 'public']).toContain(listed.cacheScope);
}, 30_000);
