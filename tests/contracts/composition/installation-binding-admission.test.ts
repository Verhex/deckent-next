import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore } from '#adapters/index.js';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { applyInstallation, inspectInstallation, resumeInstallation } from '../../../src/index.js';
import { installationProfile } from '../support/installation-profile.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';

/**
 * Astra 2382 P1-3: owned init (direct policy setup, init apply/resume) evaluates the identity write admission (configured source,
 * relocation, required machine binding) before its first persistent effect. Only the platform machine identity is simulated (absent);
 * records, journals, locks and directories are the real filesystem.
 */
const probe = vi.hoisted(() => ({ machine: undefined as string | Error | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) => {
    if (args[0] === '/etc/machine-id' && probe.machine !== undefined) {
      return probe.machine instanceof Error ? Promise.reject(probe.machine) : Promise.resolve(probe.machine);
    }
    return original.readFile(...args);
  } };
});
const bindingNotRun = await installationBindingNotRunReason(), configuredImage = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = [];
afterEach(async () => { probe.machine = undefined; clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const noMachineId = () => { probe.machine = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const exists = (path: string) => lstat(path).then(() => true, () => false);
/** Every file under `.deckent` with its bytes: the whole persistent footprint of a refused command. */
async function footprint(directory: string) {
  if (!(await exists(directory))) return {};
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }), files: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(directory.length)] = entry.isFile() ? await readFile(path, 'utf8') : '<dir>';
  }
  return files;
}
async function policyProject(installation?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-admission-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project);
  if (installation) {
    await mkdir(join(project, '.deckent'), { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ installation }), { mode: 0o600 });
  }
  return { root, project, deckent: join(project, '.deckent'), identity: join(project, '.deckent/installation-identity/identity.json') };
}

describe.skipIf(process.platform !== 'linux')('direct policy setup admits the identity write before any target or journal', () => {
  it('refuses required machine binding without a machine identity for a first identity and for an existing weak one, with no footprint', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    noMachineId();
    const fresh = await policyProject({ requireMachineBinding: true }), before = await footprint(fresh.deckent);
    await expect(applyPolicyTemplateInstallation(fresh.project, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await footprint(fresh.deckent)).toEqual(before); // only config.json: no policy, bindings, journal, identity or lock
    const existing = await policyProject({});
    await new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: existing.project })).loadOrCreate();
    await writeFile(join(existing.deckent, 'config.json'), JSON.stringify({ installation: { requireMachineBinding: true } }), { mode: 0o600 }); clearConfigCache();
    const retained = await footprint(existing.deckent);
    expect(JSON.parse(retained['/installation-identity/identity.json']!).binding).toMatchObject({ strength: 'weak' });
    await expect(applyPolicyTemplateInstallation(existing.project, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await footprint(existing.deckent)).toEqual(retained);
  });

  it('refuses an unusable configured machine identity source before any effect', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await policyProject({ machineIdentity: { source: '/nonexistent/machine-identity' } }), before = await footprint(f.deckent);
    await expect(applyPolicyTemplateInstallation(f.project, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_SOURCE_INVALID' });
    expect(await footprint(f.deckent)).toEqual(before);
  });

  it('completes a first identity with a weak binding when machine binding is not required', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    noMachineId();
    const f = await policyProject();
    await expect(applyPolicyTemplateInstallation(f.project, 'installation')).resolves.toMatchObject({ status: 'installed' });
    expect(JSON.parse(await readFile(f.identity, 'utf8')).binding).toMatchObject({ schemaVersion: 2, strength: 'weak', source: 'location' });
    expect(await exists(join(f.deckent, 'policy.json'))).toBe(true);
  });
});

/** The heavy init apply/resume needs the configured verification image like the other installation apply suites. */
async function applyFixture(installation: Record<string, unknown>) {
  if (!configuredImage) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required for installation apply integration tests');
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-apply-')); roots.push(root); await chmod(root, 0o700);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(project, { mode: 0o700 });
  const profile = installationProfile({ root: data, images: [configuredImage] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  profile.configuration.execution.docker.executable = '/usr/bin/docker';
  Object.assign(profile.configuration, { installation });
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
  const control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  return { project, data, profile, control, deckent: join(project, '.deckent') };
}

describe.skipIf(process.platform !== 'linux')('init apply and resume admit the identity write before the journal or any resource', () => {
  it('apply refuses required machine binding without a machine identity and leaves no config, policy, ledger, journal or identity', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await applyFixture({ requireMachineBinding: true });
    const evidence = await inspectInstallation(f.project, f.profile, f.control); noMachineId();
    await expect(applyInstallation(f.project, f.profile, { ...f.control, proposalDigest: evidence.proposalDigest, acceptCustom: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await footprint(f.deckent)).toEqual({});
    expect(await exists(f.data)).toBe(false);
  }, 90_000);

  it('apply refuses an unusable configured source before any effect', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await applyFixture({ machineIdentity: { source: '/nonexistent/machine-identity' } });
    const evidence = await inspectInstallation(f.project, f.profile, f.control);
    await expect(applyInstallation(f.project, f.profile, { ...f.control, proposalDigest: evidence.proposalDigest, acceptCustom: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_SOURCE_INVALID' });
    expect(await footprint(f.deckent)).toEqual({});
    expect(await exists(f.data)).toBe(false);
  }, 90_000);

  it.skipIf(userInfo().uid === 0)('resume of a pending publication refuses required machine binding once the machine identity is gone, changing nothing', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await applyFixture({ requireMachineBinding: true }), simulated = '0123456789abcdef0123456789abcdef';
    probe.machine = simulated; // a machine identity while the first attempt runs; it fails later on an unwritable data directory
    const evidence = await inspectInstallation(f.project, f.profile, f.control);
    await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o555);
    await expect(applyInstallation(f.project, f.profile, { ...f.control, proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toBeDefined();
    const pending = await footprint(f.deckent);
    expect(JSON.parse(pending['/installation/journal.json']!)).toMatchObject({ phase: 'pending' });
    await chmod(f.data, 0o700); noMachineId();
    await expect(resumeInstallation(f.project, { ...f.control, proposalDigest: evidence.proposalDigest, acceptCustom: true }))
      .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await footprint(f.deckent)).toEqual(pending);
    expect(await readdir(f.data)).toEqual([]);
  }, 90_000);
});
