import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname, userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { configureNativeCodingTemplate } from '#composition/core/native-coding/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { applyModelCatalog, createRun, inspectModelCatalog } from '../../../src/index.js';
import { compileNativeCodingDockerProfile, nativeCodingTemplateBase } from '#adapters/index.js';
import { clearConfigCache, loadConfig } from '#platform/index.js';
import { encodeExecutionProfileDefinition } from '#domain/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

const roots: string[] = [];
/** alpha.55.1: an apply writes the protected `admission` root, so these cases run as the witnessed person at a terminal. */
const person = { witness: { attest: async () => true } };
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const imageId = `sha256:${'a'.repeat(64)}`;
const docker = { executable: 'docker', imageId, memoryBytes: 268435456, cpus: 1, pids: 64,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const { executable, ...taskDocker } = docker; void executable;
const pin = compileNativeCodingDockerProfile({ id: 'admitted', version: 1, adapter: { id: 'docker', version: 2 },
  parameters: { ...taskDocker, argv: ['unused'] } },
{ schemaVersion: 4, provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' },
  permissionMode: 'unattended', model: { channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] },
  composition: { schemaVersion: 1, task: 'fixture', scope: 'note.txt', acceptance: 'fixture' } });
const registry = { schemaVersion: 1, revision: 'before-template', profiles: [pin], kinds: [{ kind: 'prepared', profile: { id: pin.id, version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const request = { provider: 'claude', kind: 'feature', apply: false };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'coding-template-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global') } };
  await applyPolicyTemplateInstallation(root, 's');
  const path = join(root, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.terminal = { ...config.terminal, scopeId: 's' };
  config.execution = { docker, git: { gitExecutable: 'git', timeoutMs: 5000 } };
  config.admission = { registry, poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order' };
  await writeFile(path, JSON.stringify(config)); clearConfigCache();
  const opened = await openConfiguredAttemptStore(root, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const policyPath = join((await loadConfig(root, options)).productLayout.root, 'policy.json');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  policy.grants.push({ id: 'template-test-run', effect: 'allow', actions: ['create', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'template-test-pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const backups = async () => (await readdir(join(root, '.deckent'))).filter(name => name.includes('.bak.')).sort();
  const auditCount = () => { const db = new DatabaseSync(opened.path, { readOnly: true }); try { return Number(db.prepare('SELECT count(*) AS n FROM audit_events').get()!.n); } finally { db.close(); } };
  const mutate = async (edit: (value: typeof config) => void) => { const value = JSON.parse(await readFile(path, 'utf8')); edit(value); await writeFile(path, JSON.stringify(value)); clearConfigCache(); };
  return { root, path, options, policyPath, backups, auditCount, mutate };
}

describe.skipIf(process.platform === 'win32')('coding template configured producer and real CLI surface', () => {
  it('preview/apply preserve exact profile bytes, old rows, CAS backup/audit and an unchanged repeat', async () => {
    const f = await setup(), before = await readFile(f.path, 'utf8'), audits = f.auditCount(), backups = await f.backups();
    const preview = await configureNativeCodingTemplate(f.root, request, f.options, person);
    expect(preview.status).toBe('preview'); expect(preview.write).toBeNull();
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.auditCount()).toBe(audits); expect(await f.backups()).toEqual(backups);
    nativeCodingTemplateBase(preview.profile);
    expect(preview.profile.parameters).toMatchObject({ docker: taskDocker, invocation: { provider: 'claude', cliVersion: '2.1.285 (Claude Code)' } });
    const invocation = preview.profile.parameters['invocation'] as Record<string, unknown>;
    for (const field of ['model', 'prompt', 'effort']) expect(invocation).not.toHaveProperty(field);
    for (const field of ['argv', 'nativeSubscription', 'executable']) expect(preview.profile.parameters['docker']).not.toHaveProperty(field);
    const applied = await configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, person);
    const saved = JSON.parse(await readFile(f.path, 'utf8')).admission.registry;
    expect(saved).toEqual(preview.registry); expect(applied.registry).toEqual(preview.registry);
    expect(encodeExecutionProfileDefinition(saved.profiles.at(-1))).toBe(encodeExecutionProfileDefinition(preview.profile));
    expect(saved.profiles[0]).toEqual(pin); expect(saved.kinds[0]).toEqual(registry.kinds[0]);
    expect(saved.evaluators).toEqual(registry.evaluators); expect(saved.revision).not.toBe(registry.revision);
    expect(applied.write?.beforeDigest).toBe(preview.expect); expect(await readFile(applied.write!.backupPath!, 'utf8')).toBe(before);
    expect(f.auditCount()).toBe(audits + 1);
    const after = await readFile(f.path, 'utf8'), savedBackups = await f.backups();
    expect((await configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, person)).status).toBe('unchanged');
    expect(await readFile(f.path, 'utf8')).toBe(after); expect(await f.backups()).toEqual(savedBackups); expect(f.auditCount()).toBe(audits + 1);
    const shared = await configureNativeCodingTemplate(f.root, { ...request, kind: 'another', apply: true }, f.options, person);
    expect(shared.registry.profiles).toHaveLength(2); expect(shared.registry.kinds).toHaveLength(3);
  });

  it.each([
    [{ ...request, provider: 'unknown' }, 'CODING_TEMPLATE_INPUT_INVALID'],
    [{ ...request, kind: ' bad ' }, 'CODING_TEMPLATE_INPUT_INVALID'],
    [{ ...request, image: 'tag:latest' }, 'CODING_TEMPLATE_INPUT_INVALID'],
    [{ ...request, model: 'alias' }, 'CODING_TEMPLATE_INPUT_INVALID'],
    [{ ...request, provider: 'codex' }, 'CODING_TEMPLATE_TOOLCHAIN_REQUIRED'],
    [{ ...request, image: `sha256:${'b'.repeat(64)}` }, 'CODING_TEMPLATE_TOOLCHAIN_REQUIRED'],
    [{ ...request, kind: 'prepared' }, 'CODING_TEMPLATE_KIND_CONFLICT'],
  ])('refuses %j without writing', async (input, code) => {
    const f = await setup(), before = await readFile(f.path, 'utf8'), audits = f.auditCount(), backups = await f.backups();
    await expect(configureNativeCodingTemplate(f.root, { ...input, apply: true }, f.options, person)).rejects.toMatchObject({ code });
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.auditCount()).toBe(audits); expect(await f.backups()).toEqual(backups);
  });

  it.each(['admission', 'execution'])('explains the missing %s prerequisite without inventing it', async section => {
    const f = await setup(); await f.mutate(config => { delete config[section]; }); const before = await readFile(f.path, 'utf8');
    await expect(configureNativeCodingTemplate(f.root, request, f.options, person)).rejects.toMatchObject({ code: section === 'admission' ? 'CODING_TEMPLATE_ADMISSION_REQUIRED' : 'CODING_TEMPLATE_IMAGE_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it.each(['poolId', 'executionSlots', 'inFlightSlots'])('explains an incomplete admission.%s without healing config', async key => {
    const f = await setup(); await f.mutate(config => { delete config.admission[key]; });
    const before = await readFile(f.path, 'utf8');
    await expect(configureNativeCodingTemplate(f.root, request, f.options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_ADMISSION_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('reports a missing image as a typed prerequisite and leaves invalid config bytes intact', async () => {
    const f = await setup(); await f.mutate(config => { delete config.execution.docker.imageId; });
    const before = await readFile(f.path, 'utf8');
    await expect(configureNativeCodingTemplate(f.root, request, f.options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_IMAGE_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('validates an existing registry before proposing any publication', async () => {
    const f = await setup(); await f.mutate(config => { config.admission.registry = { ...registry, kinds: [] }; });
    const before = await readFile(f.path, 'utf8');
    await expect(configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_REGISTRY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('refuses ambiguous admitted pins and global registry overlays', async () => {
    const f = await setup(); await f.mutate(config => { const newer = { ...pin, id: 'newer', parameters: structuredClone(pin.parameters) }; (newer.parameters as unknown as { nativeSubscription: { preflight: { cliVersion: string } } }).nativeSubscription.preflight.cliVersion = '2.1.286';
      config.admission.registry.profiles.push(newer); config.admission.registry.kinds.push({ kind: 'newer', profile: { id: 'newer', version: 1 } }); });
    await expect(configureNativeCodingTemplate(f.root, request, f.options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_TOOLCHAIN_REQUIRED' });
    await f.mutate(config => { config.admission.registry = registry; });
    await mkdir(join(f.root, 'global'), { recursive: true });
    await writeFile(join(f.root, 'global/config.json'), JSON.stringify({ admission: { registry } }));
    await expect(configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, person)).rejects.toMatchObject({ code: 'TOOLCHAIN_REGISTRY_LAYER_HOLD' });
  });

  it('refuses a CAS race and keeps the concurrent edit with no template backup or audit', async () => {
    const f = await setup(), backups = await f.backups(), audits = f.auditCount();
    await expect(configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, { ...person, beforeWrite: () => f.mutate(config => { config.language = 'tr'; }) }))
      .rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ language: 'tr', admission: { registry } });
    expect(await f.backups()).toEqual(backups); expect(f.auditCount()).toBe(audits);
  });

  it.each(['docker', 'registry'])('refuses a concurrent global %s source without overwriting the project', async source => {
    const f = await setup(), before = await readFile(f.path, 'utf8'), backups = await f.backups(), audits = f.auditCount();
    const beforeWrite = async () => {
      await mkdir(join(f.root, 'global'), { recursive: true });
      // Global-only execution values can affect a project whose Docker selection is inherited.
      await writeFile(join(f.root, 'global/config.json'), JSON.stringify(source === 'registry' ? { admission: { registry } } : { execution: { docker } }));
      if (source === 'docker') {
        const global = JSON.parse(await readFile(join(f.root, 'global/config.json'), 'utf8'));
        global.execution.docker.memoryBytes *= 2;
        await writeFile(join(f.root, 'global/config.json'), JSON.stringify(global));
      }
    };
    if (source === 'docker') {
      await mkdir(join(f.root, 'global'), { recursive: true }); await writeFile(join(f.root, 'global/config.json'), JSON.stringify({ execution: { docker } }));
      await f.mutate(config => { delete config.execution.docker; });
    }
    const project = source === 'docker' ? await readFile(f.path, 'utf8') : before;
    await expect(configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, { ...person, beforeWrite })).rejects.toMatchObject({ code: source === 'registry' ? 'TOOLCHAIN_REGISTRY_LAYER_HOLD' : 'CONFIG_CONCURRENT_REVISION_HOLD' });
    expect(await readFile(f.path, 'utf8')).toBe(project); expect(await f.backups()).toEqual(backups); expect(f.auditCount()).toBe(audits);
  });

  it('keeps CLI flags strict and does not print existing registry profiles', async () => {
    const f = await setup(); let output = '', error = '';
    const context = { root: f.root, env: f.options.env, configureCodingTemplate: (root: string, input: unknown, options: object) => configureNativeCodingTemplate(root, input, options, person),
      stdout: { write: (chunk: string) => { output += chunk; return true; } }, stderr: { write: (chunk: string) => { error += chunk; return true; } } };
    const base = ['coding', 'template', '--provider', 'claude', '--kind', 'feature'];
    for (const extra of [[], ['--preview', '--apply'], ['--apply', '--apply'], ['--preview', '--model', 'alias'], ['--preview', '--provider', 'claude']]) {
      output = ''; expect(await main([...base, ...extra], context), error).toBe(2); expect(output).toBe('');
    }
    output = ''; expect(await main([...base, '--preview', '--json'], context), error).toBe(0);
    expect(JSON.parse(output)).not.toHaveProperty('registry'); expect(output).not.toContain('nativeSubscription'); expect(output).not.toContain('admitted');
  });

  it.each(['deny', 'require-approval'])('preserves config/write %s without publication', async effect => {
    const f = await setup(), policy = JSON.parse(await readFile(f.policyPath, 'utf8'));
    for (const grant of policy.grants) if (grant.resource.kind === 'config') grant.effect = effect;
    await writeFile(f.policyPath, JSON.stringify(policy));
    const before = await readFile(f.path, 'utf8'), audits = f.auditCount(), backups = await f.backups();
    await expect(configureNativeCodingTemplate(f.root, { ...request, apply: true }, f.options, person)).rejects.toMatchObject({ code: effect === 'deny' ? 'POLICY_DENIED' : 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(await readFile(f.path, 'utf8')).toBe(before); expect(await f.backups()).toEqual(backups); expect(f.auditCount()).toBe(audits);
  });

  it('CLI EN/TR preview/apply and a generated workInput kind pass real Run admission', async () => {
    const f = await setup();
    let output = '', error = '';
    const context = { root: f.root, env: f.options.env, configureCodingTemplate: (root: string, input: unknown, options: object) => configureNativeCodingTemplate(root, input, options, person),
      stdout: { write: (chunk: string) => { output += chunk; return true; } }, stderr: { write: (chunk: string) => { error += chunk; return true; } } };
    for (const locale of ['en', 'tr']) {
      output = ''; expect(await main(['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--preview', '--lang', locale], context)).toBe(0);
      expect(output).toContain(locale === 'en' ? 'Coding template preview' : 'Kodlama şablonu önizlemesi');
    }
    // alpha.55.1: `--apply` writes the protected `admission.registry` — refused off a person's terminal (`--json`, a pipe), applied on one.
    const piped = await readFile(f.path, 'utf8');
    output = ''; error = ''; expect(await main(['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--apply', '--json'], context)).not.toBe(0);
    expect(error).toContain('AUTHORITY_WITNESS_REQUIRED'); expect(await readFile(f.path, 'utf8')).toBe(piped);
    const terminal = { ...context, stdin: { isTTY: true }, stdout: { isTTY: true, columns: 120, write: (chunk: string) => { output += chunk; return true; } } };
    output = ''; expect(await main(['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--apply'], terminal), error).toBe(0);
    expect((JSON.parse(await readFile(f.path, 'utf8')) as { admission: { registry: { kinds: { kind: string }[] } } }).admission.registry.kinds.map(entry => entry.kind)).toContain('feature');
    await applyModelCatalog(f.root, { schemaVersion: 1, commandId: 'catalog', scopeId: 's', action: 'register', catalog: await seedCatalog() }, f.options);
    await applyModelCatalog(f.root, { schemaVersion: 1, commandId: 'activate-channel', scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId: null, expectedRevision: 0 }, f.options);
    // Law 6 (owner Q-L6): activating the channel already activates its fresh priced models, so Sonnet needs no second activation.
    const channel = (await inspectModelCatalog(f.root, { schemaVersion: 1, scopeId: 's', channelId: SEED_CHANNEL }, f.options)).channels.find(row => row.access === 'allowed');
    expect(channel?.access === 'allowed' ? channel.models.find(row => row.modelId === 'claude-sonnet-5-5')?.activation?.state : null).toBe('active');
    const result = await createRun(f.root, { schemaVersion: 1, commandId: 'run', scopeId: 's', runId: 'typed-input', graph: { schemaVersion: 3, revision: 1,
      tasks: [{ id: 't', kind: 'feature', dependencies: [], acceptanceCriteria: ['exit'], workInput: { schemaVersion: 1, task: 'Edit note.txt', scope: { paths: ['note.txt'] }, acceptance: 'note.txt updated',
        model: { channelId: SEED_CHANNEL, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } } }],
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] } }, f.options);
    expect(result.admission.run.runId).toBe('typed-input'); expect(result.admission.run.tasks).toHaveLength(1);
  });
});

// C1 (owner 2026-10-23 Q2): own describe so the main block stays within the function size limit.
describe.skipIf(process.platform === 'win32')('coding template discovery selection', () => {
  it('keeps the admitted discovery mode by default and takes an explicit --discovery as a new template content id (C1)', async () => {
    const f = await setup();
    const kept = await configureNativeCodingTemplate(f.root, request, f.options, person);
    expect(kept.profile.parameters).toMatchObject({ invocation: { discovery: { mode: 'repository' } } });
    const hidden = await configureNativeCodingTemplate(f.root, { ...request, discovery: 'disabled' }, f.options, person);
    expect(hidden.profile.parameters).toMatchObject({ invocation: { discovery: { mode: 'disabled' } } });
    expect(hidden.profile.id).not.toBe(kept.profile.id);
    await expect(configureNativeCodingTemplate(f.root, { ...request, discovery: 'off' }, f.options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_INPUT_INVALID' });
    let output = '', error = '';
    const context = { root: f.root, env: f.options.env, configureCodingTemplate: (root: string, input: unknown, options: object) => configureNativeCodingTemplate(root, input, options, person),
      stdout: { write: (chunk: string) => { output += chunk; return true; } }, stderr: { write: (chunk: string) => { error += chunk; return true; } } };
    for (const [locale, said] of [['en', 'Repository instructions: hidden from the worker'], ['tr', 'Repo talimatları: işçiden gizli']] as const) {
      output = ''; expect(await main(['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--discovery', 'disabled', '--preview', '--lang', locale], context), error).toBe(0);
      expect(output).toContain(said);
    }
    output = ''; expect(await main(['coding', 'template', '--provider', 'claude', '--kind', 'feature', '--preview', '--lang', 'en'], context), error).toBe(0);
    expect(output).toContain('Repository instructions: read by the worker');
  });
});
