import { createHmac } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalOsIdentity, registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
import { ensureConfiguredTerminalIdentity, inspectConfiguredInstallationBinding, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity,
  resolveConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { main } from '#surfaces/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { installationBindingNotRunReason } from '../support/binding-capability.js';

/** Only the platform machine identity is simulated (absent); every path, inode, lock and record is the real filesystem. */
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
registerProviderConfig();
const bindingNotRun = await installationBindingNotRunReason();
const RAW = 'site-7f3c9a.node-identity:raw-value-0001';
const roots: string[] = [];
afterEach(async () => { probe.machine = undefined; vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const noMachineId = () => { probe.machine = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

async function fixture(installation: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-v2-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  const actor = readLocalOsIdentity(), output: string[] = [], sink = { write: (value: string) => { output.push(value); return true; } };
  await writeFile(join(project, '.deckent/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
    grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
      resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') }, options = { env };
  const configure = async (value: Record<string, unknown>) => {
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ terminal: { autostartService: false }, installation: value })); clearConfigCache();
  };
  await configure(installation);
  const directory = join(project, '.deckent/installation-identity'), path = join(directory, 'identity.json');
  const context = { root: project, env, stdout: sink, stderr: sink, loadInstallationIdentity: loadConfiguredInstallationIdentity,
    loadProjectIdentity: loadConfiguredProjectIdentity, resolveInstallationIdentity: resolveConfiguredInstallationIdentity };
  return { root, project, options, env, directory, path, configure, output, context, record: async () => JSON.parse(await readFile(path, 'utf8')) };
}
/** A mounted-secret layout: the configured path is a symlink into an atomically swapped data directory. */
async function mountedSecret(root: string, value: string) {
  const mount = join(root, 'secret'), data = join(mount, '..2026_10_06'); await mkdir(data, { recursive: true });
  await writeFile(join(data, 'machine-id'), `${value}\n`); await symlink('..2026_10_06', join(mount, '..data')); await symlink('..data/machine-id', join(mount, 'machine-id'));
  return join(mount, 'machine-id');
}
const exists = (path: string) => lstat(path).then(() => true, () => false);

describe.skipIf(process.platform !== 'linux')('installation binding v2 through configured composition (Linux filesystem evidence)', () => {
  it('binds to a configured machine identity source behind a mounted-secret symlink; only a keyed digest is persisted or reported', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); noMachineId(); await f.configure({ machineIdentity: { source: await mountedSecret(f.root, RAW) } });
    const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options), bytes = await readFile(f.path, 'utf8');
    expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 2, installationId: ids.installationId, binding: { schemaVersion: 2, strength: 'machine', source: 'configured',
      machineDigest: createHmac('sha256', 'deckent.installation-binding.v1').update(RAW).digest('hex'), canonicalRoot: await realpath(join(f.project, '.deckent')) } });
    expect(bytes).not.toContain(RAW);
    const read = await loadConfiguredInstallationIdentity(f.project, f.options);
    expect(read).toEqual({ status: 'available', value: { schemaVersion: 1, installationId: ids.installationId }, bindingCapability: 'supported',
      binding: { strength: 'machine', source: 'configured' } });
    const inspection = await inspectConfiguredInstallationBinding(f.project, f.options);
    expect(inspection).toEqual({ capability: 'supported', strength: 'machine', source: 'configured', required: false });
    expect(JSON.stringify(read) + JSON.stringify(inspection)).not.toContain(RAW);
  });

  it.skipIf(bindingNotRun !== null).each([['malformed', `has spaces ${RAW}`], ['repeated', 'a'.repeat(32)], ['missing', null], ['directory', 'dir'],
    ['oversized', `${RAW}-${'x'.repeat(70000)}`]])(
    'refuses a %s configured source with a typed error and no fallback; the raw value reaches no record, error or CLI output', async (_case, value) => {
      const f = await fixture(), source = join(f.root, 'machine-identity');
      if (value === 'dir') await mkdir(source); else if (value !== null) await writeFile(source, `${value}\n`);
      await f.configure({ machineIdentity: { source } });
      const refusal = await ensureConfiguredTerminalIdentity(f.project, 's', f.options).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'INSTALLATION_IDENTITY_SOURCE_INVALID' });
      expect(await exists(f.directory)).toBe(false); // refused before any identity directory or record
      // An existing installation: the read path (CLI preflight) refuses typed as well, and nothing is rewritten.
      await f.configure({}); await ensureConfiguredTerminalIdentity(f.project, 's', f.options); const bytes = await readFile(f.path, 'utf8');
      await f.configure({ machineIdentity: { source } });
      await expect(loadConfiguredInstallationIdentity(f.project, f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_SOURCE_INVALID' });
      const surfaced = [JSON.stringify(refusal), (refusal as Error).message];
      for (const lang of ['en', 'tr']) {
        f.output.length = 0;
        const startRuntimeService = vi.fn();
        expect(await main(['runtime', 'serve', '--lang', lang], { ...f.context, startRuntimeService })).toBe(78);
        expect(startRuntimeService).not.toHaveBeenCalled();
        expect(f.output.join('')).toContain('INSTALLATION_IDENTITY_SOURCE_INVALID');
        expect(f.output.join('')).toContain('installation.machineIdentity.source');
        surfaced.push(f.output.join(''));
      }
      const doctor: string[] = [];
      await runKernelCommand(['doctor', '--json'], { root: f.project, env: { ...f.env, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        stdout: { write: (text: string) => { doctor.push(text); return true; } }, inspectInstallationBinding: inspectConfiguredInstallationBinding });
      expect(JSON.parse(doctor.join('')).installationBinding).toEqual({ capability: 'source-invalid', strength: null, source: 'configured', required: false });
      surfaced.push(doctor.join(''));
      expect(await readFile(f.path, 'utf8')).toBe(bytes);
      for (const text of surfaced) { expect(text).not.toContain(RAW); if (value === 'a'.repeat(32)) expect(text).not.toContain(value); }
    });

  it('writes a weak binding without a machine identity and detects a copy (new inode) as RELOCATED without mutation', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); noMachineId();
    const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options), record = await f.record();
    expect(record.binding).toEqual({ schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: await realpath(join(f.project, '.deckent')),
      device: expect.stringMatching(/^\d+$/u), inode: expect.stringMatching(/^[1-9]\d*$/u) });
    expect(await inspectConfiguredInstallationBinding(f.project, f.options)).toEqual({ capability: 'supported', strength: 'weak', source: 'location', required: false });
    const copy = join(f.root, 'copy'); await cp(f.project, copy, { recursive: true });
    const copied = join(copy, '.deckent/installation-identity/identity.json'), bytes = await readFile(copied, 'utf8');
    await expect(loadConfiguredInstallationIdentity(copy, f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    await expect(ensureConfiguredTerminalIdentity(copy, 's', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(copied, 'utf8')).toBe(bytes);
    const kept = await resolveConfiguredInstallationIdentity(copy, 'keep', f.options);
    expect(kept).toMatchObject({ choice: 'keep', previousInstallationId: ids.installationId, installationId: ids.installationId });
    await expect(resolveConfiguredInstallationIdentity(copy, 'new', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    expect((await ensureConfiguredTerminalIdentity(copy, 's', f.options)).installationId).toBe(ids.installationId);
  });

  it('refuses installation-bound writes under requireMachineBinding without a machine identity; reads still report and never write', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture({ requireMachineBinding: true }); noMachineId();
    await expect(ensureConfiguredTerminalIdentity(f.project, 's', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await exists(f.directory)).toBe(false);
    expect(await inspectConfiguredInstallationBinding(f.project, f.options)).toEqual({ capability: 'supported', strength: 'weak', source: 'location', required: true });
    // An existing weak installation: reads answer, every write path refuses and leaves the bytes.
    await f.configure({}); const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options), bytes = await readFile(f.path, 'utf8');
    await f.configure({ requireMachineBinding: true });
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).toMatchObject({ status: 'available', value: { installationId: ids.installationId },
      binding: { strength: 'weak' }, pendingWrite: true });
    await expect(ensureConfiguredTerminalIdentity(f.project, 's', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    await expect(resolveConfiguredInstallationIdentity(f.project, 'keep', f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    // A configured machine identity satisfies the requirement: the same identity is strengthened to machine on the write path.
    await f.configure({ requireMachineBinding: true, machineIdentity: { source: await mountedSecret(f.root, RAW) } });
    expect((await ensureConfiguredTerminalIdentity(f.project, 's', f.options)).installationId).toBe(ids.installationId);
    expect((await f.record()).binding).toMatchObject({ strength: 'machine', source: 'configured' });
  });

  it('reads an unbound v1 record without writing and binds it (weak) on the next write path under the writer lock', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); noMachineId();
    const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options);
    await writeFile(f.path, JSON.stringify({ schemaVersion: 1, installationId: ids.installationId })); await rm(`${f.directory}-lock`, { recursive: true, force: true });
    const v1 = await readFile(f.path, 'utf8');
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).toEqual({ status: 'available', value: { schemaVersion: 1, installationId: ids.installationId },
      bindingCapability: 'supported', binding: { strength: 'weak', source: 'location' }, pendingWrite: true });
    expect(await readFile(f.path, 'utf8')).toBe(v1); // ID-1D: the read path neither writes nor locks
    expect(await exists(`${f.directory}-lock`)).toBe(false);
    const both = await Promise.all([ensureConfiguredTerminalIdentity(f.project, 's', f.options), ensureConfiguredTerminalIdentity(f.project, 's', f.options)]);
    expect(both.map(value => value.installationId)).toEqual([ids.installationId, ids.installationId]);
    expect(await f.record()).toMatchObject({ schemaVersion: 2, installationId: ids.installationId, lastResolution: null, binding: { schemaVersion: 2, strength: 'weak' } });
    const upgraded = await readFile(f.path, 'utf8');
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).not.toHaveProperty('pendingWrite');
    await ensureConfiguredTerminalIdentity(f.project, 's', f.options);
    expect(await readFile(f.path, 'utf8')).toBe(upgraded);
  });

  it('treats a machine-bound record seen only weakly as RELOCATED; --keep records the weak binding with operator consent', async context => {
    if (bindingNotRun) context.skip(bindingNotRun);
    const f = await fixture(); noMachineId(); await f.configure({ machineIdentity: { source: await mountedSecret(f.root, RAW) } });
    const ids = await ensureConfiguredTerminalIdentity(f.project, 's', f.options), bytes = await readFile(f.path, 'utf8');
    await f.configure({});
    await expect(loadConfiguredInstallationIdentity(f.project, f.options)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(await resolveConfiguredInstallationIdentity(f.project, 'keep', f.options)).toMatchObject({ installationId: ids.installationId });
    expect(await f.record()).toMatchObject({ binding: { strength: 'weak', source: 'location' }, lastResolution: { choice: 'keep' } });
    // The kept weak record is strengthened by the next write once a machine identity is configured again (same location evidence).
    await f.configure({ machineIdentity: { source: await mountedSecret(join(f.root, 'other'), `${RAW}-b`) } });
    expect(await loadConfiguredInstallationIdentity(f.project, f.options)).toMatchObject({ pendingWrite: true, binding: { strength: 'machine' } });
    expect((await ensureConfiguredTerminalIdentity(f.project, 's', f.options)).installationId).toBe(ids.installationId);
    expect((await f.record()).binding).toMatchObject({ strength: 'machine', source: 'configured' });
  });
});
