import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectMonitor, type MonitorQuery } from '../../../src/index.js';
import { main } from '#surfaces/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { loadMonitorSurface, monitorSlash } from '#surfaces/core/monitor/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache } from '#platform/index.js';

// CARD admission -> assert access boundary; all projects/ledgers are temporary fixtures.
// A poisoned ledger alone is insufficient: monitor converts read errors into diagnostics.
const trace = vi.hoisted(() => ({ fs: [] as string[], databases: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => { trace.fs.push(String(args[0])); return actual.open(...args); },
    readFile: (...args: Parameters<typeof actual.readFile>) => { trace.fs.push(String(args[0])); return actual.readFile(...args); },
    lstat: (...args: Parameters<typeof actual.lstat>) => { trace.fs.push(String(args[0])); return actual.lstat(...args); },
    realpath: (...args: Parameters<typeof actual.realpath>) => { trace.fs.push(String(args[0])); return actual.realpath(...args); },
  };
});
const roots: string[] = [];
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
beforeEach(() => {
  const Original = sqlite.DatabaseSync;
  // The ledger adapter uses createRequire: instrument the native constructor too, not just JS fs.
  vi.spyOn(sqlite, 'DatabaseSync').mockImplementation(new Proxy(Original, {
    construct(target, args, newTarget) { trace.databases.push(String(args[0])); return Reflect.construct(target, args, newTarget); },
  }));
});
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-selection-')); roots.push(root);
  const options = { env: { HOME: join(root, 'home'), TERM: 'dumb' } };
  async function project(name: string) {
    const dir = join(root, name), data = join(root, name + '-data');
    await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
    const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
    return { dir, data, ledger: opened.path };
  }
  const current = await project('current'), other = await project('other');
  await writeFile(join(current.dir, '.deckent/config.json'), JSON.stringify({ layout: { root: current.data }, inspection: { workers: { sources: [
    { id: 'other', kind: 'next-project', path: other.dir, scopeId: 's' },
    { id: 'alias', kind: 'next-project', path: current.dir, scopeId: 's' },
    { id: 'legacy', kind: 'legacy-tasks', path: join(root, 'legacy'), scopeId: 's' },
  ] } } }));
  // Real malformed bytes: collection would attempt native SQLite and report ledger-unavailable.
  await writeFile(other.ledger, 'POISON: this must never be opened when current is selected');
  clearConfigCache(); trace.fs.length = 0; trace.databases.length = 0;
  return { current, other, options };
}
function untouched(other: { dir: string; data: string; ledger: string }) {
  expect(trace.fs.filter(path => path === other.dir || path.startsWith(other.dir + '/') || path === other.data || path.startsWith(other.data + '/'))).toEqual([]);
  expect(trace.databases).not.toContain(other.ledger);
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, flags: readonly string[]) {
  let output = '', error = '';
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } });
  const stderr = new Writable({ write(chunk: Buffer, _encoding, done) { error += chunk.toString(); done(); } });
  const code = await main(['monitor', ...flags], { root: f.current.dir, env: f.options.env, stdout, stderr, inspectMonitor });
  expect({ code, error }).toEqual({ code: 0, error: '' }); return output;
}
it('SDK current selection never opens the configured second project or poisoned ledger', async () => {
  const f = await fixture(), snapshot = await inspectMonitor(f.current.dir, f.options, { schemaVersion: 1, install: 'current' });
  untouched(f.other);
  expect(snapshot.sourcesRead).toEqual(['current']); expect(snapshot.installs.map(install => install.id)).toEqual(['current']);
  expect(snapshot.installs[0]!.status).toBe('available'); expect(trace.databases).toContain(f.current.ledger);
});
it('invalid SDK queries fail before any configuration or source access', async () => {
  const f = await fixture();
  await expect(inspectMonitor(f.current.dir, f.options, { schemaVersion: 1, install: 'other', extra: true } as never)).rejects.toThrow();
  expect(trace.fs).toEqual([]); expect(trace.databases).toEqual([]);
});
it.each(['--json', '--once', 'pipe'] as const)('CLI %s forwards selection before collection', async mode => {
  const f = await fixture(), output = await cli(f, [...(mode === 'pipe' ? [] : [mode]), '--install', 'current']);
  if (mode === '--json') expect(JSON.parse(output)).toMatchObject({ sourcesRead: ['current'], installs: [{ id: 'current', status: 'available' }] });
  else expect(output).toContain('current');
  expect(trace.databases).toContain(f.current.ledger); untouched(f.other);
});
it('interactive CLI collection keeps the selection and stops on abort', async () => {
  const f = await fixture(), controller = new AbortController(); let output = '';
  const stdout = Object.assign(new Writable({ write(chunk: Buffer, _encoding, done) { output += chunk.toString(); done(); } }), { isTTY: true, columns: 120, rows: 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const running = main(['monitor', '--install', 'current'], { root: f.current.dir, env: { ...f.options.env, TERM: 'xterm' }, stdout, stdin,
    signal: controller.signal, inspectMonitor });
  try { await vi.waitFor(() => { expect(trace.databases).toContain(f.current.ledger); expect(output).toContain('current'); }, { timeout: 5000 }); }
  finally { controller.abort(); expect(await running).toBe(0); }
  untouched(f.other);
});
it('slash monitor forwards selection before collection', async () => {
  const f = await fixture();
  expect((await monitorSlash(f.current.dir, '--install current', { inspectMonitor }, f.options, 'en', 120)).join('\n')).toContain('current');
  expect(trace.databases).toContain(f.current.ledger); untouched(f.other);
});
it('an exact external id opens only that ledger and retains its existing diagnostic', async () => {
  const f = await fixture(), snapshot = await inspectMonitor(f.current.dir, f.options, { schemaVersion: 1, install: 'other' });
  expect(snapshot.sourcesRead).toEqual(['other']); expect(snapshot.installs).toMatchObject([{ id: 'other', status: 'unavailable' }]);
  expect(snapshot.installs[0]!.diagnostics.some(code => code.startsWith('ledger-unavailable:'))).toBe(true);
  expect(trace.databases).toContain(f.other.ledger); expect(trace.databases).not.toContain(f.current.ledger);
  expect(trace.fs.filter(path => path.startsWith(f.current.data + '/'))).toEqual([]);
});
it('unknown ids collect nothing, while omission retains all Next sources and proves the poison would be touched', async () => {
  const f = await fixture(), empty = await inspectMonitor(f.current.dir, f.options, { schemaVersion: 1, install: 'missing' });
  expect(empty).toMatchObject({ sourcesRead: [], installs: [] }); expect(trace.databases).toEqual([]); untouched(f.other);
  const all = await inspectMonitor(f.current.dir, f.options);
  expect(all.sourcesRead).toEqual(['current', 'other']); expect(trace.databases).toContain(f.other.ledger);
  expect(all.installs[1]!.status).toBe('unavailable');
  // Display-only filtering cannot rewrite the access-boundary evidence.
  expect((await loadMonitorSurface()).filterSnapshot(all, { install: 'current' }).sourcesRead).toEqual(['current', 'other']);
});
it('an explicitly selected same-path alias keeps its id and collects once', async () => {
  const f = await fixture(), snapshot = await inspectMonitor(f.current.dir, f.options, { schemaVersion: 1, install: 'alias' });
  expect(snapshot.sourcesRead).toEqual(['alias']); expect(snapshot.installs.map(install => install.id)).toEqual(['alias']);
  expect(trace.databases.filter(path => path === f.current.ledger)).toHaveLength(1); untouched(f.other);
});
it('MCP validates the same query, advertises read-only hints and returns the selected source evidence', async () => {
  const f = await fixture(); let calls = 0;
  const server = createMcpServer({ async inspectRun() { return {}; }, async inspectInventory() { return {}; },
    inspectMonitor: (query: MonitorQuery) => { calls++; return inspectMonitor(f.current.dir, f.options, query); } },
  { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
  const client = new Client({ name: 'monitor-selection-test', version: '1' }); await client.connect(ct);
  try {
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'inspect_monitor')!;
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.inputSchema.properties).toMatchObject({ schemaVersion: { const: 1 }, install: { type: 'string', minLength: 1 } });
    const result = await client.callTool({ name: 'inspect_monitor', arguments: { schemaVersion: 1, install: 'current' } });
    expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ sourcesRead: ['current'], installs: [{ id: 'current', status: 'available' }] });
    untouched(f.other); const connections = [...trace.databases];
    const invalid = await client.callTool({ name: 'inspect_monitor', arguments: { schemaVersion: 1, install: 'other', extra: true } });
    expect(invalid.isError).toBe(true); expect(invalid.content).toEqual([{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code: 'MCP_INPUT_INVALID' }) }]);
    expect(calls).toBe(1); expect(trace.databases).toEqual(connections); untouched(f.other);
  } finally { await client.close(); await server.close(); }
});
