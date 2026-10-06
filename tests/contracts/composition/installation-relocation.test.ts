import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore, readLocalOsIdentity, readScopeCompanies } from '#adapters/index.js';
import { clearConfigCache, loadConfig, productResourcePath, resolveProductLayout } from '#platform/index.js';
import { loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity, loadConfiguredPeerScopeContext,
  resolveConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { main as composedMain } from '#composition/core/cli/index.js';
import { main as mcpMain } from '#composition/core/mcp/index.js';
import { applyPolicyTemplateInstallation, applySuppliedInstallation } from '#composition/core/installation/index.js';
import { main } from '#surfaces/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';
const bindingNotRun = await installationBindingNotRunReason();

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(context => { if (process.platform !== 'linux') context.skip('Linux machine binding required; unsupported capability has a separate adapter test'); else if (bindingNotRun) context.skip(bindingNotRun); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-relocated-')); roots.push(root);
  const original = join(root, 'original'), project = join(root, 'copy'); await mkdir(original);
  const env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') }, options = { env };
  const identity = await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: original })).loadOrCreate(),
    projectIdentity = await new FileProjectIdentityStore(original).loadOrCreate();
  const actor = readLocalOsIdentity();
  await writeFile(join(original, '.deckent/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
    grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  await cp(original, project, { recursive: true });
  const path = join(project, '.deckent/installation-identity/identity.json');
  const output: string[] = [], sink = { write: (value: string) => { output.push(value); } };
  const context = { root: project, env, stdout: sink, stderr: sink, loadInstallationIdentity: loadConfiguredInstallationIdentity,
    loadProjectIdentity: loadConfiguredProjectIdentity, resolveInstallationIdentity: resolveConfiguredInstallationIdentity };
  return { root, original, project, options, identity, projectIdentity, path, output, context };
}

/** The compiled CLI in `project` with exactly `env` (no inherited HOME or global config). */
const compiledCli = (project: string, env: Record<string, string>, args: string[]) => new Promise<{ code: number; output: string }>(done => execFile(process.execPath,
  [resolve('dist/composition/core/cli/internal/entry.js'), ...args], { cwd: project, env: { ...env, PATH: process.env.PATH ?? '/usr/bin:/bin' } },
  (error, stdout, stderr) => done({ code: typeof error?.code === 'number' ? error.code : 0, output: `${stdout}${stderr}` })));
/** A custom installation identity resource and a real policy-template transaction that died after its pending journal entry,
 * before any target and before the default identity (Astra 2363: the crash/retry window). */
async function pendingPolicyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pending-policy-')); roots.push(root);
  const project = join(root, 'project'), env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') };
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { resources: { installationIdentity: 'custom-identity' } } }), { mode: 0o600 });
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const layout = (await loadConfig(project, { env, heal: false })).productLayout;
  await new FileInstallationIdentityStore(layout).loadOrCreate(); clearConfigCache();
  const publish = vi.spyOn(adapters, 'publishInstallationFile').mockRejectedValueOnce(new Error('SIMULATED_CRASH'));
  await expect(applyPolicyTemplateInstallation(project, 's')).rejects.toBeDefined(); publish.mockRestore(); clearConfigCache();
  const journal = join(project, '.deckent/installation/journal.json');
  expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ phase: 'pending', blockers: ['POLICY_TEMPLATE_NOT_APPLIED'] });
  const entries = await readdir(join(project, '.deckent'), { recursive: true });
  expect(entries).not.toContain('policy.json'); expect(entries).not.toContain('installation-identity');
  return { project, env, layout, journal };
}

describe('relocation producer to actual CLI surface', () => {
  it.each(['en', 'tr'])('stops commands and offers two explicit choices, without mutation (%s)', async lang => {
    const f = await fixture(), bytes = await readFile(f.path, 'utf8'), startRuntimeService = vi.fn();
    expect(await main(['runtime', 'serve', '--lang', lang], { ...f.context, startRuntimeService })).toBe(78);
    expect(startRuntimeService).not.toHaveBeenCalled();
    expect(f.output.join('')).toContain('INSTALLATION_IDENTITY_RELOCATED');
    expect(f.output.join('')).toContain('deckent init identity --keep'); expect(f.output.join('')).toContain('deckent init identity --new');
    expect(f.output.join('')).toContain(lang === 'en' ? 'same installation' : 'aynı kurulum');
    expect(await readFile(f.path, 'utf8')).toBe(bytes); f.output.length = 0;
    expect(await main(['init', 'identity', '--lang', lang], f.context)).toBe(78);
    expect(await readFile(f.path, 'utf8')).toBe(bytes); f.output.length = 0;
    expect(await main(['init', 'identity', '--keep', '--new'], f.context)).toBe(2);
    expect(await readFile(f.path, 'utf8')).toBe(bytes); f.output.length = 0;
    expect(await main(['init', 'identity', '--help', '--lang', lang], f.context)).toBe(0);
    expect(f.output.join('')).toContain('--keep'); expect(f.output.join('')).toContain('--new');
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
  it.each(['en', 'tr'])('keeps or replaces the installation identity while preserving project bytes (%s)', async lang => {
    for (const choice of ['keep', 'new'] as const) {
      const f = await fixture(), projectPath = join(f.project, '.deckent/project-identity/identity.json');
      const projectBytes = await readFile(projectPath, 'utf8');
      expect(await main(['init', 'identity', `--${choice}`, '--lang', lang], f.context)).toBe(0);
      const observed = await loadConfiguredInstallationIdentity(f.project, f.options);
      expect(observed.status).toBe('available'); if (observed.status !== 'available') throw new Error('IDENTITY_NOT_CREATED');
      const identity = observed.value;
      expect(f.output.join('')).toContain(f.identity.installationId); expect(f.output.join('')).toContain(identity.installationId);
      expect(f.output.join('')).toContain(lang === 'en' ? 'Previous installationId' : 'Önceki installationId');
      if (choice === 'keep') expect(identity).toEqual(f.identity); else expect(identity.installationId).not.toBe(f.identity.installationId);
      expect(await readFile(projectPath, 'utf8')).toBe(projectBytes);
      expect(await loadConfiguredProjectIdentity(f.project, f.options)).toEqual({ status: 'available', value: f.projectIdentity });
      const record = JSON.parse(await readFile(f.path, 'utf8'));
      expect(record.lastResolution).toMatchObject({ choice, previousInstallationId: f.identity.installationId, installationId: identity.installationId,
        principal: { issuer: readLocalOsIdentity().issuer, subject: readLocalOsIdentity().subject } });
      f.output.length = 0;
      expect(await main(['terminal', 'status', '--json'], f.context)).toBe(0);
      expect(JSON.parse(f.output.join(''))).toMatchObject({ installationId: identity.installationId, projectId: f.projectIdentity.projectId });
      await expect(stat(productResourcePath(resolveProductLayout({ projectRoot: f.project }), 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('wires real CLI recovery to persistence and returns previous/current IDs in JSON', async () => {
    const f = await fixture(); vi.spyOn(process, 'cwd').mockReturnValue(f.project);
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { f.output.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { f.output.push(String(chunk)); return true; });
    expect(await composedMain(['terminal', 'status', '--json'])).toBe(78);
    expect(JSON.parse(f.output.join('')).code).toBe('INSTALLATION_IDENTITY_RELOCATED'); f.output.length = 0;
    // init owns its identity check (catalog `installation: 'owned'`): the dispatcher does not gate it, the command still refuses typed and writes nothing.
    const owned = [f.path, join(f.project, '.deckent/policy.json')], before = await Promise.all(owned.map(path => readFile(path)));
    expect(await composedMain(['init', 'policy', '--scope', 's', '--apply', '--json'])).toBe(78);
    expect(JSON.parse(f.output.join('')).code).toBe('INSTALLATION_IDENTITY_RELOCATED'); f.output.length = 0;
    expect(await Promise.all(owned.map(path => readFile(path)))).toEqual(before);
    await expect(stat(join(f.project, '.deckent/installation'))).rejects.toMatchObject({ code: 'ENOENT' });
    // An installation-independent command answers without reading the installation.
    expect(await composedMain(['policy', 'vocabulary', '--json'])).toBe(0);
    expect(JSON.parse(f.output.join(''))).toHaveProperty('resources'); f.output.length = 0;
    expect(await composedMain(['policy', '--json', 'vocabulary'])).toBe(0); // flag before the action: same contract as the parser's positionals
    expect(JSON.parse(f.output.join(''))).toHaveProperty('resources'); f.output.length = 0;
    expect(await composedMain(['policy', '--lang', 'tr', 'vocabulary', '--json'])).toBe(0); // an option value is not a positional (kernel parser)
    expect(JSON.parse(f.output.join(''))).toHaveProperty('resources'); f.output.length = 0;
    expect(await composedMain(['init', 'identity', '--new', '--json'])).toBe(0);
    const result = JSON.parse(f.output.join(''));
    expect(result.schemaVersion).toBe(1); expect(result.previousInstallationId).toBe(f.identity.installationId);
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).toMatchObject({ status: 'available', value: { installationId: result.installationId } });
    expect(result.installationId).not.toBe(result.previousInstallationId);
    expect(result).not.toHaveProperty('binding');
  });
  it('does not pin a scope in a copied ledger or change ledger/policy/project bytes when selecting new', async () => {
    const f = await fixture(), opened = await openConfiguredAttemptStore(f.original, f.options); opened.store.close();
    await cp(join(f.original, '.deckent/state'), join(f.project, '.deckent/state'), { recursive: true });
    const ledger = productResourcePath(resolveProductLayout({ projectRoot: f.project }), 'ledger');
    const paths = [ledger, join(f.project, '.deckent/policy.json'), join(f.project, '.deckent/project-identity/identity.json')];
    const bytes = await Promise.all(paths.map(path => readFile(path)));
    expect(readScopeCompanies(ledger, 1000, ['s']).size).toBe(0);
    const peer = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' as const };
    await expect(loadConfiguredPeerScopeContext(f.project, 's', f.options, peer, 'write')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(readScopeCompanies(ledger, 1000, ['s']).size).toBe(0);
    await resolveConfiguredInstallationIdentity(f.project, 'new', f.options);
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(bytes);
    expect(readScopeCompanies(ledger, 1000, ['s']).size).toBe(0);
  });
  it('owned init mutations check the configured (custom resource) installation identity before any effect (Astra 2361 P1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-relocated-custom-')); roots.push(root);
    const original = join(root, 'original'), project = join(root, 'copy'), env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') };
    await mkdir(join(original, '.deckent'), { recursive: true, mode: 0o700 });
    await writeFile(join(original, '.deckent/config.json'), JSON.stringify({ layout: { resources: { installationIdentity: 'custom-identity' } } }), { mode: 0o600 });
    const layout = (await loadConfig(original, { env, heal: false })).productLayout;
    await new FileInstallationIdentityStore(layout).loadOrCreate(); clearConfigCache();
    await cp(original, project, { recursive: true });
    const snapshot = async () => { const entries = (await readdir(join(project, '.deckent'), { recursive: true })).sort();
      return { entries, bytes: await Promise.all(['config.json', 'custom-identity/identity.json'].map(name => readFile(join(project, '.deckent', name)))) }; };
    const before = await snapshot();
    expect(before.entries).not.toContain('installation-identity'); expect(before.entries).not.toContain('installation');
    const cli = (args: string[]) => new Promise<{ code: number; output: string }>(done => execFile(process.execPath,
      [resolve('dist/composition/core/cli/internal/entry.js'), ...args], { cwd: project, env: { ...env, PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      (error, stdout, stderr) => done({ code: typeof error?.code === 'number' ? error.code : 0, output: `${stdout}${stderr}` })));
    for (const args of [['init', 'policy', '--scope', 's', '--apply', '--json'],
      ['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', 'a'.repeat(64), '--accept-custom', '--json']]) {
      const result = await cli(args);
      expect(result.code).toBe(78); expect(JSON.parse(result.output).code).toBe('INSTALLATION_IDENTITY_RELOCATED');
      expect(await snapshot()).toEqual(before);
    }
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await expect(applySuppliedInstallation(project, {}, { allowShutdown: false, dockerExecutable: '/usr/bin/docker', proposalDigest: 'a'.repeat(64),
      acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await snapshot()).toEqual(before);
  });
  it('a pending policy journal restored at the same path with new inodes is refused before any effect (Astra 2363 P1)', async () => {
    const f = await pendingPolicyFixture();
    await rename(f.project, `${f.project}.old`); await cp(`${f.project}.old`, f.project, { recursive: true }); clearConfigCache();
    // Precondition: the custom identity's binding (canonical root + device/inode) no longer matches, so the case is not vacuous.
    await expect(new FileInstallationIdentityStore(f.layout).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    const snapshot = async () => ({ entries: (await readdir(join(f.project, '.deckent'), { recursive: true })).sort(),
      bytes: await Promise.all(['config.json', 'custom-identity/identity.json', 'installation/journal.json'].map(name => readFile(join(f.project, '.deckent', name)))) });
    const before = await snapshot();
    for (const args of [['init', 'policy', '--scope', 's', '--apply', '--json'],
      ['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', 'a'.repeat(64), '--accept-custom', '--json']]) {
      const result = await compiledCli(f.project, f.env, args);
      expect(result.code).toBe(78); expect(JSON.parse(result.output).code).toBe('INSTALLATION_IDENTITY_RELOCATED');
      expect(await snapshot()).toEqual(before);
    }
    expect(before.entries).not.toContain('policy.json'); expect(before.entries).not.toContain('bindings.json'); expect(before.entries).not.toContain('installation-identity');
  });
  it('an unmoved pending policy journal still recovers through the compiled CLI (Astra 2363 control)', async () => {
    const f = await pendingPolicyFixture();
    const result = await compiledCli(f.project, f.env, ['init', 'policy', '--scope', 's', '--apply', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(f.journal, 'utf8'))).toMatchObject({ phase: 'committed', blockers: [] });
    await expect(stat(join(f.project, '.deckent/policy.json'))).resolves.toBeDefined();
  });
  it('refuses direct service, MCP and peer admissions before ledger/transport startup', async () => {
    const f = await fixture(), before = await readFile(f.path, 'utf8');
    await expect(startConfiguredRuntimeService(f.project, {}, f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    for (const [key, value] of Object.entries(f.options.env)) vi.stubEnv(key, value);
    await expect(mcpMain(f.project)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    const peer = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' as const };
    await expect(loadConfiguredPeerScopeContext(f.project, 's', f.options, peer, 'write')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    await expect(stat(productResourcePath(resolveProductLayout({ projectRoot: f.project }), 'ledger'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
