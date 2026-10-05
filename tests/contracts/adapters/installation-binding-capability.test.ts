import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const limits = { timeoutMs: 37, outputBytes: 4096 }, store = new FileInstallationIdentityStore(f.layout, undefined, undefined, limits);
  expect(await store.read()).toMatchObject({ status: 'unavailable', reason: 'not-created' });
  expect(probe.execute).not.toHaveBeenCalled(); // Read of absence needs no OS subprocess.
  const identity = await store.loadOrCreate(), bytes = await readFile(f.path, 'utf8');
  expect(probe.execute).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { timeout: 37, maxBuffer: 4096, encoding: 'utf8' });
  expect(JSON.parse(bytes).binding.machineDigest).toBe(createHmac('sha256', 'deckent.installation-binding.v1').update(uuid).digest('hex'));
  expect(bytes).not.toContain(uuid);
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'supported' });
});

it.skipIf(process.platform === 'win32').each(['absent', 'malformed', 'timeout'])('macOS %s capability does not fail a metadata command (simulated host)', async scenario => {
  const f = await fixture('darwin');
  if (scenario === 'timeout') probe.execute.mockRejectedValue(new Error('ETIMEDOUT'));
  else probe.execute.mockResolvedValue({ stdout: scenario === 'absent' ? '' : '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"', stderr: '' });
  const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate();
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
});

it.skipIf(process.platform === 'win32').each(['', '0'.repeat(32), 'invalid', new Error('ENOENT')])('Linux missing or invalid machine evidence yields unsupported without fabricated binding: %s', async machine => {
  const f = await fixture('linux'); probe.machine = machine;
  const store = new FileInstallationIdentityStore(f.layout), identity = await store.loadOrCreate();
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(identity);
  expect(probe.execute).not.toHaveBeenCalled();
});

it('Windows optional metadata read reports unsupported without invoking a machine probe (simulated host)', async () => {
  const f = await fixture('win32');
  expect(await new FileInstallationIdentityStore(f.layout).read()).toEqual({ status: 'unavailable', reason: 'unsupported', bindingCapability: 'unsupported' });
  expect(probe.execute).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
