import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { proposeConfiguredMemory, verifyConfiguredMemory, retireConfiguredMemory, inspectConfiguredMemory, listConfiguredMemory, searchConfiguredMemory } from '#composition/core/memory/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { memoryCommand } from '#surfaces/core/cli-memory/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';

// S4 memory journal v1 through the real composition (policy file, integrity key, SQLite ledger) and its read-only surfaces: CLI `deckent memory`
// and the MCP read tools. Writes exist only in the application (no surface writes in v1); the AI (MCP actor) can never verify.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: configured policy/integrity flows require a verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
async function fixture(actions = ['inspect', 'propose', 'verify', 'retire'], mcpActions: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-memory-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, sqlite).close();
  const person = readLocalOsIdentity(), principal = { issuer: person.issuer, subject: person.subject };
  const grants = [{ id: 'memory', effect: 'allow', actions, scopes: ['scope'], principals: [principal], resource: { kind: 'memory', ids: 'all' } },
    ...(mcpActions.length ? [{ id: 'memory-mcp', effect: 'allow', actions: mcpActions, scopes: ['scope'], principals: [{ issuer: `${person.issuer}/mcp`, subject: person.subject }], resource: { kind: 'memory', ids: 'all' } }] : [])];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'memory-policy', restrictions: [], grants }), { mode: 0o600 });
  return { project, ledger, options: { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } } };
}
const lesson = { kind: 'lesson', title: 'Siparişsiz fatura onaya düşer', body: 'Eşleşmeyen irsaliye ERP kaydına yazılmaz, onay kuyruğuna gider.', tags: ['erp'],
  lesson: { source: 'run r1 task t1', cause: 'sipariş yok', correction: 'onaya yönlendir', evidence: 'attempt a1 kabul edildi' } };
const propose = (commandId: string) => ({ schemaVersion: 1, commandId, scopeId: 'scope', content: lesson, origin: { kind: 'run', ref: 'r1/t1' } });
const out = () => { let text = ''; return { sink: { write(chunk: string) { text += chunk; } }, text: () => text }; };

it('a proposal becomes verified by a person, and the CLI lists, searches and inspects it without writing the ledger', async () => {
  const f = await fixture();
  const proposed = await proposeConfiguredMemory(f.project, propose('m1'), f.options);
  expect(proposed.entry).toMatchObject({ state: 'candidate', provenance: { author: { ai: false }, origin: { kind: 'run', ref: 'r1/t1' } } });
  await verifyConfiguredMemory(f.project, { schemaVersion: 1, commandId: 'v1', scopeId: 'scope', entryId: 'm1', expectedRevision: 1, basis: { kind: 'human-review', note: 'r1 kanıtı okundu' } }, f.options);
  const before = await readFile(f.ledger), context = { root: f.project, env: f.options.env, listMemory: listConfiguredMemory, searchMemory: searchConfiguredMemory, inspectMemory: inspectConfiguredMemory };
  const listed = out(); await memoryCommand(['memory', '--scope', 'scope', '--lang', 'en'], { ...context, stdout: listed.sink });
  expect(listed.text()).toContain('Siparişsiz fatura onaya düşer'); expect(listed.text()).toContain('verified');
  const found = out(); await memoryCommand(['memory', 'search', 'SIPARISSIZ', 'irsaliye', '--scope', 'scope', '--lang', 'tr'], { ...context, stdout: found.sink });
  expect(found.text()).toContain('Siparişsiz fatura onaya düşer'); expect(found.text()).toContain('doğrulandı');
  const shown = out(); await memoryCommand(['memory', 'inspect', 'm1', '--scope', 'scope', '--lang', 'en'], { ...context, stdout: shown.sink });
  expect(shown.text()).toContain('sipariş yok'); expect(shown.text()).toContain('human review'); expect(shown.text()).toContain('r1 kanıtı okundu');
  const json = out(); await memoryCommand(['memory', 'search', 'onaya', '--scope', 'scope', '--json'], { ...context, stdout: json.sink });
  expect(JSON.parse(json.text())).toMatchObject({ status: 'ok', method: 'full-text', entries: [{ entryId: 'm1', state: 'verified' }] });
  expect(await readFile(f.ledger)).toEqual(before);
});

it('the MCP read tools answer inside the granted scope only, and the MCP actor is refused verification even with a policy grant', async () => {
  const f = await fixture(['inspect', 'propose', 'verify', 'retire'], ['inspect', 'propose', 'verify']);
  await proposeConfiguredMemory(f.project, propose('m1'), f.options);
  const asMcp = <T>(work: () => Promise<T>) => withMcpPrincipal(work);
  await expect(asMcp(() => verifyConfiguredMemory(f.project, { schemaVersion: 1, commandId: 'v1', scopeId: 'scope', entryId: 'm1', expectedRevision: 1,
    basis: { kind: 'human-review', note: 'ai self check' } }, f.options))).rejects.toMatchObject({ code: 'MEMORY_VERIFIER_NOT_HUMAN' });
  const mcp = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => ({}),
    listMemory: query => asMcp(() => listConfiguredMemory(f.project, query, f.options)), searchMemory: query => asMcp(() => searchConfiguredMemory(f.project, query, f.options)),
    inspectMemory: query => asMcp(() => inspectConfiguredMemory(f.project, query, f.options)) }, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport);
  const client = new Client({ name: 'memory-composition-test', version: '1' }); await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools.filter(tool => tool.name.endsWith('_memory'));
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint])).toEqual([['list_memory', true], ['search_memory', true], ['inspect_memory', true]]);
    const searched = await client.callTool({ name: 'search_memory', arguments: { schemaVersion: 1, scopeId: 'scope', query: 'irsaliye', limit: 5 } });
    expect(searched.structuredContent).toMatchObject({ status: 'ok', entries: [{ entryId: 'm1', state: 'candidate' }] });
    const other = await client.callTool({ name: 'list_memory', arguments: { schemaVersion: 1, scopeId: 'elsewhere', limit: 5 } });
    expect(other.isError).toBe(true);
  } finally { await client.close(); await mcp.close(); }
});

it('a scope without a memory grant is refused; a missing integrity key or ledger holds the read on the CLI (exit 1) instead of an empty list', async () => {
  const denied = await fixture(['propose']);
  await proposeConfiguredMemory(denied.project, propose('m1'), denied.options);
  await expect(listConfiguredMemory(denied.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, denied.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const fresh = await fixture(), shown = out();
  const code = await memoryCommand(['memory', '--scope', 'scope', '--lang', 'en'], { root: fresh.project, env: fresh.options.env, listMemory: listConfiguredMemory, stderr: shown.sink });
  expect(code).toBe(1); expect(shown.text()).toContain('Memory could not be read'); expect(shown.text()).toContain('MEMORY_UNAVAILABLE');
});

it('retiring keeps the entry and its revisions; retired entries appear only when asked for', async () => {
  const f = await fixture();
  await proposeConfiguredMemory(f.project, propose('m1'), f.options);
  await retireConfiguredMemory(f.project, { schemaVersion: 1, commandId: 'r1', scopeId: 'scope', entryId: 'm1', expectedRevision: 1, reason: 'yanlış', supersededBy: null }, f.options);
  expect(await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', limit: 5 }, f.options)).toMatchObject({ status: 'ok', entries: [] });
  expect(await listConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', states: ['retired'], limit: 5 }, f.options)).toMatchObject({ status: 'ok', entries: [{ entryId: 'm1' }] });
  const view = await inspectConfiguredMemory(f.project, { schemaVersion: 1, scopeId: 'scope', entryId: 'm1' }, f.options);
  expect(view.status === 'ok' && view.history.map(entry => entry.state)).toEqual(['candidate', 'retired']);
});
