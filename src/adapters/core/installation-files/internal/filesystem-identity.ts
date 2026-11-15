import { realpath, stat } from 'node:fs/promises';
import { filesystemIdentitySchema, type FilesystemIdentity } from '#domain/index.js';
import { linuxDeviceNumber, linuxMountsAt, readHostMetadata } from '#platform/index.js';
import { nativeFilesystemIdentity, type NativeFilesystemStat } from '#adapters/core/local-runtime-socket/index.js';
import registry from './filesystem-identity-registry.json' with { type: 'json' };

export type FilesystemIdentityUnavailable = 'platform-unsupported' | 'native-unavailable' | 'mount-unavailable' | 'bind-mount'
  | 'filesystem-unproven' | 'filesystem-mismatch' | 'device-mismatch' | 'identity-zero' | 'location-changed';
export type FilesystemIdentityObservation = Readonly<{ status: 'available'; identity: FilesystemIdentity }
  | { status: 'unavailable'; reason: FilesystemIdentityUnavailable }>;
const unavailable = (reason: FilesystemIdentityUnavailable): FilesystemIdentityObservation => ({ status: 'unavailable', reason });
/** Pure fixture seam over the kernel observation and bounded mountinfo. No mixing of producer kinds. */
export function assessFilesystemIdentity(root: string, device: string, inode: string, mounts: string, fs: NativeFilesystemStat): FilesystemIdentityObservation {
  const mount = linuxMountsAt(root, mounts)[0];
  if (!mount) return unavailable('mount-unavailable');
  // Full-root aliases elsewhere expose this same filesystem; only this directory's enclosing mount matters.
  if (mount.base !== '/') return unavailable('bind-mount');
  const types: Readonly<Record<string, { statfsType: number; kind: string }>> = registry.filesystemTypes;
  const producer = mount.type && Object.hasOwn(types, mount.type) ? types[mount.type] : undefined;
  if (!producer) return unavailable('filesystem-unproven');
  if (producer.statfsType !== fs.type) return unavailable('filesystem-mismatch');
  if (mount.device !== linuxDeviceNumber(BigInt(device))) return unavailable('device-mismatch');
  if (fs.device !== device || fs.inode !== inode) return unavailable('location-changed');
  if (!/^[a-f0-9]{16}$/u.test(fs.fsid) || /^0+$/u.test(fs.fsid)) return unavailable('identity-zero');
  return { status: 'available', identity: filesystemIdentitySchema.parse({ kind: producer.kind, value: fs.fsid }) };
}
/** Linux ext4 only until each additional producer is proven and entered in registry data. Nothing is written. */
export async function inspectFilesystemIdentity(root: string, location?: { device: string; inode: string }): Promise<FilesystemIdentityObservation> {
  if (process.platform !== 'linux') return unavailable('platform-unsupported');
  try {
    const canonical = await realpath(root);
    if (location && canonical !== root) return unavailable('location-changed');
    const info: { device: string; inode: string } = location ?? await stat(canonical, { bigint: true }).then(value => ({ device: String(value.dev), inode: String(value.ino) }));
    const mounts = await readHostMetadata('/proc/self/mountinfo', registry.mountinfoMaxBytes);
    const mount = linuxMountsAt(canonical, mounts)[0];
    if (!mount) return unavailable('mount-unavailable');
    if (mount.base !== '/') return unavailable('bind-mount');
    if (!mount.type || !Object.hasOwn(registry.filesystemTypes, mount.type)) return unavailable('filesystem-unproven');
    const fs = nativeFilesystemIdentity(canonical);
    if (!fs) return unavailable('native-unavailable');
    const result = assessFilesystemIdentity(canonical, info.device, info.inode, mounts, fs);
    // Keep the observation tied to the captured directory, including a path swapped during mountinfo reading.
    const after = await stat(canonical, { bigint: true });
    if (String(after.dev) !== info.device || String(after.ino) !== info.inode || await realpath(root) !== canonical) return unavailable('location-changed');
    return result;
  } catch { return unavailable('mount-unavailable'); }
}
