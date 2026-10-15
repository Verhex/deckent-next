import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeNativeCodingRegistry, configureNativeCodingTemplate } from '#composition/core/native-coding/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { executionRegistrySchema } from '#domain/index.js';
import { main } from '#surfaces/core/cli/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const docker = { executable: 'docker', imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 268435456, cpus: 1, pids: 64,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const request = { schemaVersion: 1, scopeId: 's', provider: 'claude', kind: 'feature', poolId: 'customer', executionSlots: 3,
  inFlightSlots: 5, discovery: 'repository', apply: false };
const detected = { detect: async () => '2.1.285 (Claude Code)' };
type TestConfig = Record<string, unknown> & { execution?: { docker?: typeof docker; git: { gitExecutable: string; timeoutMs: number } } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'initial-registry-')); roots.push(root);
  await applyPolicyTemplateInstallation(root, 's');
  const path = join(root, '.deckent/config.json'), options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  const mutate = async (edit: (config: TestConfig) => void) => { const config = JSON.parse(await readFile(path, 'utf8')) as TestConfig; edit(config); await writeFile(path, JSON.stringify(config)); clearConfigCache(); };
  await mutate(config => { config.execution = { docker, git: { gitExecutable: 'git', timeoutMs: 5000 } }; });
  const config = await loadConfig(root, options), policyPath = join(config.productLayout.root, 'policy.json');
  const auditCount = () => { const db = new DatabaseSync(join(config.productLayout.root, 'state/ledger.db'), { readOnly: true });
    try { return Number(db.prepare('SELECT count(*) AS n FROM audit_events').get()!['n']); } finally { db.close(); } };
  const files = async () => (await readdir(join(root, '.deckent'))).sort();
  return { root, path, options, mutate, policyPath, auditCount, files };
}

// Native Windows has no POSIX installer principal; adapter refusal tests remain active on every platform.
describe.skipIf(process.platform === 'win32')('first registry with POSIX installer custody (Windows: verify-not-run, use WSL2)', () => {
it('fresh policy → preview is read-only → apply writes a versioned registry once → template works without a prepared seed', async () => {
  const f = await setup(), before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  const preview = await initializeNativeCodingRegistry(f.root, request, f.options, detected);
  expect(preview.status).toBe('preview'); expect(executionRegistrySchema.parse(preview.registry).profiles).toEqual([preview.profile]);
  expect(preview.profile).toMatchObject({ version: 1, adapter: { id: 'native-coding-template', version: 1 },
    parameters: { invocation: { provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { mode: 'repository' } } } });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.files()).toEqual(files); expect(f.auditCount()).toBe(audits);
  const applied = await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, detected);
  expect(applied.registry).toEqual(preview.registry); expect(applied.write).toMatchObject({ keyPath: 'admission', beforeDigest: preview.expect });
  expect(f.auditCount()).toBe(audits + 1);
  const stored = await loadConfig(f.root, f.options);
  expect(stored.admission).toMatchObject({ registry: preview.registry, poolId: 'customer', executionSlots: 3, inFlightSlots: 5 });
  const bytes = await readFile(f.path, 'utf8'), afterFiles = await f.files();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { detect: async () => { throw new Error('must not probe existing registry'); } }))
    .rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes); expect(await f.files()).toEqual(afterFiles); expect(f.auditCount()).toBe(audits + 1);
  expect((await configureNativeCodingTemplate(f.root, { provider: 'claude', kind: 'feature', apply: true }, f.options)).status).toBe('unchanged');
  const next = await configureNativeCodingTemplate(f.root, { provider: 'claude', kind: 'review', apply: true }, f.options);
  expect(next.registry.kinds.map(entry => entry.kind)).toEqual(['feature', 'review']); expect(next.registry.profiles).toHaveLength(1);
});

it.each(['project', 'global'] as const)('preserves an existing %s registry, including an empty but authored document', async layer => {
  const f = await setup(), admission = { registry: {}, poolId: 'customer', executionSlots: 3, inFlightSlots: 5, ordering: 'input-order' };
  if (layer === 'project') await f.mutate(config => { config.admission = admission; });
  else { await mkdir(join(f.root, 'global')); await writeFile(join(f.root, 'global/config.json'), JSON.stringify({ schema_version: 4, admission })); }
  const before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, detected)).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.files()).toEqual(files); expect(f.auditCount()).toBe(audits);
  if (layer === 'global') expect(JSON.parse(await readFile(join(f.root, 'global/config.json'), 'utf8')).admission).toEqual(admission);
});

it('reads real-shaped v3 first-session config without changing it, then uses the existing v4 write migration', async () => {
  const f = await setup();
  await f.mutate(config => { config.schema_version = 3; config.language = 'tr'; config.mode = 'retired-selection'; });
  const before = await readFile(f.path, 'utf8');
  await initializeNativeCodingRegistry(f.root, request, f.options, detected);
  expect(await readFile(f.path, 'utf8')).toBe(before);
  await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, detected);
  const after = JSON.parse(await readFile(f.path, 'utf8'));
  expect(after).toMatchObject({ schema_version: 4, language: 'tr', terminal: { scopeId: 's' }, execution: { docker },
    admission: { registry: { schemaVersion: 1, profiles: [{ version: 1, adapter: { id: 'native-coding-template', version: 1 } }] } } });
  expect(after).not.toHaveProperty('mode');
});

it.each([{ scopeId: 'other' }, { executionSlots: 0 }, { provider: 'unknown' }, { discovery: 'unknown' }, { schemaVersion: 2 }, { model: 'alias' }])('refuses invalid input %j before discovery or writes', async change => {
  const f = await setup(), before = await readFile(f.path, 'utf8');
  await expect(initializeNativeCodingRegistry(f.root, { ...request, ...change, apply: true }, f.options, { detect: async () => { throw new Error('unexpected probe'); } }))
    .rejects.toMatchObject({ code: 'scopeId' in change ? 'INITIAL_REGISTRY_CONFIG_CONFLICT' : 'CODING_TEMPLATE_INPUT_INVALID' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it('refuses a missing execution image and an unsupported discovery mode without publication', async () => {
  const f = await setup();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, provider: 'codex', discovery: 'disabled', apply: true }, f.options, detected)).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_CLI_UNAVAILABLE' });
  await f.mutate(config => { delete config.execution; });
  await expect(initializeNativeCodingRegistry(f.root, request, f.options, detected)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_IMAGE_REQUIRED' });
  expect((await loadConfig(f.root, f.options)).admission).toBeNull();
});

it.each(['deny', 'require-approval'])('honors config %s without backup or audit writes', async effect => {
  const f = await setup(), policy = JSON.parse(await readFile(f.policyPath, 'utf8'));
  for (const grant of policy.grants) if (grant.resource.kind === 'config') grant.effect = effect;
  await writeFile(f.policyPath, JSON.stringify(policy));
  const before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, detected)).rejects.toMatchObject({ code: effect === 'deny' ? 'POLICY_DENIED' : 'POLICY_APPROVAL_UNSUPPORTED' });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.files()).toEqual(files); expect(f.auditCount()).toBe(audits);
});

it.each(['project', 'global-image', 'global-registry'] as const)('refuses %s races and preserves the concurrent edit', async race => {
  const f = await setup(), before = await readFile(f.path, 'utf8'), audits = f.auditCount();
  const beforeWrite = async () => {
    if (race === 'project') return f.mutate(config => { config.language = 'tr'; });
    await mkdir(join(f.root, 'global'));
    await writeFile(join(f.root, 'global/config.json'), JSON.stringify(race === 'global-image' ? { execution: { docker: { ...docker, imageId: `sha256:${'b'.repeat(64)}` } } }
      : { admission: { registry: {}, poolId: 'customer', executionSlots: 3, inFlightSlots: 5, ordering: 'input-order' } }));
  };
  if (race === 'global-image') {
    await f.mutate(config => { delete config.execution!.docker; });
    await mkdir(join(f.root, 'global')); await writeFile(join(f.root, 'global/config.json'), JSON.stringify({ execution: { docker } }));
  }
  const project = race === 'global-image' ? await readFile(f.path, 'utf8') : before;
  const raceHook = race === 'global-image' ? async () => writeFile(join(f.root, 'global/config.json'), JSON.stringify({ execution: { docker: { ...docker, cpus: 2 } } })) : beforeWrite;
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, beforeWrite: raceHook }))
    .rejects.toMatchObject({ code: race === 'global-registry' ? 'INITIAL_REGISTRY_EXISTS' : 'CONFIG_CONCURRENT_REVISION_HOLD' });
  if (race === 'project') expect(JSON.parse(await readFile(f.path, 'utf8')).language).toBe('tr');
  else expect(await readFile(f.path, 'utf8')).toBe(project);
  expect((await f.files()).filter(name => name.includes('.bak.'))).toEqual([]); expect(f.auditCount()).toBe(audits);
});

it('renders EN/TR through init registry and emits the real preview/apply contract', async () => {
  const f = await setup(); let output = '', error = '';
  const context = { root: f.root, env: f.options.env,
    initializeNativeCodingRegistry: (root: string, input: unknown) => initializeNativeCodingRegistry(root, input, f.options, detected),
    stdout: { write(text: string) { output += text; } }, stderr: { write(text: string) { error += text; } } };
  const args = ['init', 'registry', '--scope', 's', '--provider', 'claude', '--kind', 'feature', '--pool', 'customer', '--execution-slots', '3', '--in-flight-slots', '5', '--discovery', 'repository'];
  for (const locale of ['en', 'tr']) {
    output = ''; expect(await main([...args, '--preview', '--lang', locale], context), error).toBe(0);
    expect(output).toContain(locale === 'en' ? 'First registry preview' : 'İlk registry önizlemesi'); expect(output).toContain('native-coding-template');
  }
  for (const flags of [[], ['--preview', '--apply'], ['--apply', '--apply'], ['--preview', '--model', 'alias'], ['--preview', '--pool', 'x']]) {
    output = ''; expect(await main([...args, ...flags], context)).toBe(2); expect(output).toBe('');
  }
  output = ''; expect(await main([...args, '--apply', '--json'], context), error).toBe(0); expect(JSON.parse(output).status).toBe('applied');
  output = ''; error = ''; expect(await main([...args, '--apply', '--lang', 'tr'], context)).toBe(78); expect(error).toContain('deckent coding template');
});

});
