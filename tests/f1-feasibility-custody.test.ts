import type { Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installationBindingCaptureV2Projection, REBIND_CLASS } from '#domain/index.js';
import { assessInstallationBinding, classifyInstallationRebinding, OAuthConnectionApplication, type OAuthConnectionPorts } from '#engine/index.js';
import { productResourcePath, resolveProductLayout, serializeJsonDocument } from '#platform/index.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { assessFilesystemIdentity } from '#adapters/core/installation-files/internal/filesystem-identity.js';
import { archiveState, unpackState } from '#adapters/core/backup-store/internal/archive.js';
import { SIWC_PROTOCOL } from '#adapters/core/provider-siwc/index.js';
import { custodyDigest, observePersonalStoreHost } from '#adapters/core/secret-store/internal/personal-host.js';
import { personalStoreAssertion, rememberPersonalStoreInstance } from '#adapters/core/secret-store/index.js';

const kernel = vi.hoisted(() => ({
  host: undefined as undefined | { parent: string; mounts: string; disk: string; device: number; ownerChangeAt?: string; failMountRead?: boolean },
  bindingReads: 0,
}));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  hostname: () => 'f1-host-fixture',
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const storeFiles = ['secrets.key', 'secrets.sealed.json'];
  const storeMember = (path: string) => storeFiles.includes(basename(path));
  const projected = (path: string, stats: Stats) => {
    const host = kernel.host;
    if (!host) return stats;
    // Model trusted system ancestors beyond the disposable hierarchy. The sandbox
    // maps their ownership to nobody and the real /tmp is intentionally shared.
    if (path === '/' || path === '/tmp') return Object.assign(stats, { uid: 0, mode: stats.mode & ~0o022 });
    if (!path.startsWith(host.parent + '/') || !(stats.isDirectory() || storeMember(path))) return stats;
    return Object.assign(stats, { dev: host.device, ...(path === host.ownerChangeAt ? { uid: stats.uid + 1 } : {}) });
  };
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stats = await fs.lstat(...args);
      if (stats && typeof args[0] === 'string' && typeof stats.dev === 'number') return projected(args[0], stats as Stats);
      return stats;
    },
    statfs: async (path: string) => {
      if (kernel.host && path.startsWith(kernel.host.parent + '/')) return { type: 0xef53 };
      return fs.statfs(path);
    },
    realpath: async (path: string) => {
      if (path.startsWith('/sys/dev/block/')) {
        if (!kernel.host) throw new Error('A synthetic sysfs fixture is required');
        return fs.realpath(kernel.host.disk);
      }
      return fs.realpath(path);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = args[0];
      if (path === '/proc/self/mountinfo') {
        if (!kernel.host || kernel.host.failMountRead) throw new Error('Synthetic mountinfo unavailable');
        return fs.open(kernel.host.mounts, args[1], args[2]);
      }
      const handle = await fs.open(...args);
      if (!kernel.host || typeof path !== 'string' || !path.startsWith(kernel.host.parent + '/')) return handle;
      if (storeMember(path)) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async () => projected(path, await stat())) as typeof handle.stat;
        const rejectBytes = () => { throw new Error('Key and envelope bytes must not be read'); };
        handle.read = rejectBytes;
        handle.readFile = rejectBytes;
      } else if (basename(path) === 'personal-store-binding.v1.json') {
        const read = handle.read.bind(handle);
        handle.read = ((...readArgs: Parameters<typeof handle.read>) => {
          kernel.bindingReads++;
          return read(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    },
  };
});

const INSTALLATION_ID = 'a1000000-0000-4000-8000-000000000001';
const CONNECTION_ID = 'a1000000-0000-4000-8000-000000000002';
const FILESYSTEM_ID = '1032547698badcfe';
const ORIGINAL_DEVICE = 2049;
const RENUMBERED_DEVICE = 2050;
const BINDING = 'personal-store-binding.v1.json';
const MEMBERS = ['secrets.key', 'secrets.sealed.json', BINDING] as const;
const installationError = { code: 'INSTALLATION_IDENTITY_RELOCATED' };
const personalError = { code: 'SIWC_STORE_NOT_PERSONAL', reason: 'binding-changed' };
const owner = {
  installationId: INSTALLATION_ID, companyId: 'f1-company', scopeId: 'f1-scope',
  principal: { issuer: 'f1-host-fixture', subject: String(userInfo().uid) },
};

afterEach(() => { kernel.host = undefined; kernel.bindingReads = 0; });

async function fixtureHost() {
  const host = await mkdtemp(join(tmpdir(), 'f1-custody-'));
  const parent = join(host, 'workspace');
  const disk = join(host, 'devices/ata-fixture/block/fixture-disk');
  const mounts = join(host, 'mountinfo');
  await mkdir(parent, { mode: 0o700 });
  await mkdir(join(disk, 'slaves'), { recursive: true });
  await mkdir(join(disk, 'device'));
  await symlink('/fixture/bus/scsi', join(disk, 'device/subsystem'));
  kernel.host = { parent, disk, mounts, device: ORIGINAL_DEVICE };
  const mount = async (device: number, minor: number) => {
    kernel.host!.device = device;
    await writeFile(mounts, `41 40 8:${minor} / ${parent} rw - ext4 /dev/fixture rw\n`);
  };
  await mount(ORIGINAL_DEVICE, 1);
  return { parent, mounts, renumber: () => mount(RENUMBERED_DEVICE, 2) };
}

function install(root: string, mounts: string) {
  const layout = resolveProductLayout({ projectRoot: root });
  const path = join(productResourcePath(layout, 'installationIdentity'), 'identity.json');
  const capture = async (fsid = FILESYSTEM_ID) => {
    const info = await lstat(root);
    const canonicalRoot = root, device = String(info.dev), inode = String(info.ino);
    const observation = assessFilesystemIdentity(canonicalRoot, device, inode, await readFile(mounts, 'utf8'),
      { type: 0xef53, fsid, device, inode });
    return { schemaVersion: 2 as const, strength: 'machine' as const, source: 'platform' as const,
      machineDigest: 'a'.repeat(64), canonicalRoot, device, inode,
      ...(observation.status === 'available' ? { filesystemIdentity: observation.identity } : {}) };
  };
  const store = new FileInstallationIdentityStore(layout, undefined, { capture: () => capture() }, {}, async () => undefined);
  return { layout, root, path, capture, store };
}

function personal(root: string, installationDigest: () => Promise<string>, vault = false) {
  const get = vi.fn(async (_name: string): Promise<string | undefined> => undefined);
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential, browser or provider effect'); };
  const store = rememberPersonalStoreInstance({
    descriptor: { id: SIWC_PROTOCOL.encryptedStoreId, writable: true, enumerable: true, encryptedAtRest: true },
    get, set: unexpected, delete: unexpected, inspect: unexpected, listNames: async () => [],
  }, { root, platform: 'linux', env: {}, ...(vault ? { vault: { key: 'fixture-vault', installationId: INSTALLATION_ID, projectId: 'f1-project' } } : {}) });
  const witness = vi.fn(async () => true);
  const assertPersonal = personalStoreAssertion(root, {
    snapshot: async () => ({
      owner, actor: { id: 'verified-owner', ...owner.principal, assurance: 'os-user', scopeIds: [owner.scopeId] },
      profile: { id: 'core:solo', version: 1, digest: 'b'.repeat(64) }, locationDigest: await installationDigest(),
    }),
    witness, reconnect: true,
  }, async () => ({ store: store.descriptor.id, digest: null }));
  const proof = () => assertPersonal(store.descriptor, owner);
  const ports: OAuthConnectionPorts = {
    owner, protocol: SIWC_PROTOCOL, store, now: Date.now,
    custody: { assertPersonal, selected: async () => store.descriptor.id, exclusive: work => work() },
    connectionLock: (_id, work) => work(),
    authorize: async () => ({ effect: 'allow', policyRevision: 'f1-policy', ruleId: 'f1-rule' }),
    audit: unexpected, browser: unexpected, exchange: unexpected, verifyIdentity: unexpected, revoke: unexpected,
    unusableRefresh: () => false,
  };
  const inspect = (requestOwner = owner) => new OAuthConnectionApplication({ ...ports, owner: requestOwner }).inspect(CONNECTION_ID);
  const lease = () => new OAuthConnectionApplication(ports).lease(CONNECTION_ID, owner);
  return { get, witness, proof, inspect, lease, path: join(root, BINDING) };
}

async function seed() {
  const host = await fixtureHost();
  const root = join(host.parent, 'personal'), installation = join(host.parent, 'installation');
  await mkdir(root, { mode: 0o700 });
  await mkdir(installation, { mode: 0o700 });
  await writeFile(join(root, 'secrets.key'), Buffer.alloc(32, 42), { mode: 0o600 });
  await writeFile(join(root, 'secrets.sealed.json'), 'synthetic envelope placeholder', { mode: 0o600 });
  const original = install(installation, host.mounts);
  const legacyCapture = await original.capture();
  expect(legacyCapture.filesystemIdentity).toEqual({ kind: 'linux.ext4.statfs-fsid.v1', value: FILESYSTEM_ID });
  await mkdir(dirname(original.path), { recursive: true, mode: 0o700 });
  const identityBytes = serializeJsonDocument({ schemaVersion: 2, installationId: INSTALLATION_ID,
    binding: { ...legacyCapture, schemaVersion: 3 }, lastResolution: null });
  await writeFile(original.path, identityBytes, { mode: 0o600 });
  const digestAt = (i: typeof original) => async () => custodyDigest(installationBindingCaptureV2Projection(await i.capture()));
  const instance = personal(root, digestAt(original));
  const evidence = await instance.proof();
  const bindingBytes = await readFile(instance.path, 'utf8');
  instance.witness.mockClear();
  kernel.bindingReads = 0;
  return { host, root, original, legacyCapture, identityBytes, instance, evidence, digestAt, bindingBytes };
}

it('device-only change matches installation v3 and refuses personal custody before value access', async () => {
  const f = await seed();
  const prior = await f.original.capture();
  await f.host.renumber();
  const fresh = await f.original.capture();
  expect(fresh).toEqual({ ...prior, device: '2050' });
  await expect(f.original.store.read()).resolves.toMatchObject({ status: 'available', value: { installationId: INSTALLATION_ID } });
  expect(await readFile(f.original.path, 'utf8')).toBe(f.identityBytes);
  const { filesystemIdentity: _fsid, ...legacy } = prior;
  expect(assessInstallationBinding(legacy, fresh)).toBe('relocated');
  expect(classifyInstallationRebinding(legacy, fresh)).toBe(REBIND_CLASS.deviceOnly);
  const live = await observePersonalStoreHost(f.root, userInfo().uid);
  expect(live.locationDigest).not.toBe(f.evidence.host.locationDigest);
  expect(live.keyIdentityDigest).not.toBe(f.evidence.host.keyIdentityDigest);
  expect(live.mountEvidenceDigest).not.toBe(f.evidence.host.mountEvidenceDigest);
  expect(await f.digestAt(f.original)()).not.toBe(JSON.parse(f.bindingBytes).installationLocationDigest);
  await expect(f.instance.lease()).rejects.toMatchObject(personalError);
  expect(f.instance.get).not.toHaveBeenCalled();
  expect(f.instance.witness).not.toHaveBeenCalled();
  expect(await readFile(f.instance.path, 'utf8')).toBe(f.bindingBytes);
});

it('copied personal store has new root/key identity even on the same mount', async () => {
  const f = await seed();
  const root = join(f.host.parent, 'copied-store');
  await mkdir(root, { mode: 0o700 });
  for (const file of MEMBERS) await copyFile(join(f.root, file), join(root, file));
  expect(await lstat(root)).not.toHaveProperty('ino', (await lstat(f.root)).ino);
  const live = await observePersonalStoreHost(root, userInfo().uid);
  expect(live.mountEvidenceDigest).toBe(f.evidence.host.mountEvidenceDigest);
  expect(live.locationDigest).not.toBe(f.evidence.host.locationDigest);
  expect(live.keyIdentityDigest).not.toBe(f.evidence.host.keyIdentityDigest);
  const copy = personal(root, f.digestAt(f.original));
  await expect(copy.inspect()).rejects.toMatchObject(personalError);
  expect(copy.get).not.toHaveBeenCalled();
});

it('copied installation fails the installation gate and separately changes the personal installation digest', async () => {
  const f = await seed();
  const root = join(f.host.parent, 'copied-installation');
  await mkdir(root, { mode: 0o700 });
  const copy = install(root, f.host.mounts);
  await mkdir(dirname(copy.path), { recursive: true, mode: 0o700 });
  await copyFile(f.original.path, copy.path);
  const current = await copy.capture();
  expect(current).toMatchObject({ filesystemIdentity: f.legacyCapture.filesystemIdentity, device: f.legacyCapture.device, machineDigest: f.legacyCapture.machineDigest });
  expect(current.canonicalRoot).not.toBe(f.legacyCapture.canonicalRoot);
  expect(current.inode).not.toBe(f.legacyCapture.inode);
  await expect(copy.store.read()).rejects.toMatchObject(installationError);
  // Isolate the personal comparator by supplying the same installation ID with a new installation location.
  const personalAfterCopy = personal(f.root, f.digestAt(copy));
  await expect(personalAfterCopy.inspect()).rejects.toMatchObject(personalError);
  expect(personalAfterCopy.get).not.toHaveBeenCalled();
  await expect(f.original.store.read()).resolves.toMatchObject({ status: 'available' });
});

it('changed verified requester and changed filesystem owner refuse before binding or value reads', async () => {
  const f = await seed();
  await expect(f.instance.inspect({ ...owner, principal: { ...owner.principal, subject: 'different-person' } }))
    .rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'non-person-owner' });
  kernel.host!.ownerChangeAt = f.root;
  await expect(f.instance.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'unsafe-root' });
  expect(kernel.bindingReads).toBe(0);
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('changed key file reference on a fixed root and mount refuses before value access', async () => {
  const f = await seed();
  const key = join(f.root, 'secrets.key');
  const before = await lstat(key);
  await rename(key, join(f.root, 'previous-key-fixture'));
  await writeFile(key, Buffer.alloc(32, 42), { mode: 0o600 });
  expect((await lstat(key)).ino).not.toBe(before.ino);
  const live = await observePersonalStoreHost(f.root, userInfo().uid);
  expect(live).toMatchObject({ locationDigest: f.evidence.host.locationDigest, mountEvidenceDigest: f.evidence.host.mountEvidenceDigest });
  expect(live.keyIdentityDigest).not.toBe(f.evidence.host.keyIdentityDigest);
  await expect(f.instance.inspect()).rejects.toMatchObject(personalError);
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('changed custody generation passes host proof and is refused only after the token-free stored value is read', async () => {
  const f = await seed();
  const binding = JSON.parse(f.bindingBytes);
  f.instance.get.mockResolvedValue(JSON.stringify({ schemaVersion: 2, connectionId: CONNECTION_ID, owner,
    clientId: 'f1-client', identity: null, generation: 0, planUseEnabled: false, state: 'registration',
    remoteRevocation: 'not-attempted', tokens: null, custody: { bindingId: binding.bindingId, generation: 1 } }));
  await expect(f.instance.inspect()).resolves.toMatchObject({ state: 'registration' });
  f.instance.get.mockClear();
  await writeFile(f.instance.path, serializeJsonDocument({ ...binding, generation: 2 }), { mode: 0o600 });
  await expect(f.instance.proof()).resolves.toMatchObject({ host: f.evidence.host, store: { generation: 2 } });
  expect(f.instance.get).not.toHaveBeenCalled();
  await expect(f.instance.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL' });
  expect(f.instance.get).toHaveBeenCalledTimes(1);
});

it('unavailable mount evidence returns a typed refusal before binding or value reads', async () => {
  const f = await seed();
  await writeFile(f.host.mounts, ''); // The bounded mount lookup returns no row.
  await expect(f.instance.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'unknown-locality' });
  kernel.host!.failMountRead = true;
  await expect(f.instance.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'unknown-locality' });
  expect(kernel.bindingReads).toBe(0);
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('fresh mount evidence can change without a persisted mount comparison', async () => {
  const f = await seed();
  const row = await readFile(f.host.mounts, 'utf8');
  await writeFile(f.host.mounts, row.replace(/^41 /u, '42 '));
  const fresh = await f.instance.proof();
  expect(fresh.host.mountEvidenceDigest).not.toBe(f.evidence.host.mountEvidenceDigest);
  expect(fresh.host.locationDigest).toBe(f.evidence.host.locationDigest);
  expect(fresh.host.keyIdentityDigest).toBe(f.evidence.host.keyIdentityDigest);
  expect(await readFile(f.instance.path, 'utf8')).toBe(f.bindingBytes);
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('strict v1 rejects unfamiliar versions and fields before value access', async () => {
  const f = await seed();
  const binding = JSON.parse(f.bindingBytes);
  // Illustrative unknown records, not a proposed future shape.
  for (const change of [{ schemaVersion: 2 }, { filesystemIdentity: FILESYSTEM_ID }]) {
    const bytes = serializeJsonDocument({ ...binding, ...change });
    await writeFile(f.instance.path, bytes, { mode: 0o600 });
    await expect(f.instance.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'cleanup-pending' });
    expect(await readFile(f.instance.path, 'utf8')).toBe(bytes);
  }
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('installation v3 refuses an unavailable or different filesystem identity on unchanged path, inode and machine', async () => {
  const f = await seed();
  for (const fsid of ['0000000000000000', '1122334455667788']) {
    const store = new FileInstallationIdentityStore(f.original.layout, undefined, { capture: () => f.original.capture(fsid) }, {}, async () => undefined);
    await expect(store.read()).rejects.toMatchObject(installationError);
  }
});

it('backup archive keeps installation identity and excludes the personal pair/binding, which a file-level restore replaces', async () => {
  const f = await seed();
  for (const resource of ['config', 'policy', 'bindings'] as const) {
    await writeFile(productResourcePath(f.original.layout, resource), '{}', { mode: 0o600 });
  }
  for (const file of MEMBERS) await copyFile(join(f.root, file), join(f.original.layout.root, file));
  const limits = { maxFiles: 32, maxFileBytes: 16_384, maxTotalBytes: 65_536, maxDepth: 4 };
  const bytes = await archiveState(f.original.layout, f.original.root, INSTALLATION_ID, 'f1-key', limits, '2026-11-24T00:00:00.000Z');
  const archive = unpackState(bytes, limits);
  const archivedIdentity = archive.entries.find(entry => entry.resource === 'installationIdentity' && entry.path === 'identity.json');
  expect(Buffer.from(archivedIdentity!.content, 'base64').toString('utf8')).toBe(f.identityBytes);
  for (const file of MEMBERS) expect(archive.entries.map(entry => basename(entry.path))).not.toContain(file);

  const old = join(f.host.parent, 'previous-personal-fixture');
  await rename(f.root, old);
  await mkdir(f.root, { mode: 0o700 });
  for (const file of MEMBERS) await copyFile(join(old, file), join(f.root, file));
  expect((await lstat(f.root)).ino).not.toBe((await lstat(old)).ino);
  await expect(f.instance.inspect()).rejects.toMatchObject(personalError);
  expect(f.instance.get).not.toHaveBeenCalled();
});

it('vault provenance is refused even with matching host observations', async () => {
  const f = await seed();
  const vault = personal(f.root, f.digestAt(f.original), true);
  await expect(vault.inspect()).rejects.toMatchObject({ code: 'SIWC_STORE_NOT_PERSONAL', reason: 'shared-store' });
  expect(kernel.bindingReads).toBe(0);
  expect(vault.get).not.toHaveBeenCalled();
});
