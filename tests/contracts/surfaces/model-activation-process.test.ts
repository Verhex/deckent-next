import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { modelActivationTargetId, type ModelActivationInspection, type ModelActivationResult,
  type ModelBindingInspection } from '#engine/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [];
const sdk = resolve('dist/index.js'), cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const sdkProgram = `
import { pathToFileURL } from 'node:url';
const [entry, operation, project, encoded] = process.argv.slice(1), api = await import(pathToFileURL(entry).href), input = JSON.parse(encoded);
try {
  const value = operation === 'binding' ? await api.inspectModelBinding(project, input, { env: process.env })
    : operation === 'inspect' ? await api.inspectModelActivation(project, input, { env: process.env })
    : await api.admitModelActivation(project, input, { env: process.env });
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? 'UNKNOWN' })); }
`;
async function callSdk<T>(project: string, env: Record<string, string>, operation: 'binding' | 'inspect' | 'admit', input: unknown) {
  const output = await execute(process.execPath, ['--input-type=module', '-e', sdkProgram, sdk, operation, project, JSON.stringify(input)],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 });
  return JSON.parse(output.stdout) as { ok: true; value: T } | { ok: false; code: string };
}
async function callMcp(project: string, env: Record<string, string>, name: string, args: Record<string, unknown>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const diagnostics: Buffer[] = []; transport.stderr?.on('data', chunk => diagnostics.push(Buffer.from(chunk)));
  const client = new Client({ name: 'model-activation-process', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    const tool = (await bounded(client.listTools(), 'MCP_LIST_TIMEOUT')).tools.find(value => value.name === name);
    expect(tool?.annotations).toMatchObject(name === 'inspect_model_activation'
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    const result = await bounded(client.callTool({ name, arguments: args }),
      `MCP_CALL_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true); return result.structuredContent;
  } finally {
    const failures: unknown[] = [];
    try { await bounded(client.close(), `MCP_CLIENT_CLOSE_TIMEOUT:${Buffer.concat(diagnostics).toString('utf8').slice(-2048)}`); }
    catch (error) { failures.push(error); }
    try { await bounded(transport.close(), 'MCP_TRANSPORT_CLOSE_TIMEOUT'); }
    catch (error) { failures.push(error); }
    expect(transport.pid).toBeNull(); expect(failures, 'MCP_CLOSE_FAILED').toEqual([]);
  }
}

it('shares exact activation state across SDK, compiled CLI and stdio MCP without catalog resurrection', async () => {
  await Promise.all([sdk, cli, mcp].map(path => access(path).catch(() => { throw new Error('BUILD_REQUIRED'); })));
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-activation-surface-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), data = join(root, 'data');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(home, { mode: 0o700 }), mkdir(data, { mode: 0o700 })]);
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'provider', version: 1,
    models: [{ id: 'model', version: 1, nativeId: 'vendor/native:model', protocols: [{ family: 'responses', version: '1', capabilities: [] }] }] }] };
  const configPath = join(project, '.deckent/config.json'), config = { mode: 'api', layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const seed = await openSqliteModelActivationStore(ledger, sqlite); seed.close();
  const target = modelActivationTargetId(reference), principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const grant = { id: 'model-owner', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: ['scope-a'], principals,
    resource: { kind: 'model-activation', ids: [target] } };
  const policyPath = join(data, 'policy.json'); await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'policy-1', restrictions: [], grants: [grant] }), { mode: 0o600 });
  const observedResult = await callSdk<ModelBindingInspection>(project, env, 'binding', reference); expect(observedResult.ok).toBe(true);
  const observed = (observedResult as { ok: true; value: ModelBindingInspection }).value;
  if (observed.status !== 'declared') throw new Error('FIXTURE_BINDING_MISSING');
  const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate-a', scopeId: 'scope-a', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: observed.binding };
  const activationResult = await callSdk<ModelActivationResult>(project, env, 'admit', activate); expect(activationResult.ok).toBe(true);
  const activated = (activationResult as { ok: true; value: ModelActivationResult }).value;
  expect(activated).toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 1 } } });

  const flags = ['--scope', 'scope-a', '--provider', 'provider', '--provider-version', '1', '--model', 'model', '--model-version', '1', '--json'];
  const cliInspection = JSON.parse((await execute(process.execPath, [cli, 'models', 'activation', ...flags],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout);
  const inspected = await callSdk<ModelActivationInspection>(project, env, 'inspect', { schemaVersion: 1, scopeId: 'scope-a', reference });
  expect(inspected.ok).toBe(true); expect(cliInspection).toEqual((inspected as { ok: true; value: ModelActivationInspection }).value);
  expect(cliInspection.activation).toEqual(activated.receipt.record);

  await writeFile(configPath, JSON.stringify({ mode: 'api', layout: { root: data }, storage: { driver: 'sqlite', sqlite } }), { mode: 0o600 }); clearConfigCache();
  const deactivate = { schemaVersion: 1, action: 'deactivate', commandId: 'deactivate-a', scopeId: 'scope-a', reference,
    expectedRevision: 1, expectedBinding: observed.binding };
  const mcpResult = await callMcp(project, env, 'admit_model_activation', deactivate);
  expect(mcpResult).toMatchObject({ replayed: false, receipt: { record: { state: 'inactive', revision: 2 } } });
  const inactiveResult = await callSdk<ModelActivationInspection>(project, env, 'inspect', { schemaVersion: 1, scopeId: 'scope-a', reference });
  expect(inactiveResult.ok).toBe(true); const inactive = (inactiveResult as { ok: true; value: ModelActivationInspection }).value;
  expect(inactive.activation).toEqual((mcpResult as { receipt: { record: unknown } }).receipt.record);
  expect(await callSdk(project, env, 'admit', activate)).toEqual({ ok: true, value: { replayed: true, receipt: activated.receipt } });
  const stillInactive = await callSdk(project, env, 'inspect', { schemaVersion: 1, scopeId: 'scope-a', reference });
  expect(stillInactive.ok && stillInactive.value.activation).toEqual(inactive.activation);

  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  const activateFlags = ['models', 'activate', ...flags.slice(0, -1), '--command-id', 'activate-b', '--expected-revision', '2',
    '--binding-digest', observed.binding.digest, '--catalog-revision', catalog.revision, '--json'];
  const cliActivated = JSON.parse((await execute(process.execPath, [cli, ...activateFlags],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 })).stdout);
  expect(cliActivated).toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 3 } } });
  const mcpInspection = await callMcp(project, env, 'inspect_model_activation', { schemaVersion: 1, scopeId: 'scope-a', reference });
  const sdkInspection = await callSdk<ModelActivationInspection>(project, env, 'inspect', { schemaVersion: 1, scopeId: 'scope-a', reference });
  expect(sdkInspection.ok).toBe(true); expect(mcpInspection).toEqual((sdkInspection as { ok: true; value: ModelActivationInspection }).value);
  const humanEn = (await execute(process.execPath, [cli, 'models', 'activation', ...flags.slice(0, -1), '--lang', 'en'],
    { cwd: project, env, timeout: 10_000 })).stdout;
  const humanTr = (await execute(process.execPath, [cli, 'models', 'activation', ...flags.slice(0, -1), '--lang', 'tr'],
    { cwd: project, env, timeout: 10_000 })).stdout;
  expect(humanEn).toContain('persisted active activation'); expect(humanEn).toContain('availability');
  expect(humanTr).toContain('kayıtlı aktif aktivasyonu'); expect(humanTr).toContain('kullanılabilirliği');
  await expect(execute(process.execPath, [cli, 'models', 'activation', '--scope', 'scope-a', '--provider', 'provider'],
    { cwd: project, env, timeout: 10_000 })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('CLI_USAGE') });
  await expect(execute(process.execPath, [cli, 'models', 'activation', ...flags.slice(0, -1).map(value => value === 'scope-a' ? 'wrong-scope' : value)],
    { cwd: project, env, timeout: 10_000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('POLICY_DENIED') });

  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: 'policy-2', restrictions: [], grants: [] }), { mode: 0o600 });
  const beforeDeny = createHash('sha256').update(await readFile(ledger)).digest('hex');
  expect(await callSdk(project, env, 'admit', activate)).toEqual({ ok: false, code: 'POLICY_DENIED' });
  expect(createHash('sha256').update(await readFile(ledger)).digest('hex')).toBe(beforeDeny);
});
