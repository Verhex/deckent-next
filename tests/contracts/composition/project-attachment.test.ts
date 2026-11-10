import { executeConfiguredBackup } from '#composition/core/backup/index.js';
import { verifyBackupSet, openSqliteLedger } from '#adapters/index.js';
import { applyConfiguredProviderSpendTemplate, inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import * as localPrincipal from '#adapters/core/local-principal/index.js';
import * as childProcess from 'node:child_process';
import { main as cliMain } from '#composition/core/cli/index.js';
import * as surface from '#surfaces/index.js';
import * as cliHuman from '#surfaces/core/cli-human/index.js';
import { main as surfaceCli } from '#surfaces/core/cli/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { runtime } from '../support/chat-turn-harness.js';
import { carryConfiguredModelActivation, inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { grantConfiguredModelUse, revokeConfiguredModelUse } from '#composition/core/model-use-grant/index.js';
import { resolveConfiguredModelUse, configuredModelProfiles } from '#composition/core/model-use/index.js';
import { ModelBindingApplication } from '#engine/index.js';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPolicyTemplateInstallation, applyPolicyTemplateInstallationWithSecretDefault, configuredProjectAttachment, relocateConfiguredProjectAttachment, executeConfiguredProjectAttachment, previewConfiguredUninstall, applyConfiguredUninstall } from '#composition/core/installation/index.js';
import { configuredAttachmentStore, inspectConfiguredInstallationSource, loadConfiguredScopeContext, loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { FileProjectAttachmentStore, localProjectAttachmentPorts, readAttachmentBootstrapConfig, withInstallationJournal, attachmentLifecycle, captureAttachmentLocation, prepareAttachmentDirectory } from '#adapters/index.js';
import { ProjectAttachmentApplication } from '#engine/index.js';
import { clearConfigCache, productResourcePath, DeckentError } from '#platform/index.js';

const personEffectWitness = vi.hoisted(() => ({ allowed: false }));
// Synthetic disposable-person fixture only. The effect still uses the real session, broker and removal owners.
vi.mock('#adapters/core/local-principal/internal/interactive.js', () => ({ attestLocalInteractiveTerminal: async () => personEffectWitness.allowed }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = vi.fn(actual.execFile);
  for (const symbol of Object.getOwnPropertySymbols(actual.execFile)) Object.defineProperty(execFile, symbol, Object.getOwnPropertyDescriptor(actual.execFile, symbol)!);
  return { ...actual, execFile };
});
vi.mock('#surfaces/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#surfaces/index.js')>();
  return { ...actual, askCliCard: vi.fn(async () => 'no') };
});
const roots: string[] = [];
afterEach(async () => { personEffectWitness.allowed = false; vi.restoreAllMocks(); vi.unstubAllEnvs(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function snapshotBytes(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotBytes(root, path));
    else if (entry.isFile()) result[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  }
  return result;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-attachment-')); roots.push(root);
  const a = join(root, 'A'), b = join(root, 'B'), env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') }, options = { env };
  await mkdir(a, { mode: 0o700 }); await mkdir(b, { mode: 0o700 });
  await applyPolicyTemplateInstallation(a, 'source', options);
  const make = async (target: string, failInstall = false) => {
    const config = await readAttachmentBootstrapConfig(target, options), store = configuredAttachmentStore(config, options);
    // Application-level fixture only: the public composition's real terminal witness is tested separately below.
    return { store, app: new ProjectAttachmentApplication({ store, ...localProjectAttachmentPorts(config, options, store), authorize: async () => {},
      source: (root, scope, actor) => inspectConfiguredInstallationSource(root, scope, actor, options),
      install: async (attachment, identity) => {
        if (failInstall) throw new Error('injected before installer');
        return applyPolicyTemplateInstallation(target, attachment.scopeId, options, { attachment, identity });
      } }) };
  };
  const selected = await make(a), preview = await selected.app.registrationPreview(a, 'source');
  await selected.app.register(a, 'source', preview.planDigest);
  return { root, a, b, options, make, selected };
}
type AttachmentFixture = Awaited<ReturnType<typeof fixture>>;
/** Same existing journey case: keep its real backup/removal/recovery sequence together without adding test declarations. */
async function exerciseAttachedLifecycle(input: { f: AttachmentFixture; target: Awaited<ReturnType<AttachmentFixture['make']>>;
  attached: Awaited<ReturnType<ProjectAttachmentApplication['apply']>>; original: Awaited<ReturnType<typeof loadConfiguredInstallationIdentity>>;
  leasedContext: Awaited<ReturnType<typeof loadConfiguredScopeContext>>; sourceProfile: ReturnType<typeof configuredModelProfiles>[number];
  sourcePath: string; sourceBytes: Buffer; installationId: string | null }) {
  const { f, target, attached, original, leasedContext, sourceProfile, sourcePath, sourceBytes, installationId } = input;
  const sourceBackup = join(f.root, 'source-backup');
  await executeConfiguredBackup(f.a, { schemaVersion: 1, action: 'create', scopeId: 'source', set: sourceBackup }, 'fixture-source-passphrase', f.options);
  await executeConfiguredBackup(f.a, { schemaVersion: 1, action: 'verify', scopeId: 'source', set: sourceBackup }, 'fixture-source-passphrase', f.options);
  const sourceState = await snapshotBytes(f.a);
  const backupSet = join(f.root, 'target-backup'), passphrase = 'fixture-only-passphrase';
  await executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'create', scopeId: 'target', set: backupSet }, passphrase, f.options);
  const verified = await verifyBackupSet(backupSet, passphrase, leasedContext.config.installation.packageMeasurement);
  try { expect(verified.state.schemaVersion).toBe(3); expect(verified.state.entries.some(item => item.resource === 'installationIdentity')).toBe(false);
    expect('globalConfig' in verified.state && verified.state.globalConfig).toBeNull(); } finally { verified.close(); }
  await executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'verify', scopeId: 'target', set: backupSet }, passphrase, f.options);
  await executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'restore', scopeId: 'target', set: backupSet, target: f.b, confirmTarget: f.b }, passphrase, f.options);
  expect((await loadComposedConfig(f.b, f.options)).layout.root).toBeNull();
  const restoredMove = join(f.root, 'restored-B-moved'); await rename(f.b, restoredMove);
  await relocateConfiguredProjectAttachment(restoredMove, 'target', f.options); f.b = restoredMove;
  expect(await (await loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).path()).toBe(join(f.b, '.deckent/state/ledger.db'));
  await executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'restore', scopeId: 'target', set: backupSet, target: f.b, confirmTarget: f.b }, passphrase, f.options);
  expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
  expect(await readFile(sourcePath)).toEqual(sourceBytes);
  expect(await snapshotBytes(f.a)).toEqual(sourceState);
  expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
  await expect(f.selected.app.unregister()).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_SOURCE_REGISTERED' });
  const copy = join(f.root, 'clone'); await cp(f.b, copy, { recursive: true });
  const cloneBefore = await snapshotBytes(copy);
  await expect(executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'restore', scopeId: 'target', set: backupSet, target: copy, confirmTarget: copy }, passphrase, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
  expect(await snapshotBytes(copy)).toEqual(cloneBefore);
  await expect(loadConfiguredInstallationIdentity(copy, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
  const sourceIdentity = join(f.a, '.deckent/installation-identity/identity.json'), bytes = await readFile(sourceIdentity);
  await rename(sourceIdentity, `${sourceIdentity}.held`);
  await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toBeDefined();
  await expect(readFile(sourceIdentity)).rejects.toMatchObject({ code: 'ENOENT' });
  await rename(`${sourceIdentity}.held`, sourceIdentity);
  expect(await readFile(sourceIdentity)).toEqual(bytes);
  await target.app.detach(attached.attachment.projectId);
  expect((await target.store.registration())?.entries[0]?.modelLease?.state).toBe('revoked');
  const restoreApp = await configuredProjectAttachment(f.b, f.options), restorePlan = await restoreApp.preview('target');
  await executeConfiguredProjectAttachment(f.b, { action: 'restore', projectId: attached.attachment.projectId, expect: restorePlan.planDigest }, f.options);
  const renewedContext = await loadConfiguredScopeContext(f.b, 'target', f.options, 'read'), renewed = configuredModelProfiles(renewedContext.config).find(profile => profile.scopeId === 'target')!;
  expect((await resolveConfiguredModelUse(f.b, renewed, renewedContext.principal, f.options))?.sourceProfile).toEqual(sourceProfile);
  await executeConfiguredProjectAttachment(f.b, { action: 'restore', projectId: attached.attachment.projectId, expect: restorePlan.planDigest }, f.options);
  await revokeConfiguredModelUse(f.b, attached.attachment.projectId, f.options);
  await expect(executeConfiguredProjectAttachment(f.b, { action: 'restore', projectId: attached.attachment.projectId, expect: restorePlan.planDigest }, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
  const freshRestore = await restoreApp.preview('target');
  await executeConfiguredProjectAttachment(f.b, { action: 'restore', projectId: attached.attachment.projectId, expect: freshRestore.planDigest }, f.options);
  const all = { schemaVersion: 2, tier: 'all', force: false, disableUnit: false } as const;
  let removal = await previewConfiguredUninstall(f.b, all, f.options);
  expect(removal.blockers).toEqual([]);
  personEffectWitness.allowed = true;
  await expect(applyConfiguredUninstall(f.b, { schemaVersion: 2, commandId: 'interrupt-before-backup', planDigest: removal.planDigest }, {
    backupPassphrase: async () => { throw new Error('fixture interrupted before backup'); }, confirm: async shown => { expect(shown).toEqual(removal); return true; },
  }, f.options)).rejects.toThrow('fixture interrupted before backup');
  expect((await target.store.registration())?.entries[0]?.state).toBe('active');
  const extra = join(f.b, '.deckent/state/scratch', 'a'.repeat(32), 'b'.repeat(32)); await mkdir(extra, { recursive: true, mode: 0o700 });
  await writeFile(join(extra, 'entry'), 'disposable fixture', { mode: 0o600 });
  const heldDigest = removal.planDigest; removal = await previewConfiguredUninstall(f.b, all, f.options); expect(removal.planDigest).not.toBe(heldDigest);
  const removed = await applyConfiguredUninstall(f.b, { schemaVersion: 2, commandId: 'remove-attached-target', planDigest: removal.planDigest }, {
    backupPassphrase: async () => passphrase, confirm: async shown => { expect(shown).toEqual(removal); return true; },
  }, f.options);
  personEffectWitness.allowed = false;
  expect(removed.status).toBe('completed');
  expect((await target.store.registration())?.entries[0]?.state).toBe('revoked');
  expect(await snapshotBytes(f.a)).toEqual(sourceState);
  await executeConfiguredBackup(f.b, { schemaVersion: 1, action: 'restore', scopeId: 'target', set: removed.backup.destination!, target: f.b, confirmTarget: f.b }, passphrase, f.options);
  expect((await target.store.registration())?.entries[0]?.state).toBe('revoked');
  const recoveredPlan = await (await configuredProjectAttachment(f.b, f.options)).preview('target');
  await executeConfiguredProjectAttachment(f.b, { action: 'restore', projectId: attached.attachment.projectId, expect: recoveredPlan.planDigest }, f.options);
  expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
  expect(await snapshotBytes(f.a)).toEqual(sourceState);
  await target.app.detach(attached.attachment.projectId);
  await f.selected.app.revoke(attached.attachment.projectId);
  await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_REVOKED' });
  await f.selected.app.unregister();
  await expect(attachmentLifecycle(await loadComposedConfig(f.a, f.options), f.options).assert()).resolves.toBeUndefined();
  expect(await attachmentLifecycle(await loadComposedConfig(f.b, f.options), f.options).identityId()).toBe(installationId);
}
it.skipIf(process.platform === 'win32')('ATTACH F1: the 0022 floor refuses writable folders without subprocess proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-floor-')); roots.push(root);
  for (const mode of [0o775, 0o757, 0o777]) {
    await fs.chmod(root, mode); vi.mocked(childProcess.execFile).mockClear();
    await expect(captureAttachmentLocation(root)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED', params: { reason: 'location-write', path: root } });
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect((await fs.lstat(root)).mode & 0o777).toBe(mode); expect(await readdir(root)).toEqual([]);
  }
});
it.skipIf(process.platform === 'win32')('ATTACH F2: every 0775 folder asks once before narrowing, with no account subprocess', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-narrow-')); roots.push(root); await fs.chmod(root, 0o775);
  vi.mocked(childProcess.execFile).mockClear();
  const confirm = vi.fn(async () => { expect((await fs.lstat(root)).mode & 0o777).toBe(0o775); expect(await readdir(root)).toEqual([]); return true; });
  await prepareAttachmentDirectory(root, async () => {}, confirm);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(root); expect(childProcess.execFile).not.toHaveBeenCalled();
  expect((await fs.lstat(root)).mode & 0o777).toBe(0o755);
});
it.skipIf(process.platform === 'win32')('ATTACH F3: real initCommand/createCliHost refuse --json on a TTY without asking or writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-json-')); roots.push(root);
  const project = join(root, 'project'), global = join(root, 'global'); await mkdir(project); await mkdir(global); await fs.chmod(project, 0o775);
  vi.stubEnv('DECKENT_GLOBAL_HOME', global); vi.stubEnv('HOME', root); vi.stubEnv('TERM', 'xterm');
  for (const key of [...(await loadComposedConfig(project)).cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined);
  const streams = [process.stdin, process.stdout], descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  streams.forEach(stream => Object.defineProperty(stream, 'isTTY', { configurable: true, value: true }));
  personEffectWitness.allowed = true; vi.mocked(surface.askCliCard).mockClear();
  let output = '';
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
  writes.forEach(write => write.mockImplementation(((text: string) => { output += text; return true; }) as typeof process.stdout.write));
  try {
    // Public CLI composition loads the real createCliHost and dispatches the real initCommand.
    expect(await cliMain(['init', 'policy', '--scope', 's', '--apply', '--json'])).toBe(78);
    expect(surface.askCliCard).not.toHaveBeenCalled(); expect(output).toContain('PROJECT_ATTACHMENT_DENIED');
    expect((await fs.lstat(project)).mode & 0o777).toBe(0o775);
    expect(await readdir(project)).toEqual([]); expect(await readdir(global)).toEqual([]);
    for (const language of ['en', 'tr']) {
      output = '';
      expect(await cliMain(['init', 'policy', '--scope', 's', '--apply', '--lang', language])).toBe(78);
      const request = vi.mocked(surface.askCliCard).mock.calls.at(-1)![0];
      expect(request.initial).toBe('no');
      expect(request.body).toEqual([project, language === 'en'
        ? 'Only this folder: remove write permission for the group and others. Nothing inside the folder changes.'
        : 'Yalnız bu klasör: grubun ve diğer hesapların yazma izni kaldırılır. Klasörün içindekiler değişmez.',
      language === 'en' ? 'Folder permission: 0775 → 0755' : 'Klasör izni: 0775 → 0755']);
      expect(output).toContain('chmod go-w .'); expect(output).toContain('deckent init');
      expect(output).toContain(language === 'en' ? "This is the person's decision." : 'Bu karar kişiye aittir.');
      expect((await fs.lstat(project)).mode & 0o777).toBe(0o775);
      expect(await readdir(project)).toEqual([]); expect(await readdir(global)).toEqual([]);
    }
  } finally { writes.forEach(write => write.mockRestore()); streams.forEach((stream, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); }); }
});
it.skipIf(process.platform !== 'linux')('ATTACH owner repair pins the folder and witness across the answer; never follows replacements or recurses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-permission-')); roots.push(root);
  const folder = join(root, 'folder'), child = join(folder, 'child'); await mkdir(folder); await mkdir(child); await fs.chmod(child, 0o777);
  const authorize = vi.fn(async () => {}), confirm = vi.fn(async () => true);
  for (const mode of [0o775, 0o777]) {
    await fs.chmod(folder, mode);
    await expect(prepareAttachmentDirectory(folder, authorize)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await expect(prepareAttachmentDirectory(folder, async () => { throw new Error('no witness'); }, confirm)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    expect(confirm).not.toHaveBeenCalled();
    await expect(prepareAttachmentDirectory(folder, authorize, async () => false)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    expect((await fs.lstat(folder)).mode & 0o777).toBe(mode); expect(await readdir(folder)).toEqual(['child']);
    await prepareAttachmentDirectory(folder, authorize, confirm);
    expect((await fs.lstat(folder)).mode & 0o777).toBe(0o755); expect((await fs.lstat(child)).mode & 0o777).toBe(0o777);
    confirm.mockClear();
  }
  await fs.chmod(folder, 0o775);
  let afterCalls = 0;
  await expect(prepareAttachmentDirectory(folder, async () => { if (++afterCalls === 3) throw new Error('witness lost after chmod'); }, async () => true)).rejects.toThrow('witness lost after chmod');
  expect((await fs.lstat(folder)).mode & 0o777).toBe(0o755); expect(await readdir(folder)).toEqual(['child']);
  await fs.chmod(folder, 0o777);
  let calls = 0;
  await expect(prepareAttachmentDirectory(folder, async () => { if (++calls === 2) throw new Error('witness lost'); }, async () => true)).rejects.toThrow('witness lost');
  expect((await fs.lstat(folder)).mode & 0o777).toBe(0o777);
  await expect(prepareAttachmentDirectory(folder, authorize, async () => {
    await rename(folder, join(root, 'original')); await symlink(join(root, 'original'), folder); return true;
  })).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
  expect((await fs.lstat(join(root, 'original'))).mode & 0o777).toBe(0o777);
});
it.skipIf(process.platform !== 'linux')('registers only a fresh witnessed first install, keeps an existing source and leaves legacy installs explicit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deckent-first-registration-')); roots.push(base);
  const env = { HOME: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global') }, options = { env };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const a = join(base, 'A'), b = join(base, 'B'), c = join(base, 'C');
  for (const root of [a, b, c]) await mkdir(root, { mode: 0o700 });
  for (const key of [...(await loadComposedConfig(a, options)).cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined);
  vi.spyOn(localPrincipal, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
  await applyPolicyTemplateInstallationWithSecretDefault(a, 'source', options);
  const config = await loadComposedConfig(a, options), store = configuredAttachmentStore(config, options);
  const registered = await store.registration();
  expect(registered?.source).toMatchObject({ projectRoot: a, scopeId: 'source' });
  expect((await executeConfiguredProjectAttachment(b, { action: 'offer', scopeId: 'target' }, options)).kind).toBe('ready');
  const before = await snapshotBytes(env.DECKENT_GLOBAL_HOME);
  await fs.chmod(c, 0o775);
  await expect(applyPolicyTemplateInstallationWithSecretDefault(c, 'third', options)).rejects.toMatchObject({
    code: 'PROJECT_ATTACHMENT_DENIED', message: expect.stringContaining('chmod go-w .') });
  expect(await readdir(c)).toEqual([]);
  expect(await snapshotBytes(env.DECKENT_GLOBAL_HOME)).toEqual(before);
  await fs.chmod(c, 0o700);
  await applyPolicyTemplateInstallationWithSecretDefault(c, 'third', options);
  expect(await snapshotBytes(env.DECKENT_GLOBAL_HOME)).toEqual(before);
  expect(await store.registration()).toEqual(registered);
  // Existing installation + no registration remains explicit even on a person's later witnessed init.
  const legacy = join(base, 'legacy'); await mkdir(legacy, { mode: 0o700 });
  const legacyOptions = { env: { ...env, DECKENT_GLOBAL_HOME: join(base, 'legacy-global') } };
  await applyPolicyTemplateInstallation(legacy, 'legacy', legacyOptions);
  vi.stubEnv('DECKENT_GLOBAL_HOME', legacyOptions.env.DECKENT_GLOBAL_HOME);
  await applyPolicyTemplateInstallationWithSecretDefault(legacy, 'legacy', legacyOptions);
  expect(await configuredAttachmentStore(await loadComposedConfig(legacy, legacyOptions), legacyOptions).registration()).toBeNull();
  // Headless init can initialize its own policy but cannot choose a global source without the register witness.
  const headless = join(base, 'headless'); await mkdir(headless, { mode: 0o700 });
  const headlessOptions = { env: { ...env, DECKENT_GLOBAL_HOME: join(base, 'headless-global') } };
  vi.stubEnv('DECKENT_GLOBAL_HOME', headlessOptions.env.DECKENT_GLOBAL_HOME);
  vi.mocked(localPrincipal.attestLocalInteractiveTerminal).mockResolvedValue(false);
  await applyPolicyTemplateInstallationWithSecretDefault(headless, 'headless', headlessOptions);
  expect(await configuredAttachmentStore(await loadComposedConfig(headless, headlessOptions), headlessOptions).registration()).toBeNull();
  const { registerFreshInstallation } = await import('../../../src/composition/core/installation/internal/attachment.js');
  class EnterpriseCopy extends Error { readonly code = 'AUTHORITY_WITNESS_REQUIRED'; }
  Object.defineProperty(EnterpriseCopy.prototype, Symbol.for('deckent.coded-error'), { value: true });
  const preview = vi.spyOn(ProjectAttachmentApplication.prototype, 'registrationPreview');
  const branded = new EnterpriseCopy(); preview.mockRejectedValue(branded);
  await expect(registerFreshInstallation(headless, 'headless', headlessOptions)).resolves.toEqual({ status: 'witness-required' });
  const spoof = { code: 'AUTHORITY_WITNESS_REQUIRED' }; preview.mockRejectedValue(spoof);
  await expect(registerFreshInstallation(headless, 'headless', headlessOptions)).rejects.toBe(spoof);
  preview.mockRestore();
});

it.skipIf(process.platform !== 'linux')('ATTACH review P2 carries location guidance in EN/TR for direct and raced ancestry symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-attachment-link-')); roots.push(root);
  const real = join(root, 'real'), link = join(root, 'link'); await mkdir(real); await symlink(real, link);
  const assertGuidance = async (path: string) => {
    const error: unknown = await captureAttachmentLocation(path).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeckentError);
    expect(error).toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED', params: { reason: 'location', path } });
    const failure = error as DeckentError;
    for (const [locale, guidance] of [['en', 'Use a real folder you own'], ['tr', 'Size ait gerçek bir klasör kullanın']] as const) {
      const message = failure.localize!(locale).message;
      expect(message).toContain(guidance); expect(message).toContain(path);
      expect(message).not.toContain('/provider'); expect(message).not.toContain('chmod');
    }
  };
  await assertGuidance(link);
  const stat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat;
  // The canonical path was checked, but an ancestor becomes a symlink before the no-follow walk.
  vi.mocked(fs.lstat).mockImplementation(async (...args) => args[0] === root
    ? stat(link, args[1]) : stat(...args));
  try { await assertGuidance(real); } finally { vi.mocked(fs.lstat).mockReset(); }
});

it.skipIf(process.platform !== 'linux')('ATTACHDOC: the copied preview command attaches durably and replays with its generated command id', async () => {
  const f = await fixture(), target = await f.make(f.b), preview = await target.app.preview('target');
  let output = '', errors = '';
  const attachCliContext = { root: f.b, env: f.options.env, stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: { isTTY: true, write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { errors += text; } },
    projectAttachment: async (_root: string, command: import('#domain/index.js').ProjectAttachmentCommand) => {
      if (command.action === 'preview') return target.app.preview(command.scopeId);
      if (command.action === 'apply') return target.app.apply(command.scopeId, command.expect, command.commandId);
      throw new Error('unexpected fixture action');
    } };
  expect(await surfaceCli(['terminal', 'attach', '--scope', 'target', '--preview'], attachCliContext), errors).toBe(0);
  const args = output.trimEnd().split('\n').at(-1)!.split(' ').slice(1), commandId = args.at(-1)!;
  const confirm = vi.spyOn(cliHuman, 'askCliCard').mockResolvedValue('yes');
  try {
    output = '';
    expect(await surfaceCli(args, attachCliContext), errors).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
  } finally { confirm.mockRestore(); }
  const persisted = await target.store.attachment();
  expect(persisted).toMatchObject({ scopeId: 'target', commandId });
  expect(await target.app.apply('target', preview.planDigest, commandId)).toMatchObject({ attachment: persisted });
  expect(await target.store.attachment()).toEqual(persisted);
});

describe.skipIf(process.platform !== 'linux')('shared installation / isolated project context', () => {

  it('registers explicitly, journals one attachment, replays, revokes and never creates a missing source identity', async () => {
    const f = await fixture(), original = await loadConfiguredInstallationIdentity(f.a, f.options), target = await f.make(f.b);
    const preview = await target.app.preview('target'), commandId = randomUUID();
    expect(await target.store.attachment()).toBeNull();
    const attached = await target.app.apply('target', preview.planDigest, commandId);
    expect(attached.status).toBe('attached');
    expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
    const context = await loadConfiguredScopeContext(f.b, 'target', f.options, 'write');
    expect(context.projectId).not.toBe((await loadConfiguredScopeContext(f.a, 'source', f.options, 'read')).projectId);
    expect(context.layout.root).toBe(join(f.b, '.deckent'));
    expect(await target.app.apply('target', preview.planDigest, commandId)).toMatchObject({ status: 'attached', attachment: attached.attachment });
    // Retained crash prefix: earlier resources published, the last attachment publication and journal commit unfinished.
    await withInstallationJournal(f.b, { timeoutMs: 2000 }, async journal => {
      const observed = await journal.observe(), { checksum: ignored, ...record } = observed.record!; void ignored;
      await journal.write(observed, { ...record, phase: 'pending', blockers: ['POLICY_TEMPLATE_NOT_APPLIED'],
        resources: record.resources.map(resource => ({ ...resource, state: resource.resource === 'projectAttachment' ? 'pending' : 'published' })) });
    });
    await rm(join(f.b, '.deckent/project-attachment.json'));
    const active = await target.store.registration();
    await target.store.hold(() => target.store.write(active, { ...active!, entries: active!.entries.map(entry => ({ ...entry, state: 'pending' })) }));
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALLATION_INCOMPLETE' });
    await (await f.make(f.b)).app.apply('target', preview.planDigest, commandId);
    expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
    // A real profile and active-set fixture: no provider execution, no credential copied.
    const model = await runtime({ noServer: true });
    const sourcePath = join(f.a, '.deckent/config.json'), authored = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>;
    const sample = JSON.parse(await readFile(join(model.project, '.deckent/config.json'), 'utf8')) as Record<string, unknown>;
    authored['provider_spending'] = { schemaVersion: 3, budgets: [], template: { budgetId: 'scope-budget', currency: 'USD', limitMinorUnits: 2500, period: 'calendar-month-local' } };
    authored['provider_catalog'] = sample['provider_catalog'];
    authored['provider_invocation_profiles'] = { schemaVersion: 1, profiles: configuredModelProfiles(sample).map(profile => ({ ...profile, scopeId: 'source' })) };
    await writeFile(sourcePath, JSON.stringify(authored), { mode: 0o600 }); clearConfigCache();
    const sourceContext = await loadConfiguredScopeContext(f.a, 'source', f.options, 'write');
    const sourceProfile = configuredModelProfiles(sourceContext.config)[0]!;
    const binding = await new ModelBindingApplication({ read: async () => sourceContext.config['provider_catalog'] }).inspect(sourceProfile.reference);
    if (binding.status !== 'declared') throw new Error('fixture binding missing');
    await carryConfiguredModelActivation(f.a, { schemaVersion: 1, scopeId: 'source', commandId: 'source-active', action: 'activate',
      reference: sourceProfile.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding, expectedRevision: 0 }, f.options);
    // Synthetic person, inside this test's own disposable install only.
    for (const key of [...sourceContext.config.cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined); // a person's terminal: no agent or CI marker
    vi.spyOn(localPrincipal, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    const granted = await grantConfiguredModelUse(f.b, 'target', f.options);
    expect(granted.state).toBe('active');
    const leasedContext = await loadConfiguredScopeContext(f.b, 'target', f.options, 'read');
    const leased = configuredModelProfiles(leasedContext.config).find(profile => profile.scopeId === 'target')!;
    expect(leased.schemaVersion).toBe(3);
    expect((await resolveConfiguredModelUse(f.b, leased, leasedContext.principal, f.options))?.sourceProfile).toEqual(sourceProfile);
    await expect(resolveConfiguredModelUse(f.b, leased, { ...leasedContext.principal, scopeIds: ['other'] }, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    // A native chat turn runs as the person's MCP workload (turn.ts withMcpPrincipal): the attachment admits the person it acts for, the principal stays the workload.
    const workload = await withMcpPrincipal(() => loadConfiguredScopeContext(f.b, 'target', f.options, 'write'));
    expect(workload.principal.issuer).toBe(`${leasedContext.principal.issuer}/mcp`);
    expect((await withMcpPrincipal(() => resolveConfiguredModelUse(f.b, leased, workload.principal, f.options)))?.sourceProfile).toEqual(sourceProfile);
    await carryConfiguredModelActivation(f.a, { schemaVersion: 1, scopeId: 'source', commandId: 'source-inactive', action: 'deactivate',
      reference: sourceProfile.reference, expectedBinding: binding.binding, expectedRevision: 1 }, f.options);
    await expect(resolveConfiguredModelUse(f.b, leased, leasedContext.principal, f.options)).rejects.toMatchObject({ code: 'MODEL_USE_NOT_ACTIVE' });
    await carryConfiguredModelActivation(f.a, { schemaVersion: 1, scopeId: 'source', commandId: 'source-reactivate', action: 'activate',
      reference: sourceProfile.reference, catalogRevision: binding.catalogRevision, expectedBinding: binding.binding, expectedRevision: 2 }, f.options);
    await expect(resolveConfiguredModelUse(f.b, leased, { ...leasedContext.principal, issuer: 'foreign-person' }, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_PERSON_MISMATCH' });
    const sourceBytes = await readFile(sourcePath);
    expect((await applyConfiguredProviderSpendTemplate(f.b, 'target', { root: f.a, scopeId: 'source' }, f.options)).status).toBe('created');
    const account = await inspectConfiguredProviderSpendAccount(f.b, { schemaVersion: 1, scopeId: 'target', current: true }, f.options);
    expect(account.checkpoint?.account).toMatchObject({ budget: { scopeId: 'target', limitMinorUnits: 2500, revision: 1 }, reservedMinorUnits: 0, settledExactMinorUnits: '0' });
    expect((await applyConfiguredProviderSpendTemplate(f.b, 'target', { root: f.a, scopeId: 'source' }, f.options)).status).toBe('preserved');
    expect((await inspectConfiguredProviderSpendAccount(f.b, { schemaVersion: 1, scopeId: 'target', current: true }, f.options)).checkpoint).toEqual(account.checkpoint);
    await revokeConfiguredModelUse(f.b, attached.attachment.projectId, f.options);
    await expect(resolveConfiguredModelUse(f.b, leased, leasedContext.principal, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await expect(inspectConfiguredModelActivation(f.b, { schemaVersion: 1, scopeId: 'target', reference: leased.reference }, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    expect(await loadConfiguredInstallationIdentity(f.b, f.options)).toEqual(original);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    await expect(attachmentLifecycle(await loadComposedConfig(f.a, f.options), f.options).assert()).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_SOURCE_REGISTERED' });
    await expect(attachmentLifecycle(await loadComposedConfig(f.b, f.options), f.options).assert()).resolves.toBeUndefined();
    await exerciseAttachedLifecycle({ f, target, attached, original, leasedContext, sourceProfile, sourcePath, sourceBytes, installationId: context.installationId });
  });
  it('recovers a pending reservation with the same command and rejects scope, principal, drift, symlink and concurrent attachment', async () => {
    const f = await fixture(), target = await f.make(f.b, true), preview = await target.app.preview('target'), commandId = randomUUID();
    await expect(target.app.apply('target', preview.planDigest, commandId)).rejects.toThrow('injected before installer');
    expect((await target.store.registration())?.entries[0]?.state).toBe('pending');
    const recovery = await f.make(f.b);
    await expect(recovery.app.apply('other-scope', preview.planDigest, commandId)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
    const attached = await recovery.app.apply('target', preview.planDigest, commandId);
    await expect(loadConfiguredScopeContext(f.b, 'other-scope', f.options, 'write')).rejects.toBeDefined();
    const registry = await recovery.store.registration();
    const altered = { ...registry!, source: { ...registry!.source, owner: { issuer: 'other', subject: 'other' } } };
    await recovery.store.hold(() => recovery.store.write(registry, altered));
    await expect(recovery.app.preview('target')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await recovery.store.hold(() => recovery.store.write(altered, registry!));
    // Another person's attachment never lends this requester its source: the scoped context checks the requester, not the stored owner.
    const attachmentPath = productResourcePath(recovery.store.layout, 'projectAttachment'), attachmentBytes = await readFile(attachmentPath), foreign = { issuer: 'other', subject: 'other' };
    const foreignRegistry = { ...registry!, entries: registry!.entries.map(entry => ({ ...entry, attachment: { ...entry.attachment, actor: foreign } })) };
    await writeFile(attachmentPath, JSON.stringify({ ...JSON.parse(attachmentBytes.toString('utf8')) as object, actor: foreign }));
    await recovery.store.hold(() => recovery.store.write(registry, foreignRegistry));
    await expect(loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_PERSON_MISMATCH' });
    await recovery.store.hold(() => recovery.store.write(foreignRegistry, registry!)); await writeFile(attachmentPath, attachmentBytes);
    await expect(loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).resolves.toBeDefined();
    // Same person, same target membership: only the source scope membership is withdrawn, and the requester's source check refuses with no write.
    const sourcePolicy = productResourcePath((await loadComposedConfig(f.a, f.options)).productLayout, 'policy'), policyBytes = await readFile(sourcePolicy);
    await writeFile(sourcePolicy, policyBytes.toString('utf8').replaceAll('"source"', '"source-withdrawn"')); clearConfigCache();
    const targetBefore = await snapshotBytes(f.b);
    await expect(loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_UNAVAILABLE' });
    expect(await snapshotBytes(f.b)).toEqual(targetBefore);
    await writeFile(sourcePolicy, policyBytes); clearConfigCache();
    await expect(loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).resolves.toBeDefined();
    const third = join(f.root, 'C'); await mkdir(third, { mode: 0o700 });
    const next = await f.make(third), plan = await next.app.preview('third');
    const results = await Promise.allSettled([next.app.apply('third', plan.planDigest, randomUUID()), next.app.apply('third', plan.planDigest, randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const link = join(f.root, 'link'); await symlink(f.b, link);
    await expect(captureAttachmentLocation(link)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
    await expect(f.make(link)).rejects.toMatchObject({ code: 'BOOTSTRAP_STATE_UNSAFE' });
    expect((await recovery.store.registration())?.entries.find(entry => entry.attachment.projectId === attached.attachment.projectId)?.state).toBe('active');
    // A live WAL contains the newest company pin. Preview must consume it without changing any source byte or sidecar.
    const sourceConfig = await loadComposedConfig(f.a, f.options), db = openSqliteLedger(join(f.a, '.deckent/state/ledger.db'), sourceConfig.storage.sqlite, 'forbid');
    const sourceApp = await configuredProjectAttachment(third, f.options);
    try {
      db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run('foreign');
      db.prepare('INSERT INTO scope_registry(scope_id,company_id,origin) VALUES(?,?,?) ON CONFLICT(scope_id) DO UPDATE SET company_id=excluded.company_id').run('source', 'foreign', 'admission');
      const before = await snapshotBytes(f.a);
      await expect(sourceApp.preview('third')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_UNAVAILABLE' });
      expect(await snapshotBytes(f.a)).toEqual(before);
      db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run(sourceConfig.company.id);
      db.prepare('UPDATE scope_registry SET company_id=? WHERE scope_id=?').run(sourceConfig.company.id, 'source');
      const healthy = await snapshotBytes(f.a);
      await expect(sourceApp.preview('third')).resolves.toMatchObject({ scopeId: 'third' });
      expect(await snapshotBytes(f.a)).toEqual(healthy);
    } finally { db.close(); }
    for (const key of [...sourceConfig.cli.agentEnvironment, 'CI']) vi.stubEnv(key, undefined); // a person's terminal: no agent or CI marker
    const witness = vi.spyOn(localPrincipal, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    try {
      const installationId = (await loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).installationId;
      const movedTarget = join(f.root, 'B-moved'); await rename(f.b, movedTarget);
      await expect(loadConfiguredInstallationIdentity(movedTarget, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_CHANGED' });
      await relocateConfiguredProjectAttachment(movedTarget, 'target', f.options); f.b = movedTarget;
      expect((await loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).installationId).toBe(installationId);
      const sourceSet = join(f.root, 'source-before-move');
      await executeConfiguredBackup(f.a, { schemaVersion: 1, action: 'create', scopeId: 'source', set: sourceSet }, 'fixture-source-move', f.options);
      await executeConfiguredBackup(f.a, { schemaVersion: 1, action: 'restore', scopeId: 'source', set: sourceSet, target: f.a, confirmTarget: f.a }, 'fixture-source-move', f.options);
      const movedSource = join(f.root, 'A-moved'); await rename(f.a, movedSource);
      await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_UNAVAILABLE' });
      await relocateConfiguredProjectAttachment(movedSource, 'source', f.options); f.a = movedSource;
      expect((await loadConfiguredScopeContext(f.b, 'target', f.options, 'read')).installationId).toBe(installationId);
    } finally { witness.mockRestore(); vi.unstubAllEnvs(); }
    const publicApp = await configuredProjectAttachment(f.b, f.options);
    await expect(publicApp.revoke(attached.attachment.projectId)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const broken = new FileProjectAttachmentStore((await loadComposedConfig(f.b, f.options)).productLayout, f.options, 1, 100);
    await expect(broken.registration()).rejects.toBeDefined();
    await writeFile(join(f.b, '.deckent/project-attachment.json'), '{}', { mode: 0o600 });
    await expect(loadConfiguredInstallationIdentity(f.b, f.options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_INVALID' });
  });
});
