import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { inspectDeclaredModels } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function fixture(config?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-declared-models-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  if (config !== undefined) { await mkdir(join(project, '.deckent'), { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 }); }
  return { root, project, home, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
async function snapshot(...rootsToRead: string[]) {
  const entries: Record<string, string> = {};
  const visit = async (base: string, path: string): Promise<void> => {
    const stat = await lstat(path), key = `${base}:${relative(base, path) || '.'}`;
    if (stat.isDirectory()) { entries[key] = `directory:${stat.mode & 0o777}`;
      for (const name of (await readdir(path)).sort()) await visit(base, join(path, name)); return; }
    const bytes = await readFile(path); entries[key] = `file:${stat.mode & 0o777}:${createHash('sha256').update(bytes).digest('hex')}`;
  };
  for (const base of rootsToRead) await visit(base, base);
  return entries;
}

const catalog = { schemaVersion: 1 as const, revision: 'catalog-process-1', providers: [{ id: 'provider-fixture', version: 3,
  models: [{ id: 'model-fixture', version: 4, nativeId: 'vendor/native:model@2026-09-19', protocols: [
    { family: 'responses', version: '2026-09', capabilities: [{ id: 'text', version: 1, state: 'supported' as const },
      { id: 'tools', version: 2, state: 'unknown' as const }] },
  ] }] }] };

it('returns one unchanged declared catalog through SDK, compiled CLI, and real stdio MCP without filesystem effects', async () => {
  await Promise.all([cli, mcp].map(path => access(path).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); })));
  const f = await fixture({ provider_catalog: catalog }), before = await snapshot(f.project, f.home);
  const sdk = await inspectDeclaredModels(f.project, { env: f.env });
  const cliResult = JSON.parse((await execute(process.execPath, [cli, 'models', '--json'], {
    cwd: f.project, env: f.env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as unknown;
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', f.project], env: f.env, stderr: 'pipe' });
  const client = new Client({ name: 'declared-models-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    const tool = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools.find(value => value.name === 'list_declared_models');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const called = await bounded(client.callTool({ name: 'list_declared_models', arguments: {} }), 'MCP_CALL_TIMEOUT');
    expect(called.isError).not.toBe(true); expect(called.structuredContent).toEqual(sdk);
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
  expect(cliResult).toEqual(sdk);
  expect(sdk).toMatchObject({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: {
    revision: 'catalog-process-1', providers: [{ models: [{ nativeId: 'vendor/native:model@2026-09-19',
      protocols: [{ family: 'responses', version: '2026-09' }] }] }] } });
  expect(await snapshot(f.project, f.home)).toEqual(before);
});

it('reports an absent catalog as not configured without creating project or HOME files', async () => {
  const f = await fixture(), before = await snapshot(f.project, f.home);
  await expect(inspectDeclaredModels(f.project, { env: f.env })).resolves.toEqual({ schemaVersion: 1,
    status: 'not-configured', availability: 'not-observed', catalog: null });
  expect(await snapshot(f.project, f.home)).toEqual(before);
});

it('fails on corrupt project config without healing or backup creation', async () => {
  const corrupt = '{"provider_catalog":'; const f = await fixture(corrupt), before = await snapshot(f.project, f.home);
  await expect(inspectDeclaredModels(f.project, { env: f.env })).rejects.toBeDefined();
  expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(corrupt);
  expect((await readdir(join(f.project, '.deckent'))).filter(name => name.includes('.bak.'))).toEqual([]);
  expect(await snapshot(f.project, f.home)).toEqual(before);
});
