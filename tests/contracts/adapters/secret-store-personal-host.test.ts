import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { unsafeStoreDirectory } from '#adapters/index.js';
const { localDevice } = await import('../../../src/adapters/core/secret-store/internal/personal-host.js');

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });
/** A sysfs-shaped fixture: a SCSI disk whose ancestry is the given bus path, with an empty `slaves` and a `device/subsystem` link. */
async function disk(bus: string): Promise<string> {
  const target = join(root, 'devices', bus, 'host0', 'target0:0:0', '0:0:0:3');
  await mkdir(join(target, 'block', 'sdd', 'slaves'), { recursive: true });
  await mkdir(join(root, 'bus', 'scsi'), { recursive: true });
  await symlink(join(root, 'bus', 'scsi'), join(target, 'subsystem'));
  await symlink(target, join(target, 'block', 'sdd', 'device'));
  return join(target, 'block', 'sdd');
}

it('classifies a WSL2 VMBus disk under the ACPI MSFT1000 node as local and keeps an unrecognized bus unknown (FIX8b R22)', async () => {
  root = await mkdtemp(join(tmpdir(), 'custody-sysfs-'));
  // This kernel (6.18 WSL2) names the VMBus ACPI node by its HID: modalias acpi:MSFT1000:VMBUS:, no `/VMBUS:` path segment.
  await expect(localDevice(await disk('LNXSYSTM:00/LNXSYBUS:00/ACPI0004:00/MSFT1000:00/fd1d2cbd-ce7c-535c-966b-eb5f811c95f0'), [], 0)).resolves.toBeUndefined();
  await expect(localDevice(await disk('LNXSYSTM:00/LNXSYBUS:00/PNP0A03:00/unknown0'), [], 0)).rejects.toMatchObject({ reason: 'unknown-locality' });
});

it('names the open folder: the store root itself, or a parent other users can write (FIX8b E01)', async () => {
  root = await mkdtemp(join(tmpdir(), 'custody-root-'));
  const uid = process.getuid!();
  const store = join(root, 'global');
  await mkdir(store, { mode: 0o700 }); await chmod(root, 0o700); await chmod(store, 0o755);
  expect(await unsafeStoreDirectory(store, uid)).toEqual({ path: store, mode: '0755', parent: false });
  await chmod(store, 0o700); await chmod(root, 0o777);
  expect(await unsafeStoreDirectory(store, uid)).toEqual({ path: root, mode: '0777', parent: true });
});
