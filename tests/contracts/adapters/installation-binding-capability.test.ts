import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { resolveProductLayout } from '#platform/index.js';

const probe = vi.hoisted(() => ({ execute: vi.fn(), machine: undefined as string | Error | undefined }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: probe.execute }) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: (...args: Parameters<typeof original.readFile>) => {
    if (args[0] === '/etc/machine-id' && probe.machine !== undefined) {
      return probe.machine instanceof Error ? Promise.reject(probe.machine) : Promise.resolve(probe.machine);
    }
    return original.readFile(...args);
  } };
});
const roots: string[] = [], nativePlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: nativePlatform }); probe.machine = undefined; probe.execute.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(platform: NodeJS.Platform) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-capability-')); roots.push(root);
  // Paths belong to the real filesystem; only the machine capability is simulated.
  const layout = resolveProductLayout({ projectRoot: root, platform: nativePlatform === 'win32' ? 'win32' : 'posix' });
  Object.defineProperty(process, 'platform', { value: platform });
  return { root, layout, path: join(root, '.deckent/installation-identity/identity.json') };
}

it.skipIf(process.platform === 'win32')('uses bounded macOS IOPlatformUUID capture and never persists raw machine identity (simulated host)', async () => {
  const f = await fixture('darwin'), uuid = '11111111-2222-4333-8444-555555555555';
  probe.execute.mockResolvedValue({ stdout: `  "IOPlatformUUID" = "${uuid}"\n`, stderr: '' });
  const limits = { timeoutMs: 37, outputBytes: 4096 }, store = new FileInstallationIdentityStore(f.layout, undefined, undefined, { identityProbe: limits });
  expect(await store.read()).toMatchObject({ status: 'unavailable', reason: 'not-created' });
  expect(probe.execute).not.toHaveBeenCalled(); // Read of absence needs no OS subprocess.
  const identity = await store.loadOrCreate(), bytes = await readFile(f.path, 'utf8');
  expect(probe.execute).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { timeout: 37, maxBuffer: 4096, encoding: 'utf8' });
  // A platform machine binding keeps the v1 persisted shape (rollback-safe); strength and source are reported on reads.
  expect(JSON.parse(bytes).binding).toEqual({ schemaVersion: 1, machineDigest: createHmac('sha256', 'deckent.installation-binding.v1').update(uuid).digest('hex'),
    canonicalRoot: await realpath(join(f.root, '.deckent')), device: expect.stringMatching(/^\d+$/u), inode: expect.stringMatching(/^[1-9]\d*$/u) });
  expect(bytes).not.toContain(uuid);
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'supported', binding: { strength: 'machine', source: 'platform' } });
});

const weakRead = (value: unknown) => ({ status: 'available', value, bindingCapability: 'supported', binding: { strength: 'weak', source: 'location' } });
/** Binding v2: without machine evidence the record is still bound, weakly, to root/device/inode; no machine value is fabricated. */
async function expectWeakRecord(path: string, root: string, installationId: string) {
  const record = JSON.parse(await readFile(path, 'utf8'));
  expect(record).toMatchObject({ schemaVersion: 2, installationId, lastResolution: null,
    binding: { schemaVersion: 2, strength: 'weak', source: 'location', canonicalRoot: await realpath(join(root, '.deckent')) } });
  expect(record.binding).not.toHaveProperty('machineDigest');
}

it.skipIf(process.platform === 'win32').each(['absent', 'malformed', 'timeout'])('macOS %s machine evidence falls back to a weak binding without failing a metadata command (simulated host)', async scenario => {
  const f = await fixture('darwin');
  if (scenario === 'timeout') probe.execute.mockRejectedValue(new Error('ETIMEDOUT'));
  else probe.execute.mockResolvedValue({ stdout: scenario === 'absent' ? '' : '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"', stderr: '' });
  const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate();
  expect(await store.read()).toEqual(weakRead(identity));
  await expectWeakRecord(f.path, f.root, identity.installationId);
});

it.skipIf(process.platform === 'win32').each(['', '0'.repeat(32), 'invalid', new Error('ENOENT')])('Linux missing or invalid machine evidence writes a weak binding, never a fabricated machine digest: %s', async machine => {
  const f = await fixture('linux'); probe.machine = machine;
  const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate();
  expect(await store.read()).toEqual(weakRead(identity));
  await expectWeakRecord(f.path, f.root, identity.installationId);
  expect(probe.execute).not.toHaveBeenCalled();
});

it('Windows optional metadata read reports unsupported without invoking a machine probe (simulated host)', async () => {
  const f = await fixture('win32');
  expect(await new FileInstallationIdentityStore(f.layout).read()).toEqual({ status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' });
  expect(probe.execute).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
