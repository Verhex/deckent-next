import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createSecretHelperFactory, registerSecretStoreBackend } from '../../../src/extensions.js';
import { createEnvironmentSecretStore, openConfiguredSecretStore, registerProviderConfig, secretsConfigSchema } from '#adapters/index.js';
import { clearConfigCache, configDisplayView, configuredSecretResolver, getConfigKnownSecrets, loadConfig, redactForRecord,
  registerConfigSection, resolveGlobalConfigPaths } from '#platform/index.js';
import { SecretStoreSwitch, policySecretStoreSwitchAuthorization } from '#engine/index.js';
import { main, runKernelCommand } from '#surfaces/core/cli/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
import { projectInfoModel } from '#surfaces/core/terminal-window/index.js';
import { inspectConfiguredSecretStore, listConfiguredSecretStores } from '#composition/core/secrets/index.js';

const CANARY = 'synthetic-wiring-helper-canary-139f-no-real-key';
const ID = 'custom.secret-store.wiring-helper@1';
const base = await mkdtemp(join(tmpdir(), 'deckent-helper-wiring-'));
const project = join(base, 'project'), script = join(base, 'helper.cjs');
await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
const env = { HOME: join(base, 'home'), USERPROFILE: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global'), PROVIDER_TOKEN: 'env-must-not-win' };
const globalPath = resolveGlobalConfigPaths(env).platformPath;
await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
const principal = { issuer: 'local-os', subject: 'fixture-person' };
const verified = { ...principal, id: 'fixture-person', assurance: 'os-user' as const, scopeIds: ['installation'] };
const policy = { schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants: [
  { id: 'helper-selection', effect: 'allow', actions: ['switch'], scopes: ['installation'], principals: [principal], resource: { kind: 'secret', ids: ['secret-store'] } }] };
// Distribution binds the authorization hook to the existing policy application, verified person and installation scope.
// It grants no new policy cell/default. This fixture's permission is checked again at each helper lookup.
let currentPolicy = policy;
const factory = createSecretHelperFactory({ id: ID, executable: process.execPath, args: [script], cwd: base, timeoutMs: 5_000, maxOutputBytes: 65_538,
  authorize: async () => policySecretStoreSwitchAuthorization(currentPolicy, verified)({ principal, scopeId: 'installation', to: ID, confirmDowngrade: true }) });
registerSecretStoreBackend(factory);
registerProviderConfig();
registerConfigSection('helper_probe', z.object({ token: z.string() }).strict(), { optional: true,
  metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } });
await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ helper_probe: { token: '$DECK:PROVIDER_TOKEN' } }), { mode: 0o600 });
await writeFile(globalPath, JSON.stringify({ secrets: { store: ID } }), { mode: 0o600 });
const success = () => writeFile(script, `require('node:fs').readFileSync(0); require('node:fs').writeSync(1, '${CANARY}\\n');`);
await success();
afterEach(async () => { currentPolicy = policy; clearConfigCache(); await success(); });
afterAll(async () => { clearConfigCache(); await rm(base, { recursive: true, force: true }); });
const capture = () => { const lines: string[] = []; return { lines, sink: { write: (text: string) => { lines.push(text); return true; } } }; };
const supported = process.platform === 'linux' || process.platform === 'darwin';

it.skipIf(!supported)('registered helper resolves through production $DECK resolver, preserves known-secret provenance and selection-only config', async () => {
  const config = await loadConfig(project, { env, heal: false });
  expect(config['helper_probe']).toEqual({ token: CANARY });
  expect(await configuredSecretResolver(config, { env })('PROVIDER_TOKEN')).toBe(CANARY);
  expect(JSON.stringify(configDisplayView(config))).not.toContain(CANARY);
  expect(JSON.stringify(getConfigKnownSecrets(config))).not.toContain(CANARY);
  const projectText = (text: string) => redactForRecord(text, getConfigKnownSecrets(config));
  const screen = projectInfoModel({ title: CANARY, sections: [{ rows: [{ key: 'helper', value: CANARY }] }] }, projectText);
  expect(JSON.stringify(screen)).not.toContain(CANARY); expect(JSON.stringify(screen)).toContain('PROVIDER_TOKEN');
  expect(secretsConfigSchema.safeParse({ store: ID, command: script }).success).toBe(false);
  const stores = await listConfiguredSecretStores(project, { env });
  expect(stores.current).toBe(ID); expect(stores.stores).toContain(ID);
  expect(JSON.stringify(stores)).not.toContain(script); expect(JSON.stringify(stores)).not.toContain(CANARY);
});

it.skipIf(!supported)('doctor/list expose no value and health does not execute the helper', async () => {
  await writeFile(script, `require('node:fs').writeFileSync('executed-by-health', 'yes');`);
  expect(await inspectConfiguredSecretStore(project, { env })).toMatchObject({ backend: ID, writable: false, enumerable: false, status: 'unavailable' });
  await expect(readFile(join(base, 'executed-by-health'))).rejects.toMatchObject({ code: 'ENOENT' });
  const out = capture();
  await runKernelCommand(['doctor', '--json'], { root: project, env, stdout: out.sink, inspectSecretStore: inspectConfiguredSecretStore });
  expect(out.lines.join('')).not.toContain(CANARY); expect(out.lines.join('')).not.toContain(script);
  const errorOut = capture(), list = capture();
  expect(await main(['secret', 'list', '--json'], { root: project, env, stdout: list.sink, stderr: errorOut.sink,
    listSecretNames: async () => ({ schemaVersion: 1, backend: ID, names: await openConfiguredSecretStore({ secrets: { store: ID } }, env).listNames() }) })).not.toBe(0);
  expect(errorOut.lines.join('') + list.lines.join('')).not.toContain(CANARY);
});

it.skipIf(!supported)('helper failure is redacted on SDK error, CLI and MCP surfaces in both locales', async () => {
  await writeFile(script, `require('node:fs').readFileSync(0); require('node:fs').writeSync(1, '${CANARY}'); require('node:fs').writeSync(2, '${CANARY}'); process.exitCode = 17;`);
  const resolve = configuredSecretResolver({ secrets: { store: ID } }, { env });
  const error = await resolve('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_HELPER_FAILED' }); expect(JSON.stringify(error)).not.toContain(CANARY);
  for (const locale of ['en', 'tr'] as const) {
    const output = capture(), errors = capture();
    expect(await main(['secret', 'list', '--json', '--lang', locale], { root: project, env, stdout: output.sink, stderr: errors.sink,
      listSecretNames: async () => { await resolve('PROVIDER_TOKEN'); throw new Error('unreachable'); } })).not.toBe(0);
    expect(output.lines.join('') + errors.lines.join('')).not.toContain(CANARY);
    expect(output.lines.join('') + errors.lines.join('')).toContain('SECRET_HELPER_FAILED');
    const server = createMcpServer({ inspectRun: async () => ({}), inspectInventory: async () => resolve('PROVIDER_TOKEN') },
      { maxConcurrentCalls: 1, responseMaxBytes: 4096 }, locale);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); const client = new Client({ name: 'secret-helper-test', version: '1' }); await client.connect(clientTransport);
    try {
      const answer = JSON.stringify(await client.callTool({ name: 'inspect_inventory', arguments: { schemaVersion: 1, scopeId: 'installation' } }));
      expect(answer).toContain('SECRET_HELPER_FAILED'); expect(answer).not.toContain(CANARY); expect(answer).not.toContain(script);
    } finally { await client.close(); await server.close(); }
  }
});

it.skipIf(!supported)('policy is fresh per lookup: revocation stops the configured resolver without environment fallback', async () => {
  const resolve = configuredSecretResolver({ secrets: { store: ID } }, { env });
  expect(await resolve('PROVIDER_TOKEN')).toBe(CANARY);
  currentPolicy = { ...policy, grants: [] };
  await expect(resolve('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_HELPER_DENIED' });
});

it('governed switch records principal/scope/policy and only selects a read-only helper when no secrets need moving', async () => {
  let selection: string | null = null;
  const records: unknown[] = [];
  const helper = factory.create({ env, platform: process.platform, root: base });
  const stores = new Map([['core.secret-store.env@1', createEnvironmentSecretStore({})], [ID, helper]]);
  const ports = { has: (id: string) => stores.has(id), open: (id: string) => stores.get(id)!,
    selection: { read: async () => ({ store: selection, digest: null }), publish: async (id: string) => { selection = id; } },
    authorize: policySecretStoreSwitchAuthorization(policy, verified), audit: (event: unknown) => { records.push(event); }, now: () => 1,
    custody: { exclusive: async <T>(work: () => Promise<T>) => work(), selected: async () => selection ?? 'core.secret-store.env@1' },
    environmentReferences: async () => [] };
  const request = { principal, scopeId: 'installation', to: ID, confirmDowngrade: true };
  await expect(new SecretStoreSwitch({ ...ports, authorize: policySecretStoreSwitchAuthorization({ ...policy, grants: [] }, verified) }).switch(request))
    .rejects.toMatchObject({ code: 'SECRET_STORE_SWITCH_DENIED' });
  expect(selection).toBeNull();
  await expect(new SecretStoreSwitch(ports).switch(request)).resolves.toMatchObject({ to: ID, entries: 0 });
  expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ principal, scopeId: 'installation', policyRevision: 'fixture-policy' })]));
  expect(JSON.stringify(records)).not.toContain(CANARY); expect(JSON.stringify(records)).not.toContain(script);
  // A non-empty enumerable source cannot be moved into this read-only helper; old selection and values survive.
  const source = { ...createEnvironmentSecretStore({ A: CANARY }), descriptor: { id: 'custom.secret-store.source@1', writable: true, enumerable: true }, listNames: async () => ['A'] };
  stores.set(source.descriptor.id, source); selection = source.descriptor.id;
  await expect(new SecretStoreSwitch(ports).switch(request)).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  expect(selection).toBe(source.descriptor.id); expect(await source.get('A')).toBe(CANARY);
});
