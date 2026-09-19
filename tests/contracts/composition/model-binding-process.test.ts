import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { inspectModelBinding } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [];
const cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function snapshot(...rootsToRead: string[]) {
  const entries: Record<string, string> = {};
  const visit = async (base: string, path: string): Promise<void> => { const stat = await lstat(path), key = `${base}:${relative(base, path) || '.'}`;
    if (stat.isDirectory()) { entries[key] = `directory:${stat.mode & 0o777}`; for (const name of (await readdir(path)).sort()) await visit(base, join(path, name)); }
    else entries[key] = `file:${stat.mode & 0o777}:${createHash('sha256').update(await readFile(path)).digest('hex')}`; };
  for (const root of rootsToRead) await visit(root, root); return entries;
}
async function fixture(config?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-binding-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  if (config !== undefined) { await mkdir(join(project, '.deckent'), { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 }); }
  return { project, home, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
const reference = { providerId: 'provider-a', providerVersion: 2, modelId: 'model-a', modelVersion: 3 };
async function inspectEverySurface(f: Awaited<ReturnType<typeof fixture>>, input = reference) {
  const sdk = await inspectModelBinding(f.project, input, { env: f.env });
  const args = ['models', 'binding', '--provider', input.providerId, '--provider-version', String(input.providerVersion),
    '--model', input.modelId, '--model-version', String(input.modelVersion), '--json'];
  const cliResult = JSON.parse((await execute(process.execPath, [cli, ...args], {
    cwd: f.project, env: f.env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout) as unknown;
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', f.project], env: f.env, stderr: 'pipe' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  const client = new Client({ name: 'model-binding-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    expect(transport.pid).toEqual(expect.any(Number));
    const tool = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools.find(value => value.name === 'inspect_model_binding');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const called = await bounded(client.callTool({ name: 'inspect_model_binding', arguments: input }),
      `MCP_CALL_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
    expect(called.isError).not.toBe(true); expect(called.structuredContent).toEqual(sdk);
  } finally {
    await bounded(client.close(), `MCP_CLIENT_CLOSE_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
    await bounded(transport.close(), 'MCP_TRANSPORT_CLOSE_TIMEOUT');
    expect(transport.pid).toBeNull();
  }
  expect(cliResult).toEqual(sdk); return sdk;
}

it('returns one exact immutable binding through SDK, compiled CLI, and real stdio MCP without resource changes', async () => {
  await Promise.all([cli, mcp].map(path => access(path).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); })));
  const catalog = { schemaVersion: 1, revision: 'binding-process-1', providers: [{ id: 'provider-a', version: 2, models: [{ id: 'model-a', version: 3,
    nativeId: 'vendor/model:a@3', protocols: [{ family: 'responses', version: '2026-09', capabilities: [
      { id: 'text', version: 1, state: 'supported' }, { id: 'tools', version: 2, state: 'unknown' }] }] }] }] };
  const f = await fixture({ provider_catalog: catalog }), before = await snapshot(f.project, f.home), sdk = await inspectEverySurface(f);
  expect(sdk).toMatchObject({ schemaVersion: 1, reference, status: 'declared', catalogRevision: 'binding-process-1',
    definition: { model: { nativeId: 'vendor/model:a@3' } },
    binding: { encodingVersion: 1, algorithm: 'sha256', digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    availability: 'not-observed' });
  expect(await snapshot(f.project, f.home)).toEqual(before);
});

it('returns matching explicit absent states through SDK, compiled CLI, and real stdio MCP without filesystem effects', async () => {
  await Promise.all([cli, mcp].map(path => access(path)));
  const absent = await fixture(), absentBefore = await snapshot(absent.project, absent.home);
  expect(await inspectEverySurface(absent)).toEqual({ schemaVersion: 1, reference, status: 'not-configured', catalogRevision: null,
    definition: null, binding: null, availability: 'not-observed' });
  expect(await snapshot(absent.project, absent.home)).toEqual(absentBefore);

  const catalog = { schemaVersion: 1, revision: 'missing-version', providers: [{ id: 'provider-a', version: 2, models: [{ id: 'model-a', version: 4,
    nativeId: 'vendor/model:a@4', protocols: [{ family: 'responses', version: '1', capabilities: [] }] }] }] };
  const missing = await fixture({ provider_catalog: catalog }), missingBefore = await snapshot(missing.project, missing.home);
  expect(await inspectEverySurface(missing)).toEqual({ schemaVersion: 1, reference, status: 'not-declared', catalogRevision: 'missing-version',
    definition: null, binding: null, availability: 'not-observed' });
  expect(await snapshot(missing.project, missing.home)).toEqual(missingBefore);
});

it('rejects corrupt configuration without healing, backup creation, or byte changes', async () => {
  const corrupt = '{"provider_catalog":'; const f = await fixture(corrupt), before = await snapshot(f.project, f.home);
  await expect(inspectModelBinding(f.project, reference, { env: f.env })).rejects.toBeDefined();
  expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(corrupt);
  expect((await readdir(join(f.project, '.deckent'))).filter(name => name.includes('.bak.'))).toEqual([]);
  expect(await snapshot(f.project, f.home)).toEqual(before);
});
