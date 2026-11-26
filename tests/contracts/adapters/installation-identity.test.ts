import { REBIND_CLASS } from '#domain/index.js';
import { mkdtemp, mkdir, cp, chmod, lstat, readFile, rename, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { FileInstallationIdentityStore, localInstallationBindingSource } from '#adapters/core/installation-files/index.js';
import { installationIdentitySchema, installationIdentityRecordSchema, installationBindingCaptureSchema } from '#domain/index.js';
import { resolveProductLayout, sha256, withConfigWriteLock, ErrorRegistry } from '#platform/index.js';
import { installationBindingNotRunReason, machineBindingNotRunReason } from '../support/binding-capability.js';
import { InstallationIdentityError, parseBeuserRealmSeal } from '#engine/index.js';
// Location evidence (root, device, inode) is bound on every posix host; only machine-digest assertions need a machine identity.
const bindingNotRun = await installationBindingNotRunReason(), machineNotRun = await machineBindingNotRunReason();

const roots: string[] = [];
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === 'win32')('rechecks the open class under the writer lock; human admission also accepts a device-only fresh capture', async () => {
  const f = await fixture(), principal = { issuer: 'fixture', subject: 'owner' };
  let captured = installationBindingCaptureSchema.parse({ schemaVersion: 2, strength: 'machine', source: 'platform', machineDigest: 'a'.repeat(64),
    canonicalRoot: f.layout.root, device: '1', inode: '10' });
  const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => captured });
  await store.loadOrCreate(); captured = installationBindingCaptureSchema.parse({ ...captured, device: '2' });
  expect(await store.inspectRebinding()).toMatchObject({ class: REBIND_CLASS.deviceOnly });
  const bytes = await readFile(f.path);
  captured = installationBindingCaptureSchema.parse({ ...captured, inode: '11' });
  await expect(store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.deviceOnly, basis: 'open-class' } }, principal))
    .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_REBIND_REQUIRED' });
  expect(await readFile(f.path)).toEqual(bytes);
  // The witnessed=true backup-restore port has only open-class authority: moved must fail at this same port.
  await expect(store.resolveRelocation({ choice: 'keep' } as never, principal)).rejects.toBeInstanceOf(InstallationIdentityError);
  captured = installationBindingCaptureSchema.parse({ ...captured, inode: '10' });
  const output = await store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } }, principal);
  expect(output).toMatchObject({ class: REBIND_CLASS.deviceOnly, basis: 'human-tty' });
  expect(Object.keys(JSON.parse(await readFile(f.path, 'utf8')).lastResolution).sort()).toEqual(['at', 'choice', 'installationId', 'previousInstallationId', 'principal', 'schemaVersion']);
  const current = JSON.parse(await readFile(f.path, 'utf8'));
  const weak = { schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: captured.canonicalRoot, device: captured.device, inode: captured.inode };
  await writeFile(f.path, JSON.stringify({ ...current, binding: weak }));
  expect(await store.inspectRebinding()).toMatchObject({ class: null }); // strengthen
  expect(await store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.deviceOnly, basis: 'open-class' } }, principal))
    .toMatchObject({ class: null, basis: 'open-class' });
  await writeFile(f.path, JSON.stringify({ schemaVersion: 1, installationId: current.installationId }));
  captured = installationBindingCaptureSchema.parse(weak);
  expect(await store.inspectRebinding()).toMatchObject({ class: null }); // bind
  expect(await store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.deviceOnly, basis: 'open-class' } }, principal))
    .toMatchObject({ class: null, basis: 'open-class' });
});
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'deckent-installation-id-')); roots.push(parent);
  const root = join(parent, 'installation'); await mkdir(root);
  return { root, parent, layout: resolveProductLayout({ projectRoot: root, platform: process.platform === 'win32' ? 'win32' : 'posix' }), directory: join(root, '.deckent/installation-identity'), path: join(root, '.deckent/installation-identity/identity.json') };
}

const verifiedFilesystem = { kind: 'linux.ext4.statfs-fsid.v1', value: '033b6aacc3f1ba86' };
const machineCapture = (canonicalRoot: string) => ({
  schemaVersion: 2, strength: 'machine', source: 'platform', machineDigest: 'a'.repeat(64),
  canonicalRoot, device: '2049', inode: '131', filesystemIdentity: verifiedFilesystem,
} as const);
const fixturePrincipal = { issuer: 'fixture', subject: 'owner' };
const keep = { choice: 'keep', admission: { class: REBIND_CLASS.deviceOnly, basis: 'open-class' } } as const;

async function retainedBindingFixture(weak = false) {
  const f = await fixture(), capture = machineCapture(f.layout.root);
  const old = weak ? { schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: capture.canonicalRoot,
    device: capture.device, inode: capture.inode } : { schemaVersion: 1, canonicalRoot: capture.canonicalRoot,
    device: capture.device, inode: capture.inode, machineDigest: capture.machineDigest };
  const installationId = '00000000-0000-4000-8000-000000000002', lastResolution = { schemaVersion: 1, choice: 'keep',
    installationId, previousInstallationId: installationId, at: '2026-11-23T10:00:00.000Z', principal: fixturePrincipal };
  const original = Buffer.from(' \n' + JSON.stringify({ schemaVersion: 2, installationId, binding: old, lastResolution }) + '\n\n');
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  await writeFile(f.path, original, { mode: 0o600 });
  let fresh = installationBindingCaptureSchema.parse(capture);
  const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => fresh });
  return { ...f, store, original, installationId, lastResolution, companion: join(f.directory, 'identity.pre-v3.json'),
    capture, observe: (patch: object) => { fresh = installationBindingCaptureSchema.parse({ ...capture, ...patch }); } };
}

it.skipIf(process.platform === 'win32').for([false, true])('retains exact bytes once when an admitted machine capture upgrades a legacy binding (weak=%s)', async weak => {
  const f = await retainedBindingFixture(weak);
  await f.store.read();
  await f.store.admitWrite();
  await f.store.loadOrCreate();
  expect(await readFile(f.path)).toEqual(f.original);
  await expect(lstat(f.companion)).rejects.toMatchObject({ code: 'ENOENT' });
  const upgrades = await Promise.all([f.store.upgradeAdmittedBinding(), f.store.upgradeAdmittedBinding()]);
  for (const upgrade of upgrades) expect(upgrade).toMatchObject({ installationId: f.installationId });
  const current = await readFile(f.path);
  expect(JSON.parse(current.toString())).toMatchObject({ installationId: f.installationId, binding: { schemaVersion: 3 }, lastResolution: f.lastResolution });
  expect(await readFile(f.companion)).toEqual(f.original);
  expect((await lstat(f.companion)).mode & 0o777).toBe(0o600);
  f.observe({ device: '2050' });
  await f.store.upgradeAdmittedBinding();
  expect(await readFile(f.path)).toEqual(current);
  expect(await readFile(f.companion)).toEqual(f.original);
});

it.skipIf(process.platform === 'win32')('refuses unsafe, foreign or stale preimages and resumes from an exact interrupted first copy', async () => {
  const f = await retainedBindingFixture();
  await symlink(f.path, f.companion);
  await expect(f.store.upgradeAdmittedBinding()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  expect(await readFile(f.path)).toEqual(f.original);
  await unlink(f.companion);
  const other = Buffer.concat([f.original, Buffer.from(' ')]);
  await writeFile(f.companion, other, { mode: 0o600 });
  await expect(f.store.upgradeAdmittedBinding()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  expect(await readFile(f.companion)).toEqual(other);
  expect(await readFile(f.path)).toEqual(f.original);
  await writeFile(f.companion, f.original);
  f.observe({ inode: '132' });
  await expect(f.store.upgradeAdmittedBinding()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
  expect(await readFile(f.path)).toEqual(f.original);
  f.observe({});
  await f.store.upgradeAdmittedBinding();
  expect(await readFile(f.companion)).toEqual(f.original);
  expect(JSON.parse(await readFile(f.path, 'utf8')).binding.schemaVersion).toBe(3);
});

it.skipIf(process.platform === 'win32')('restores only the protected same-UUID compatible preimage under the identity lock', async () => {
  const f = await retainedBindingFixture();
  await f.store.upgradeAdmittedBinding();
  const current = await readFile(f.path);
  const proof = { currentDigest: sha256(current), preimageDigest: sha256(f.original), authorize: async () => {
    expect((await lstat(f.directory + '.write-lock')).isDirectory()).toBe(true);
  }, verifyReader: async (bytes: Buffer) => {
    expect(bytes).toEqual(f.original);
    return JSON.parse(bytes.toString()).binding.schemaVersion === 1;
  } };
  for (const invalid of [{ ...proof, currentDigest: sha256(f.original) }, { ...proof, verifyReader: async () => false }]) {
    await expect(f.store.restorePreV3(invalid)).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    expect(await readFile(f.path)).toEqual(current);
    expect(await readFile(f.companion)).toEqual(f.original);
  }
  await expect(f.store.restorePreV3(proof)).resolves.toMatchObject({ installationId: f.installationId });
  expect(await readFile(f.path)).toEqual(f.original);
  expect(await readFile(f.companion)).toEqual(f.original);
  await f.store.upgradeAdmittedBinding();
  f.observe({ inode: '132' });
  const next = await f.store.resolvePlainRelocation({ choice: 'new' }, fixturePrincipal);
  expect(next).toMatchObject({ previousInstallationId: f.installationId });
  expect(next.installationId).not.toBe(f.installationId);
  const replaced = await readFile(f.path);
  await expect(f.store.restorePreV3({ ...proof, currentDigest: sha256(replaced) })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
  expect(await readFile(f.path)).toEqual(replaced);
  expect(await readFile(f.companion)).toEqual(f.original);
});

it.skipIf(process.platform === 'win32')('leaves the current identity on failed retention and settles an error after the exact replacement', async () => {
  const f = await retainedBindingFixture(), actual = await vi.importActual<typeof fs>('node:fs/promises');
  const link = vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error('injected before retention'), { code: 'EIO' }));
  await expect(f.store.upgradeAdmittedBinding()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNAVAILABLE' });
  expect(await readFile(f.path)).toEqual(f.original);
  await expect(lstat(f.companion)).rejects.toMatchObject({ code: 'ENOENT' });
  link.mockReset().mockImplementation(actual.link);
  await expect(f.store.upgradeAdmittedBinding()).resolves.toMatchObject({ installationId: f.installationId });
  // Restore the known old bytes to exercise companion reuse and a fault after the replacement itself.
  await writeFile(f.path, f.original);
  const rename = vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (to === f.path) throw Object.assign(new Error('injected after replacement'), { code: 'EIO' });
  });
  try {
    await expect(f.store.upgradeAdmittedBinding()).resolves.toMatchObject({ installationId: f.installationId });
    expect(JSON.parse(await readFile(f.path, 'utf8')).binding.schemaVersion).toBe(3);
    expect(await readFile(f.companion)).toEqual(f.original);
  } finally { rename.mockReset().mockImplementation(actual.rename); }
});

// These legacy relocation cases exercise the real machine and location probes on a filesystem without a producer.
function legacyStore(layout: ReturnType<typeof resolveProductLayout>) {
  const source = localInstallationBindingSource(layout);
  return new FileInstallationIdentityStore(layout, undefined, { capture: async () => {
    const capture = await source.capture();
    return 'status' in capture ? capture : { ...capture, filesystemIdentity: undefined };
  } });
}

it.skipIf(process.platform === 'win32')('publishes the frozen nested v3 on eligible first use and keeps one durable identity', async () => {
  const f = await fixture(), captured = machineCapture(f.layout.root);
  let device: string = captured.device;
  const source = { capture: async () => ({ ...captured, device }) };
  const first = await new FileInstallationIdentityStore(f.layout, undefined, source).loadOrCreate();
  const expected = {
    schemaVersion: 2, installationId: first.installationId,
    binding: {
      schemaVersion: 3, strength: 'machine', source: 'platform',
      machineDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      canonicalRoot: f.layout.root, device: '2049', inode: '131',
      filesystemIdentity: { kind: 'linux.ext4.statfs-fsid.v1', value: '033b6aacc3f1ba86' },
    },
    lastResolution: null,
  };
  const bytes = JSON.stringify(expected, null, 2) + '\n';
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  device = '2050';
  const reopened = new FileInstallationIdentityStore(f.layout, undefined, source);
  expect(await reopened.read()).toMatchObject({ status: 'available', value: first });
  await expect(reopened.admitWrite()).resolves.toBeUndefined();
  expect(await reopened.loadOrCreate()).toEqual(first);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
});

describe.skipIf(process.platform === 'win32')('first-publication boundary', () => {
  it('observes absence without effects, then captures the publishable binding with the writer lock held', async () => {
    const f = await fixture(), lock = f.directory + '.write-lock';
    const capture = machineCapture(f.layout.root);
    let observations = 0;
    const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => {
      observations += 1;
      await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      if (observations === 1) {
        await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
        return { ...capture, filesystemIdentity: undefined };
      }
      expect((await lstat(lock)).isDirectory()).toBe(true);
      expect((await lstat(f.layout.root)).isDirectory()).toBe(true);
      return capture;
    } });
    expect(await store.read()).toMatchObject({ status: 'unavailable', reason: 'not-created' });
    expect(observations).toBe(0);
    await store.admitWrite();
    await expect(lstat(f.layout.root)).rejects.toMatchObject({ code: 'ENOENT' });
    const identity = await store.loadOrCreate();
    expect(observations).toBe(2);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({
      schemaVersion: 2, installationId: identity.installationId, binding: { schemaVersion: 3, filesystemIdentity: verifiedFilesystem },
    });
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps one published v3 ID across concurrent first uses', async () => {
    const f = await fixture(), source = { capture: async () => machineCapture(f.layout.root) };
    const first = new FileInstallationIdentityStore(f.layout, undefined, source);
    const second = new FileInstallationIdentityStore(f.layout, undefined, source);
    const [one, two] = await Promise.all([first.loadOrCreate(), second.loadOrCreate()]);
    expect(two).toEqual(one);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ installationId: one.installationId, binding: { schemaVersion: 3 } });
  });

  it('fails closed after the directory is retained and reopens the same ID after atomic publication', async () => {
    const before = await fixture(), after = await fixture();
    const source = (root: string) => ({ capture: async () => machineCapture(root) });
    const interrupted = new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE');
    const partial = new FileInstallationIdentityStore(before.layout, 20, source(before.layout.root), {}, async () => { throw interrupted; });
    await expect(partial.loadOrCreate()).rejects.toBe(interrupted);
    expect((await lstat(before.directory)).isDirectory()).toBe(true);
    await expect(lstat(before.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new FileInstallationIdentityStore(before.layout, 20, source(before.layout.root)).loadOrCreate())
      .rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(lstat(before.path)).rejects.toMatchObject({ code: 'ENOENT' });

    // Genesis is consulted during create and again when checking the atomically committed record.
    let checks = 0;
    const committed = new FileInstallationIdentityStore(after.layout, 20, source(after.layout.root), {}, async () => {
      if (++checks === 2) throw interrupted;
      return undefined;
    });
    await expect(committed.loadOrCreate()).rejects.toBe(interrupted);
    const bytes = await readFile(after.path, 'utf8'), record = JSON.parse(bytes);
    expect(record.binding).toMatchObject({ schemaVersion: 3 });
    expect(await new FileInstallationIdentityStore(after.layout, 20, source(after.layout.root)).loadOrCreate())
      .toEqual({ schemaVersion: 1, installationId: record.installationId });
    expect(await readFile(after.path, 'utf8')).toBe(bytes);
  });

  it('keeps weak and producer-less machine records in the legacy shapes', async () => {
    const weak = await fixture(), machine = await fixture();
    const location = (canonicalRoot: string) => ({ canonicalRoot, device: '2049', inode: '131' });
    const weakBinding = { schemaVersion: 2, strength: 'weak', source: 'location', ...location(weak.layout.root) } as const;
    const weakId = await new FileInstallationIdentityStore(weak.layout, undefined, {
      capture: async () => ({ ...weakBinding, filesystemIdentity: verifiedFilesystem }),
    }).loadOrCreate();
    expect(await readFile(weak.path, 'utf8')).toBe(JSON.stringify({
      schemaVersion: 2, installationId: weakId.installationId, binding: weakBinding, lastResolution: null,
    }, null, 2) + '\n');
    const capture = { ...machineCapture(machine.layout.root), filesystemIdentity: undefined };
    const machineId = await new FileInstallationIdentityStore(machine.layout, undefined, { capture: async () => capture }).loadOrCreate();
    expect(await readFile(machine.path, 'utf8')).toBe(JSON.stringify({
      schemaVersion: 2, installationId: machineId.installationId,
      binding: { schemaVersion: 1, machineDigest: 'a'.repeat(64), ...location(machine.layout.root) }, lastResolution: null,
    }, null, 2) + '\n');
  });

  it('strengthens and resolves retained records with the legacy bytes and ID semantics', async () => {
    const f = await fixture();
    const machine = machineCapture(f.layout.root);
    const { canonicalRoot, inode, machineDigest } = machine;
    const installationId = '00000000-0000-4000-8000-000000000002';
    const prior = {
      schemaVersion: 1, choice: 'keep', previousInstallationId: installationId, installationId,
      at: '2026-11-12T00:00:00.000Z', principal: fixturePrincipal,
    };
    const weak = {
      schemaVersion: 2, installationId,
      binding: { schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot, device: machine.device, inode },
      lastResolution: prior,
    };
    await mkdir(f.directory, { recursive: true, mode: 0o700 });
    await writeFile(f.path, JSON.stringify(weak), { mode: 0o600 });
    let device: string = machine.device;
    const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => ({ ...machine, filesystemIdentity: undefined, device }) });
    const legacy = () => ({ schemaVersion: 1, machineDigest, canonicalRoot, device, inode });
    expect(await store.loadOrCreate()).toEqual({ schemaVersion: 1, installationId });
    expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify({ ...weak, binding: legacy() }, null, 2) + '\n');
    device = '2050';
    const kept = await store.resolveRelocation(keep, fixturePrincipal);
    expect(kept).toMatchObject({ choice: 'keep', previousInstallationId: installationId, installationId, class: REBIND_CLASS.deviceOnly });
    expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify({
      ...weak, binding: legacy(), lastResolution: { ...prior, at: kept.at },
    }, null, 2) + '\n');
    device = '2051';
    const replaced = await store.resolveRelocation({ choice: 'new' }, fixturePrincipal);
    expect(replaced.previousInstallationId).toBe(installationId);
    expect(replaced.installationId).not.toBe(installationId);
    expect(await readFile(f.path, 'utf8')).toBe(JSON.stringify({
      ...weak, installationId: replaced.installationId, binding: legacy(),
      lastResolution: { ...prior, choice: 'new', installationId: replaced.installationId, at: replaced.at },
    }, null, 2) + '\n');
    expect(await store.loadOrCreate()).toEqual({ schemaVersion: 1, installationId: replaced.installationId });
  });

  it('refuses invalid configured or required-machine captures before retaining an identity directory', async () => {
    const invalid = await fixture(), required = await fixture();
    const configured = join(invalid.parent, 'configured-machine');
    await writeFile(configured, 'invalid\n');
    const invalidStore = new FileInstallationIdentityStore(invalid.layout, undefined, undefined, { machineIdentity: { source: configured } });
    const requiredStore = new FileInstallationIdentityStore(required.layout, undefined, { capture: async () => ({
      schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: required.layout.root,
      device: '2049', inode: '131', filesystemIdentity: verifiedFilesystem,
    }) }, { requireMachineBinding: true });
    for (const [f, store, code] of [
      [invalid, invalidStore, 'INSTALLATION_IDENTITY_SOURCE_INVALID'],
      [required, requiredStore, 'INSTALLATION_IDENTITY_MACHINE_BINDING_REQUIRED'],
    ] as const) {
      await expect(store.admitWrite()).rejects.toMatchObject({ code });
      await expect(lstat(f.layout.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(store.loadOrCreate()).rejects.toMatchObject({ code });
      await expect(lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(f.directory + '.write-lock')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.read()).toMatchObject({ status: 'unavailable', reason: 'not-created' });
    }
  });

  it('preserves the sealed envelope and checks its trusted realm with nested v3', async () => {
    const f = await fixture();
    const seal = parseBeuserRealmSeal({ schemaVersion: 1, fixture: 'realm-sealed', realmId: 'fixture-realm',
      nonce: '12345678-1234-4234-8234-123456789abc', bindingDigest: 'b'.repeat(64) });
    const source = { capture: async () => ({ ...machineCapture(f.layout.root), source: 'configured' as const }) };
    const store = new FileInstallationIdentityStore(f.layout, undefined, source, {}, async () => seal);
    const identity = await store.loadOrCreate(), bytes = await readFile(f.path, 'utf8');
    expect(identity.realmSeal).toEqual(seal);
    expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 3, installationId: identity.installationId, realmSeal: seal,
      binding: { schemaVersion: 3, strength: 'machine', source: 'configured', filesystemIdentity: verifiedFilesystem }, lastResolution: null });
    expect(await store.loadOrCreate()).toEqual(identity);
    const otherRealm = new FileInstallationIdentityStore(f.layout, undefined, source, {}, async () => ({ ...seal, realmId: 'other' }));
    await expect(otherRealm.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(otherRealm.admitWrite()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(otherRealm.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
});

describe('durable installation identity', () => {
  beforeEach(context => { if (process.platform !== 'linux') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: Linux machine binding is unavailable; typed refusal has a separate active test'); else if (bindingNotRun) context.skip(bindingNotRun); });
  it('automatically persists a typed identity and reopens the same bytes', async () => {
    const f = await fixture(); const first = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    expect(installationIdentitySchema.parse(first)).toEqual(first);
    const before = await readFile(f.path, 'utf8');
    expect(installationIdentityRecordSchema.parse(JSON.parse(before))).toMatchObject({ schemaVersion: 2, installationId: first.installationId, binding: { canonicalRoot: f.layout.root } });
    expect(await new FileInstallationIdentityStore(f.layout).loadOrCreate()).toEqual(first);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });
  it('reads an established identity without acquiring the initialization lock', async () => {
    const f = await fixture(); const first = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    await withConfigWriteLock(f.directory, async () => {
      expect(await new FileInstallationIdentityStore(f.layout, 20).loadOrCreate()).toEqual(first);
    });
  });
  it('requires explicit keep after a move; different roots receive distinct random identities', async () => {
    const f = await fixture(); const first = await legacyStore(f.layout).loadOrCreate();
    const moved = join(f.parent, 'moved'); await rename(f.root, moved);
    const relocated = new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: moved }));
    await expect(relocated.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await relocated.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } }, { issuer: 'host', subject: '1000' })).toMatchObject({ previousInstallationId: first.installationId, installationId: first.installationId });
    expect(await relocated.loadOrCreate()).toEqual(first);
    await mkdir(f.root);
    expect((await new FileInstallationIdentityStore(f.layout).loadOrCreate()).installationId).not.toBe(first.installationId);
  });
  it.each(['{', '{}', '{"schemaVersion":1}', '{"schemaVersion":2,"installationId":"bad"}', '{"schemaVersion":1,"installationId":"path/to/installation"}'])(
    'refuses corrupt or incomplete retained records without repair: %s', async content => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    await writeFile(f.path, content);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(content);
  });
  it('refuses a lost record and an interrupted first publication instead of generating a new identity', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    await unlink(f.path);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await fixture(); await mkdir(other.directory, { recursive: true, mode: 0o700 });
    await expect(new FileInstallationIdentityStore(other.layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  });
  // B5 (owner terminal test 2026-10-07): inside a Deckent sandbox the identity directory is an empty tmpfs mount and reads as MASKED (proof:
  // the real CLI under the sandbox's own bubblewrap view, L6 review). A real loss stays INVALID — on a disk and on a tmpfs alike, because the
  // directory is not its own mount there.
  it('keeps a lost record INVALID when its directory is not a mount of its own, on a disk and on a tmpfs', async () => {
    const f = await fixture(); await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    await unlink(f.path);
    await expect(new FileInstallationIdentityStore(f.layout, 20).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    let shm: string;
    try { shm = await mkdtemp('/dev/shm/deckent-installation-id-'); } catch { return; }
    roots.push(shm);
    const layout = resolveProductLayout({ projectRoot: shm, platform: 'posix' });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    await unlink(join(shm, '.deckent/installation-identity/identity.json'));
    await expect(new FileInstallationIdentityStore(layout, 20).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  });
  it('does not follow a substituted identity record', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const outside = join(f.parent, 'outside'); await rename(f.path, outside); await symlink(outside, f.path);
    const before = await readFile(outside, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(outside, 'utf8')).toBe(before);
    await unlink(f.path); await rename(outside, f.path); await chmod(f.path, 0o644);
    await expect(store.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });
  it('refuses a restored copy until explicitly accepted as a new installation', async () => {
    const f = await fixture(), restored = await fixture(), fresh = await fixture();
    const original = await legacyStore(f.layout).loadOrCreate();
    await cp(f.layout.root, restored.layout.root, { recursive: true });
    const store = new FileInstallationIdentityStore(restored.layout);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    const result = await store.resolveRelocation({ choice: 'new' }, { issuer: 'host', subject: '1000' });
    expect(result.previousInstallationId).toBe(original.installationId);
    expect(result.installationId).not.toBe(original.installationId);
    expect((await store.loadOrCreate()).installationId).toBe(result.installationId);
    expect(JSON.parse(await readFile(restored.path, 'utf8')).lastResolution).toEqual(result);
    expect(await new FileInstallationIdentityStore(f.layout).loadOrCreate()).toEqual(original);
    expect((await new FileInstallationIdentityStore(fresh.layout).loadOrCreate()).installationId).not.toBe(original.installationId);
  });

  it('detects a changed machine binding and refuses implicit or repeated choices', async context => {
    if (machineNotRun) context.skip(machineNotRun);
    const f = await fixture(), original = await legacyStore(f.layout).loadOrCreate();
    const before = await readFile(f.path, 'utf8'), binding = JSON.parse(before).binding;
    // Persisted in the v1 shape; the injected source returns a current (v2) capture at the same location.
    const location = { canonicalRoot: binding.canonicalRoot, device: binding.device, inode: binding.inode };
    const source = { capture: async () => ({ ...location, schemaVersion: 2 as const, strength: 'machine' as const, source: 'platform' as const, machineDigest: 'a'.repeat(64) }) };
    const store = new FileInstallationIdentityStore(f.layout, undefined, source);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    await expect(store.resolveRelocation(undefined as never, { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    const results = await Promise.allSettled(['keep', 'new'].map(choice => store.resolveRelocation(choice === 'keep' ? { choice, admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } } : { choice: 'new' }, { issuer: 'h', subject: '1' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' } });
    const accepted = await store.loadOrCreate();
    await expect(store.resolveRelocation({ choice: 'new' }, { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    expect(await store.loadOrCreate()).toEqual(accepted);
    expect(JSON.parse(await readFile(f.path, 'utf8')).lastResolution.previousInstallationId).toBe(original.installationId);
  });
  it('detects restoration at the same canonical path with a replaced directory inode', async () => {
    const f = await fixture(), original = await legacyStore(f.layout).loadOrCreate();
    const retained = join(f.parent, 'retained'); await rename(f.layout.root, retained);
    await cp(retained, f.layout.root, { recursive: true });
    const store = new FileInstallationIdentityStore(f.layout);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect((await store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } }, { issuer: 'h', subject: '1' })).installationId).toBe(original.installationId);
    expect(await store.loadOrCreate()).toEqual(original);
  });
  it('requires explicit consent to bind a legacy v1 identity on a machine-capable host', async context => {
    if (machineNotRun) context.skip(machineNotRun);
    const f = await fixture(), store = new FileInstallationIdentityStore(f.layout), original = await store.loadOrCreate();
    await writeFile(f.path, JSON.stringify(original)); const bytes = await readFile(f.path, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    await store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } }, { issuer: 'h', subject: '1' });
    expect(await store.loadOrCreate()).toEqual(original);
  });
  it.each([null, {}, { schemaVersion: 1, machineDigest: 'raw-host-id' }])('refuses corrupt binding metadata without repairing it: %j', async binding => {
    const f = await fixture(), store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const record = JSON.parse(await readFile(f.path, 'utf8')); await writeFile(f.path, JSON.stringify({ ...record, binding }));
    const bytes = await readFile(f.path, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(store.resolveRelocation({ choice: 'keep', admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } }, { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
  it('refuses unsafe storage without changing or replacing the identity', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const bytes = await readFile(f.path, 'utf8'); await chmod(f.directory, 0o777);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNAVAILABLE' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
  it('bounds contention with a typed error and leaves the record uncreated', async () => {
    const f = await fixture();
    await withConfigWriteLock(f.directory, async () => {
      await expect(new FileInstallationIdentityStore(f.layout, 20).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_LOCKED' });
      await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect((await new FileInstallationIdentityStore(f.layout).loadOrCreate()).installationId).toBeTruthy();
  });
});

it('refuses unsupported layout capability before reading or creating identity metadata', async () => {
  const f = await fixture();
  const layout = { ...f.layout, platform: 'win32' as const };
  await expect(new FileInstallationIdentityStore(layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  if (process.platform === 'win32') {
    await expect(new FileInstallationIdentityStore(f.layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  }
});

it.skipIf(process.platform === 'win32')('observes absence without creating ancestors or locks, and validates retained loss on reads', async () => {
  const f = await fixture(), store = new FileInstallationIdentityStore(f.layout);
  expect(await store.read()).toEqual({ status: 'unavailable', reason: 'not-created', bindingCapability: 'not-observed' });
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(f.layout.root)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  await expect(store.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  await expect(lstat(f.directory + '.write-lock')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('reports unsupported binding capability without blocking identity reads or writes, preserving bound bytes', async () => {
  const f = await fixture(), unsupported = { capture: async () => ({ status: 'unsupported' as const }) };
  const store = new FileInstallationIdentityStore(f.layout, undefined, unsupported);
  const identity = await store.loadOrCreate();
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
  const bytes = await readFile(f.path, 'utf8');
  expect(JSON.parse(bytes)).toEqual(identity); // v1 is explicitly unbound; no made-up machine discriminator.
  expect(await store.loadOrCreate()).toEqual(identity);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  await expect(store.resolveRelocation({ choice: 'new' }, { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  await writeFile(f.path, '{}');
  await expect(store.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
});

it.skipIf(process.platform !== 'linux' || machineNotRun !== null)('[requires machine binding capability] skips only the unsupported comparison and resumes relocation enforcement when capability returns', async () => {
  const f = await fixture(), original = legacyStore(f.layout), identity = await original.loadOrCreate();
  const bytes = await readFile(f.path, 'utf8');
  const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => ({ status: 'unsupported' }) });
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  const record = JSON.parse(bytes); record.binding.machineDigest = 'b'.repeat(64); await writeFile(f.path, JSON.stringify(record));
  await expect(original.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
});

it.skipIf(process.platform === 'win32')('reads a retained v3 through device renumber and refuses relocation and both rebinding choices without writing', async () => {
    expect(ErrorRegistry.createError('INSTALLATION_IDENTITY_NEWER_BINDING', { locale: 'en' }).message).toBe("This installation's identity record was written by a newer deckent. Use that version or restore the older record from backup.");
    expect(ErrorRegistry.createError('INSTALLATION_IDENTITY_NEWER_BINDING', { locale: 'tr' }).message).toBe('Bu kurulumun kimlik kaydı daha yeni bir deckent sürümüyle yazıldı. O sürümü kullanın veya eski kaydı yedekten geri yükleyin.');
    const f = await fixture(), original = machineCapture(f.layout.root);
    let captured = installationBindingCaptureSchema.parse({ ...original, device: '9999' });
    const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => captured });
    const first = { schemaVersion: 1, installationId: '00000000-0000-4000-8000-000000000002' };
    const before = JSON.stringify({ schemaVersion: 2, installationId: first.installationId,
      binding: { ...original, schemaVersion: 3 }, lastResolution: null }, null, 2) + '\n';
    await mkdir(f.directory, { recursive: true, mode: 0o700 });
    await writeFile(f.path, before, { mode: 0o600 });
    await withConfigWriteLock(f.directory, async () => {
      expect(await store.read()).toMatchObject({ status: 'available', value: first });
      expect(await store.read()).not.toHaveProperty('pendingWrite');
      await expect(store.admitWrite()).resolves.toBeUndefined();
      expect(await store.loadOrCreate()).toEqual(first);
      for (const choice of ['keep', 'new'] as const) {
        await expect(store.resolveRelocation(choice === 'keep' ? { choice, admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } } : { choice }, { issuer: 'host', subject: '1000' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_NEWER_BINDING' });
      }
    });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    for (const drift of [
      { filesystemIdentity: { ...verifiedFilesystem, value: '133b6aacc3f1ba86' } },
      { filesystemIdentity: { ...verifiedFilesystem, kind: 'fixture.other-filesystem' } },
      { canonicalRoot: f.parent }, { inode: '132' }, { machineDigest: 'b'.repeat(64) }, { filesystemIdentity: undefined },
    ]) {
      captured = installationBindingCaptureSchema.parse({ ...original, ...drift });
      for (const read of [() => store.read(), () => store.admitWrite(), () => store.loadOrCreate()]) {
        await expect(read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
      }
      expect(await readFile(f.path, 'utf8')).toBe(before);
    }
    for (const choice of ['keep', 'new'] as const) {
      await expect(store.resolveRelocation(choice === 'keep' ? { choice, admission: { class: REBIND_CLASS.moved, basis: 'human-tty' } } : { choice }, { issuer: 'host', subject: '1000' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_NEWER_BINDING' });
    }
    const unsupported = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => ({ status: 'unsupported' }) });
    await expect(unsupported.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });
