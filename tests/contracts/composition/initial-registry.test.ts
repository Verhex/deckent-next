import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeNativeCodingRegistry, configureNativeCodingTemplate, addNativeCodingProfile } from '#composition/core/native-coding/index.js';
import { observeSetupPermissions, applySetupPermissions, configuredSetup } from '#composition/core/setup/index.js';
import { applyPolicyTemplateInstallation, openOwnPermissionMode, inspectPolicyTemplate } from '#composition/core/installation/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { withLocalPrincipalChannel } from '#adapters/index.js';
import { listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { setupInitCommand, createSetupController } from '#surfaces/core/setup/index.js';
import { executionRegistrySchema } from '#domain/index.js';
import { main } from '#surfaces/core/cli/index.js';

const roots: string[] = [];
/** alpha.55.1: an apply writes the protected `admission` root, so these cases run as the witnessed person at a terminal. */
const person = { witness: { attest: async () => true } };
/** alpha.55.1: `init registry --apply` writes the protected `admission` root — refused off a person's terminal (a pipe, `--json`), applied on one,
 * whose text output is the heading, then the result document. */
const onTerminal = <T extends object>(context: T, write: (text: string) => void) => ({ ...context, stdin: { isTTY: true }, stdout: { isTTY: true, columns: 120, write } });
const resultOf = (output: string) => JSON.parse(output.slice(output.indexOf('\n') + 1)) as Record<string, unknown>;
const refusedOffTerminal = async (path: string, run: () => Promise<number>, stderr: () => string) => {
  const before = await readFile(path, 'utf8'); expect(await run()).not.toBe(0); expect(stderr()).toContain('AUTHORITY_WITNESS_REQUIRED'); expect(await readFile(path, 'utf8')).toBe(before);
};
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
it('U4C: an explicit image adds a second provider by preview/CAS while preserving existing registry contents and refusing stale/witnessless writes', async () => {
  const f = await setup(), first = await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person });
  const next = { provider: 'codex', kind: 'codex-coding', image: `sha256:${'b'.repeat(64)}`, apply: false };
  const deps = { ...person, detect: async (_provider: string, settings: typeof docker) => { expect(settings.imageId).toBe(next.image); return 'codex-cli 0.163.0'; } };
  const before = await readFile(f.path, 'utf8'), audits = f.auditCount();
  const preview = await addNativeCodingProfile(f.root, next, f.options, deps);
  expect(preview.registry.profiles[0]).toEqual(first.profile); expect(preview.registry.kinds[0]).toEqual(first.kind);
  expect(preview.profile.parameters).toMatchObject({ docker: { imageId: next.image }, invocation: { provider: 'codex' } });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.auditCount()).toBe(audits);
  await expect(addNativeCodingProfile(f.root, { ...next, apply: true, digest: preview.digest, expect: preview.expect }, f.options, { ...deps, witness: { attest: async () => false } })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(addNativeCodingProfile(f.root, { ...next, apply: true, digest: 'f'.repeat(64), expect: preview.expect }, f.options, deps)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  const applied = await addNativeCodingProfile(f.root, { ...next, apply: true, digest: preview.digest, expect: preview.expect }, f.options, deps);
  expect(applied.status).toBe('applied'); expect(applied.registry.profiles).toHaveLength(2); expect(applied.registry.evaluators).toEqual(first.registry.evaluators);
  expect(f.auditCount()).toBe(audits + 1);
  await expect(addNativeCodingProfile(f.root, { ...next, apply: true, digest: preview.digest, expect: preview.expect }, f.options, deps)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
});

it('U4C: witnessed profile defaults resume a partially opened grant and persist the mode through the U5 owner with stale/AI refusals', async () => {
  const f = await setup();
  const principal = await resolveConfiguredConfigPrincipal(f.root, 's', f.options);
  await createConfiguredConfigApplication(f.root, f.options, undefined, person.witness).set({ keyPath: 'identity.profile', value: { id: 'core:solo', version: 1 }, layer: 'global', principal, scopeId: 's', commandId: 'choose-profile' });
  const seen = await observeSetupPermissions(f.root, 's', f.options), before = await readFile(f.policyPath, 'utf8');
  expect(seen).toMatchObject({ state: 'needs-confirmation', mode: 'full-auto' });
  await expect(applySetupPermissions(f.root, 's', seen.digest, f.options, { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(applySetupPermissions(f.root, 's', 'f'.repeat(64), f.options, person.witness)).rejects.toMatchObject({ code: 'PERMISSION_MODE_CONFLICT' });
  expect(await readFile(f.policyPath, 'utf8')).toBe(before);
  const audits = f.auditCount();
  await openOwnPermissionMode(f.root, { scopeId: 's', mode: 'full-auto', confirm: async () => true }, f.options, undefined, person.witness);
  const interrupted = await observeSetupPermissions(f.root, 's', f.options); expect(interrupted.state).toBe('needs-confirmation');
  await applySetupPermissions(f.root, 's', interrupted.digest, f.options, person.witness);
  expect(f.auditCount()).toBe(audits + 2);
  expect(await observeSetupPermissions(f.root, 's', f.options)).toMatchObject({ state: 'applied' });
});
it('U4E G2: real headless init leaves authority pending; the first witnessed carrier saves the profile, resumes only the mode after a post-grant crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-permission-headless-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), LANG: 'en_US.UTF-8', PATH: '' } };
  const host = { listIdentityProfiles, inspectPolicyTemplate }, setup = configuredSetup(host, person.witness);
  let output = '';
  await setupInitCommand(['init', '--yes', '--scope', 's', '--json'], { ...host, ...setup, root, env: options.env,
    stdout: { write(text: string) { output += text; } } });
  expect(JSON.parse(output)).toMatchObject({ authority: { status: 'authority-pending' } });
  for (const [locale, pending] of [['en', 'Authority pending'], ['tr', 'Yetki onayı bekliyor']]) {
    output = '';
    await setupInitCommand(['init', '--scope', 's', '--lang', locale!], { ...host, ...setup, root, env: options.env,
      stdout: { write(text: string) { output += text; } } });
    expect(output).toContain(pending); expect(output).toContain('deckent terminal');
  }
  const missing = await observeSetupPermissions(root, 's', options);
  expect(missing).toMatchObject({ state: 'needs-profile', currentMode: 'standart', effectiveMode: 'standart', mode: 'full-auto', selectedProfile: { id: 'core:solo', version: 1 } });
  expect((await loadConfig(root, options))['identity']).toBeUndefined();
  const policyPath = join(root, '.deckent/policy.json'), bytes = await readFile(policyPath, 'utf8');
  await expect(applySetupPermissions(root, 's', missing.digest, options, { attest: async () => false })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(withLocalPrincipalChannel('mcp', () => applySetupPermissions(root, 's', missing.digest, options, person.witness))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(await readFile(policyPath, 'utf8')).toBe(bytes);
  const interrupted = { attest: async () => !JSON.parse(await readFile(policyPath, 'utf8')).grants.some((row: { id: string }) => row.id === 'installer-permission-mode-full-auto') };
  await expect(applySetupPermissions(root, 's', missing.digest, options, interrupted)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  const next = await observeSetupPermissions(root, 's', options);
  expect(next).toMatchObject({ state: 'needs-confirmation', currentMode: 'standart', mode: 'full-auto' });
  const policyAfterGrant = await readFile(policyPath, 'utf8'), globalAfterProfile = await readFile(join(root, 'global/config.json'), 'utf8');
  const db = new DatabaseSync(join(root, '.deckent/state/ledger.db'), { readOnly: true });
  try {
    const count = () => Number(db.prepare('SELECT count(*) AS n FROM audit_events').get()!['n']), before = count();
    await applySetupPermissions(root, 's', next.digest, options, person.witness);
    expect(count()).toBe(before + 1);
    expect(await readFile(policyPath, 'utf8')).toBe(policyAfterGrant); expect(await readFile(join(root, 'global/config.json'), 'utf8')).toBe(globalAfterProfile);
    expect(await observeSetupPermissions(root, 's', options)).toMatchObject({ state: 'applied', effectiveMode: 'full-auto' });
    const settled = await observeSetupPermissions(root, 's', options);
    await applySetupPermissions(root, 's', settled.digest, options, person.witness); expect(count()).toBe(before + 1);
  } finally { db.close(); }
});
it('U4E G2: the install controller previews and confirms full-auto through the same carrier; a later explicit standart choice stays preserved', async () => {
  const f = await setup(), host = { listIdentityProfiles, inspectPolicyTemplate }, wired = configuredSetup(host, person.witness);
  await f.mutate(config => { config.language = 'en'; });
  const context = { ...host, ...wired, root: f.root, env: f.options.env };
  const observed = await wired.observeSetup(f.root, { ...f.options, person: true });
  const controller = createSetupController({ context, root: f.root, locale: 'en', observed, flags: { json: false, yes: false } });
  await controller.step('core:solo'); await controller.step('apply');
  expect(controller.model().rows.join('\n')).toContain('Profile Solo');
  expect(controller.model().options.find(row => row.id === 'apply')?.label).toBe('Confirm the previewed permissions');
  await controller.step('apply');
  const applied = await observeSetupPermissions(f.root, 's', f.options);
  expect(applied).toMatchObject({ state: 'applied', effectiveMode: 'full-auto' });
  const principal = await resolveConfiguredConfigPrincipal(f.root, 's', f.options);
  const { PermissionModeApplication, AuditApplication } = await import('#engine/index.js');
  const { openSqliteAuditStore, openLocalIntegrityAuthority } = await import('#adapters/index.js');
  const { createLayoutPolicySource } = await import('#composition/core/policy/index.js');
  const config = await loadConfig(f.root, f.options), audit = await openSqliteAuditStore(join(config.productLayout.root, 'state/ledger.db'), config.storage.sqlite, 'forbid');
  try {
    const recorder = new AuditApplication(audit, await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile));
    await new PermissionModeApplication(createLayoutPolicySource(config.productLayout, process.getuid!(), config.inspection.policyMaxBytes), event => { recorder.record(event); }, Date.now)
      .set(principal, { schemaVersion: 1, scopeId: 's', mode: 'standart', expectedRevision: applied.revision });
    const preserved = await observeSetupPermissions(f.root, 's', f.options);
    expect(preserved).toMatchObject({ state: 'applied', preserveMode: true, mode: 'standart', effectiveMode: 'standart' });
    await applySetupPermissions(f.root, 's', preserved.digest, f.options, person.witness);
    expect(await observeSetupPermissions(f.root, 's', f.options)).toMatchObject({ mode: 'standart' });
  } finally { audit.close(); }
});
it('U4E G2: an explicit no-op standart decision is preserved; a selected custom profile without defaults is not-applicable and never replaced', async () => {
  const f = await setup(), principal = await resolveConfiguredConfigPrincipal(f.root, 's', f.options);
  const config = await loadConfig(f.root, f.options);
  const { PermissionModeApplication, AuditApplication } = await import('#engine/index.js');
  const { openSqliteAuditStore, openLocalIntegrityAuthority } = await import('#adapters/index.js');
  const { createLayoutPolicySource } = await import('#composition/core/policy/index.js');
  const source = createLayoutPolicySource(config.productLayout, process.getuid!(), config.inspection.policyMaxBytes);
  const store = await openSqliteAuditStore(join(config.productLayout.root, 'state/ledger.db'), config.storage.sqlite, 'forbid');
  try {
    const initial = await observeSetupPermissions(f.root, 's', f.options), bindings = await readFile(join(config.productLayout.root, 'bindings.json'), 'utf8');
    expect(initial).toMatchObject({ state: 'needs-profile', preserveMode: false });
    const audit = new AuditApplication(store, await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile, true));
    await new PermissionModeApplication(source, event => { audit.record(event); }, Date.now)
      .set(principal, { schemaVersion: 1, scopeId: 's', mode: 'standart', expectedRevision: initial.revision });
    expect(await readFile(join(config.productLayout.root, 'bindings.json'), 'utf8')).toBe(bindings);
    const missing = await observeSetupPermissions(f.root, 's', f.options);
    expect(missing).toMatchObject({ state: 'needs-profile', preserveMode: true, mode: 'standart' });
    await applySetupPermissions(f.root, 's', missing.digest, f.options, person.witness);
    expect(await observeSetupPermissions(f.root, 's', f.options)).toMatchObject({ state: 'applied', effectiveMode: 'standart' });
    await createConfiguredConfigApplication(f.root, f.options, undefined, person.witness).set({ keyPath: 'identity.profile', value: { id: 'core:custom', version: 1 }, layer: 'global', principal, scopeId: 's', commandId: 'custom-profile' });
    const custom = await observeSetupPermissions(f.root, 's', f.options), before = await readFile(join(f.root, 'global/config.json'), 'utf8');
    expect(custom).toMatchObject({ state: 'not-applicable', profile: 'core:custom', effectiveMode: 'standart' });
    await applySetupPermissions(f.root, 's', custom.digest, f.options, person.witness);
    expect(await readFile(join(f.root, 'global/config.json'), 'utf8')).toBe(before);
  } finally { store.close(); }
});
it('fresh policy → preview is read-only → apply writes a versioned registry once → template works without a prepared seed', async () => {
  const f = await setup(), before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  const preview = await initializeNativeCodingRegistry(f.root, request, f.options, { ...detected, ...person });
  expect(preview.status).toBe('preview'); expect(executionRegistrySchema.parse(preview.registry).profiles).toEqual([preview.profile]);
  expect(preview.profile).toMatchObject({ version: 1, adapter: { id: 'native-coding-template', version: 1 },
    parameters: { invocation: { provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { mode: 'repository' } } } });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.files()).toEqual(files); expect(f.auditCount()).toBe(audits);
  const applied = await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person });
  expect(applied.registry).toEqual(preview.registry); expect(applied.write).toMatchObject({ keyPath: 'admission', beforeDigest: preview.expect });
  expect(f.auditCount()).toBe(audits + 1);
  const stored = await loadConfig(f.root, f.options);
  expect(stored.admission).toMatchObject({ registry: preview.registry, poolId: 'customer', executionSlots: 3, inFlightSlots: 5 });
  const bytes = await readFile(f.path, 'utf8'), afterFiles = await f.files();
  // I-S6: an equal existing registry is `current` (preview and apply), without a new probe or any write.
  const noProbe = { detect: async () => { throw new Error('must not probe existing registry'); } };
  for (const apply of [true, false]) expect(await initializeNativeCodingRegistry(f.root, { ...request, apply }, f.options, { ...noProbe, ...person }))
    .toMatchObject({ status: 'current', write: null, registry: preview.registry, profile: preview.profile, kind: preview.kind });
  expect(await readFile(f.path, 'utf8')).toBe(bytes); expect(await f.files()).toEqual(afterFiles); expect(f.auditCount()).toBe(audits + 1);
  // A different request against the existing registry is still refused before any write.
  for (const change of [{ executionSlots: 4 }, { kind: 'review' }, { discovery: 'disabled' }]) await expect(initializeNativeCodingRegistry(f.root, { ...request, ...change, apply: true }, f.options, { ...noProbe, ...person }))
    .rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes); expect(await f.files()).toEqual(afterFiles); expect(f.auditCount()).toBe(audits + 1);
  expect((await configureNativeCodingTemplate(f.root, { provider: 'claude', kind: 'feature', apply: true }, f.options, person)).status).toBe('unchanged');
  const next = await configureNativeCodingTemplate(f.root, { provider: 'claude', kind: 'review', apply: true }, f.options, person);
  expect(next.registry.kinds.map(entry => entry.kind)).toEqual(['feature', 'review']); expect(next.registry.profiles).toHaveLength(1);
  // The registry has grown beyond the first one: no longer `current`, refused before any write.
  const grown = await readFile(f.path, 'utf8');
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...noProbe, ...person })).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
  expect(await readFile(f.path, 'utf8')).toBe(grown);
});

it('execution defaults: only the machine-specific values are authored (no limits JSON) and the first registry uses the registry defaults', async () => {
  const f = await setup();
  await f.mutate(config => { config.execution = { docker: { executable: docker.executable, imageId: docker.imageId }, git: { gitExecutable: 'git' } } as TestConfig['execution']; });
  const effective = (await loadConfig(f.root, f.options)).execution!;
  expect(effective.docker).toEqual({ executable: docker.executable, imageId: docker.imageId, memoryBytes: 2147483648, pids: 512, cpus: 1, logMaxSizeKiB: 2048,
    logMaxFiles: 2, tmpBytes: 1073741824, deadlineMs: 1200000, controlTimeoutMs: 15000, outputBytes: 1048576 });
  expect(effective.git).toMatchObject({ gitExecutable: 'git', timeoutMs: 180000, outputBytes: 4194304 });
  const applied = await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person });
  expect(applied.status).toBe('applied'); expect(JSON.stringify(applied.profile)).toContain('"memoryBytes":2147483648');
  expect((await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person })).status).toBe('current');
  // An operator override still wins, and an invalid override is refused by the schema.
  await f.mutate(config => { config.execution!.docker = { ...config.execution!.docker!, pids: 64 }; });
  expect((await loadConfig(f.root, f.options)).execution!.docker.pids).toBe(64);
  await f.mutate(config => { config.execution!.docker = { ...config.execution!.docker!, pids: 0 }; });
  await expect(loadConfig(f.root, f.options)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: 'execution.docker.pids' })]) });
});

it('named limit: one leaf on an absent execution is refused before any write; the three machine values go in one write', async () => {
  const f = await setup();
  await f.mutate(config => { delete config.execution; });
  const before = await readFile(f.path, 'utf8'), audits = f.auditCount(), principal = await resolveConfiguredConfigPrincipal(f.root, 's', f.options);
  const set = (keyPath: string, value: unknown) => createConfiguredConfigApplication(f.root, f.options).set({ keyPath, value, layer: 'project', principal, scopeId: 's', commandId: `c-${keyPath}` });
  await expect(set('execution.docker.executable', '/usr/bin/docker')).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.auditCount()).toBe(audits);
  await set('execution', { docker: { executable: '/usr/bin/docker', imageId: docker.imageId }, git: { gitExecutable: '/usr/bin/git' } });
  expect((await loadConfig(f.root, f.options)).execution!.docker).toMatchObject({ executable: '/usr/bin/docker', memoryBytes: 2147483648, deadlineMs: 1200000 });
});

it.each(['project', 'global'] as const)('preserves an existing %s registry, including an empty but authored document', async layer => {
  const f = await setup(), admission = { registry: {}, poolId: 'customer', executionSlots: 3, inFlightSlots: 5, ordering: 'input-order' };
  if (layer === 'project') await f.mutate(config => { config.admission = admission; });
  else { await mkdir(join(f.root, 'global')); await writeFile(join(f.root, 'global/config.json'), JSON.stringify({ schema_version: 4, admission })); }
  const before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person })).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.files()).toEqual(files); expect(f.auditCount()).toBe(audits);
  if (layer === 'global') expect(JSON.parse(await readFile(join(f.root, 'global/config.json'), 'utf8')).admission).toEqual(admission);
});

it('reads real-shaped v3 first-session config without changing it, then uses the existing v4 write migration', async () => {
  const f = await setup();
  await f.mutate(config => { config.schema_version = 3; config.language = 'tr'; config.mode = 'retired-selection'; });
  const before = await readFile(f.path, 'utf8');
  await initializeNativeCodingRegistry(f.root, request, f.options, { ...detected, ...person });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  await initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person });
  const after = JSON.parse(await readFile(f.path, 'utf8'));
  expect(after).toMatchObject({ schema_version: 4, language: 'tr', terminal: { scopeId: 's' }, execution: { docker },
    admission: { registry: { schemaVersion: 1, profiles: [{ version: 1, adapter: { id: 'native-coding-template', version: 1 } }] } } });
  expect(after).not.toHaveProperty('mode');
});

it.each([{ scopeId: 'other' }, { executionSlots: 0 }, { provider: 'unknown' }, { discovery: 'unknown' }, { schemaVersion: 2 }, { model: 'alias' }])('refuses invalid input %j before discovery or writes', async change => {
  const f = await setup(), before = await readFile(f.path, 'utf8');
  await expect(initializeNativeCodingRegistry(f.root, { ...request, ...change, apply: true }, f.options, { ...person, detect: async () => { throw new Error('unexpected probe'); } }))
    .rejects.toMatchObject({ code: 'scopeId' in change ? 'INITIAL_REGISTRY_CONFIG_CONFLICT' : 'CODING_TEMPLATE_INPUT_INVALID' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it('refuses a missing execution image without publication; Cursor now defaults to disabled by checkout shaping (C2)', async () => {
  const f = await setup(), cursor = { detect: async () => '2026.10.01-fixture' };
  const { discovery: _omitted, ...omitted } = request; void _omitted;
  // C1 refused Cursor here (no suppression flag); C2 realises `disabled` by the worker checkout, so the default and the explicit mode agree.
  const preview = await initializeNativeCodingRegistry(f.root, { ...omitted, provider: 'cursor' }, f.options, cursor);
  expect(preview.profile).toMatchObject({ parameters: { invocation: { provider: 'cursor', discovery: { mode: 'disabled' } } } });
  expect((await initializeNativeCodingRegistry(f.root, { ...omitted, provider: 'cursor', discovery: 'disabled' }, f.options, cursor)).profile).toEqual(preview.profile);
  await f.mutate(config => { delete config.execution; });
  await expect(initializeNativeCodingRegistry(f.root, request, f.options, { ...detected, ...person })).rejects.toMatchObject({ code: 'CODING_TEMPLATE_IMAGE_REQUIRED' });
  expect((await loadConfig(f.root, f.options)).admission).toBeNull();
});

it('defaults a new Codex registry to disabled discovery when --discovery is omitted (owner 2026-10-23 Q2)', async () => {
  const f = await setup(), codex = { detect: async () => 'codex-cli 0.163.0' };
  const { discovery: _omitted, ...omitted } = request; void _omitted;
  const preview = await initializeNativeCodingRegistry(f.root, { ...omitted, provider: 'codex' }, f.options, codex);
  expect(preview.profile).toMatchObject({ parameters: { invocation: { provider: 'codex', discovery: { mode: 'disabled' } } } });
  const explicit = await initializeNativeCodingRegistry(f.root, { ...omitted, provider: 'codex', discovery: 'disabled' }, f.options, codex);
  expect(explicit.profile).toEqual(preview.profile);
  const repository = await initializeNativeCodingRegistry(f.root, { ...omitted, provider: 'codex', discovery: 'repository' }, f.options, codex);
  expect(repository.profile.id).not.toBe(preview.profile.id);
});

it.each(['deny', 'require-approval'])('honors config %s without backup or audit writes', async effect => {
  const f = await setup(), policy = JSON.parse(await readFile(f.policyPath, 'utf8'));
  for (const grant of policy.grants) if (grant.resource.kind === 'config') grant.effect = effect;
  await writeFile(f.policyPath, JSON.stringify(policy));
  const before = await readFile(f.path, 'utf8'), files = await f.files(), audits = f.auditCount();
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person })).rejects.toMatchObject({ code: effect === 'deny' ? 'POLICY_DENIED' : 'POLICY_APPROVAL_UNSUPPORTED' });
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
  await expect(initializeNativeCodingRegistry(f.root, { ...request, apply: true }, f.options, { ...detected, ...person, beforeWrite: raceHook }))
    .rejects.toMatchObject({ code: race === 'global-registry' ? 'INITIAL_REGISTRY_EXISTS' : 'CONFIG_CONCURRENT_REVISION_HOLD' });
  if (race === 'project') expect(JSON.parse(await readFile(f.path, 'utf8')).language).toBe('tr');
  else expect(await readFile(f.path, 'utf8')).toBe(project);
  expect((await f.files()).filter(name => name.includes('.bak.'))).toEqual([]); expect(f.auditCount()).toBe(audits);
});

it('renders EN/TR through init registry and emits the real preview/apply contract', async () => {
  const f = await setup(); let output = '', error = '';
  const context = { root: f.root, env: f.options.env,
    initializeNativeCodingRegistry: (root: string, input: unknown) => initializeNativeCodingRegistry(root, input, f.options, { ...detected, ...person }),
    stdout: { write(text: string) { output += text; } }, stderr: { write(text: string) { error += text; } } };
  const args = ['init', 'registry', '--scope', 's', '--provider', 'claude', '--kind', 'feature', '--pool', 'customer', '--execution-slots', '3', '--in-flight-slots', '5', '--discovery', 'repository'];
  for (const locale of ['en', 'tr']) {
    output = ''; expect(await main([...args, '--preview', '--lang', locale], context), error).toBe(0);
    expect(output).toContain(locale === 'en' ? 'First registry preview' : 'İlk registry önizlemesi'); expect(output).toContain('native-coding-template');
  }
  for (const flags of [[], ['--preview', '--apply'], ['--apply', '--apply'], ['--preview', '--model', 'alias'], ['--preview', '--pool', 'x']]) {
    output = ''; expect(await main([...args, ...flags], context)).toBe(2); expect(output).toBe('');
  }
  const terminal = onTerminal(context, text => { output += text; }); await refusedOffTerminal(f.path, () => main([...args, '--apply', '--json'], context), () => error);
  for (const status of ['applied', 'current']) { output = ''; expect(await main([...args, '--apply'], terminal), error).toBe(0); expect(resultOf(output)).toMatchObject({ status, ...(status === 'current' ? { write: null } : {}) }); }
  // I-S6 J1 delta: a person sees "already exists, nothing written" for `current`, never "created".
  for (const [locale, said, never] of [['en', 'already exists and matches this request', 'registry created'], ['tr', 'zaten var ve bu istekle aynı', 'registry oluşturuldu']] as const) {
    output = ''; expect(await main([...args, '--apply', '--lang', locale], terminal), error).toBe(0); expect(output).toContain(said); expect(output).not.toContain(never);
  }
  const different = args.map(value => value === '3' ? '4' : value);
  output = ''; error = ''; expect(await main([...different, '--apply', '--lang', 'tr'], terminal)).toBe(78); expect(error).toContain('deckent coding template');
});

});

it.skipIf(process.platform === 'win32')('U4-1r: selected image B reaches discovery and both previews/applies despite configured fallback A', async () => {
  const f = await setup(), image = `sha256:${'b'.repeat(64)}`, seen: string[] = [];
  const dependencies = { ...person, detect: async (_provider: string, settings: typeof docker) => { seen.push(settings.imageId); return '2.1.285 (Claude Code)'; } };
  const before = await readFile(f.path, 'utf8');
  const preview = await initializeNativeCodingRegistry(f.root, { ...request, image }, f.options, dependencies);
  expect(JSON.stringify(preview.profile)).toContain(image); expect(await readFile(f.path, 'utf8')).toBe(before);
  await expect(initializeNativeCodingRegistry(f.root, { ...request, image, expect: 'c'.repeat(64), apply: true }, f.options, dependencies)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
  expect(await readFile(f.path, 'utf8')).toBe(before);
  const applied = await initializeNativeCodingRegistry(f.root, { ...request, image, expect: preview.expect!, apply: true }, f.options, dependencies);
  expect(applied.registry).toEqual(preview.registry); expect(seen).toEqual([image, image]);
  expect((await initializeNativeCodingRegistry(f.root, { ...request, image }, f.options, dependencies)).status).toBe('current');
  await expect(initializeNativeCodingRegistry(f.root, { ...request, image: docker.imageId }, f.options, dependencies)).rejects.toMatchObject({ code: 'INITIAL_REGISTRY_EXISTS' });
});
