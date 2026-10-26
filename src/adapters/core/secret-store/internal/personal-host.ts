import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { PersonalCustodyError } from '#engine/index.js';
import { PERSONAL_CUSTODY_REGISTRY as registry } from './personal-registry.js';
import { ENCRYPTED_FILE_SECRET_STORE_KEY, ENCRYPTED_FILE_SECRET_STORE_NAME } from './encrypted.js';

export const custodyDigest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** POSIX private-file invariants, independent of mutable business policy. */
const PRIVATE_FILE_MODE = 0o600, POSIX_PERMISSION_BITS = 0o777;
const unsafe = () => new PersonalCustodyError('unsafe-root');
const identity = (info: Stats) => [info.dev, info.ino, info.uid, info.mode, info.nlink];
/** Reads only bounded host metadata; never a key or envelope's bytes. */
export async function custodyHostText(path: string, maxBytes = registry.hostMaxBytes): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > maxBytes) throw new PersonalCustodyError('unknown-locality');
    return bytes.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}
/** Private POSIX document, final handle/path identity checked; no automatic permission repairs. */
export async function personalPrivateFile(path: string, uid: number, maxBytes: number, read = false): Promise<{ identity: string; text: string } | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (absent(error)) return null; throw unsafe(); }
  try {
    const [info, linked] = await Promise.all([handle.stat(), lstat(path)]);
    if (!info.isFile() || linked.isSymbolicLink() || info.dev !== linked.dev || info.ino !== linked.ino || info.uid !== uid
      || info.nlink !== 1 || (info.mode & POSIX_PERMISSION_BITS) !== PRIVATE_FILE_MODE || info.size > maxBytes) throw unsafe();
    let text = '';
    if (read) {
      const bytes = Buffer.alloc(maxBytes + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > maxBytes || result.bytesRead !== info.size) throw unsafe();
      text = bytes.subarray(0, result.bytesRead).toString('utf8');
    }
    const after = await lstat(path);
    if (custodyDigest(identity(after)) !== custodyDigest(identity(info))) throw unsafe();
    return { identity: custodyDigest(identity(info)), text };
  } finally { await handle.close(); }
}
export type PersonalHostObservation = Readonly<{ locationDigest: string; keyIdentityDigest: string | null; mountEvidenceDigest: string; pairPresent: boolean }>;
/** Strict Linux proof. Unsupported platforms/backing fail closed, without using the performance filesystem classifier. */
export async function observePersonalStoreHost(root: string, uid: number): Promise<PersonalHostObservation> {
  if (process.platform !== 'linux' || !uid || uid !== process.getuid?.()) throw new PersonalCustodyError('foreign-os-owner');
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw unsafe();
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o077) !== 0) throw unsafe();
  // On the allowlisted Linux filesystems POSIX ACL named entries cannot override a zero group-class mask (0700/0600).
  for (let path = dirname(root); ; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.uid !== uid && info.uid !== 0)) throw unsafe();
    if (dirname(path) === path) break;
  }
  const [mountEvidenceDigest, envelope, key] = await Promise.all([observeLocalBacking(root, rootInfo.dev),
    personalPrivateFile(join(root, ENCRYPTED_FILE_SECRET_STORE_NAME), uid, Number.MAX_SAFE_INTEGER),
    personalPrivateFile(join(root, ENCRYPTED_FILE_SECRET_STORE_KEY), uid, 32)]);
  if (Boolean(envelope) !== Boolean(key)) throw unsafe();
  if (key && (await lstat(join(root, ENCRYPTED_FILE_SECRET_STORE_KEY))).size !== 32) throw unsafe();
  if (custodyDigest(identity(await lstat(root))) !== custodyDigest(identity(rootInfo)) || await realpath(root) !== canonical) throw unsafe();
  return Object.freeze({ locationDigest: custodyDigest([canonical, rootInfo.dev, rootInfo.ino, rootInfo.uid]), keyIdentityDigest: key?.identity ?? null,
    mountEvidenceDigest, pairPresent: envelope !== null });
}
const unescapeMount = (value: string) => value.replace(/\\(040|011|012|134)/gu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
async function observeLocalBacking(root: string, dev: number): Promise<string> {
  try {
    const [fs, mounts] = await Promise.all([statfs(root), custodyHostText('/proc/self/mountinfo')]);
    const rows = mounts.trim().split('\n').map(line => {
      const [left, right] = line.split(' - '), fields = left!.split(' '), type = right?.split(' ')[0];
      return { id: fields[0], device: fields[2], base: unescapeMount(fields[3] ?? ''), path: unescapeMount(fields[4] ?? ''), type };
    }).filter(row => row.path && (root === row.path || root.startsWith(row.path === sep ? sep : `${row.path}${sep}`)))
      .sort((a, b) => b.path.length - a.path.length);
    const mount = rows[0], type = mount?.type as keyof typeof registry.filesystemTypes;
    if (!mount || mount.base !== '/' || !Object.hasOwn(registry.filesystemTypes, type) || fs.type !== registry.filesystemTypes[type])
      throw new PersonalCustodyError(mount?.type && /nfs|cifs|9p|fuse|drvfs/su.test(mount.type) ? 'remote-store' : 'unknown-locality');
    const device = BigInt(dev), major = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n)),
      minor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
    if (mount.device !== `${major}:${minor}`) throw new PersonalCustodyError('unknown-locality');
    const ancestry: string[] = [];
    await localDevice(`/sys/dev/block/${mount.device}`, ancestry, 0);
    return custodyDigest([fs.type, mount, ancestry]);
  } catch (error) { if (error instanceof PersonalCustodyError) throw error; throw new PersonalCustodyError('unknown-locality'); }
}
async function localDevice(path: string, seen: string[], depth: number): Promise<void> {
  if (depth >= registry.deviceMaxDepth) throw new PersonalCustodyError('unknown-locality');
  const canonical = await realpath(path);
  if (seen.includes(canonical) || registry.remoteDevicePatterns.some(part => canonical.toLowerCase().includes(part))) throw new PersonalCustodyError('unknown-locality');
  seen.push(canonical);
  let slaves: string[];
  try { slaves = await readdir(join(canonical, 'slaves')); } catch {
    if (await lstat(join(canonical, 'partition')).then(() => true, () => false)) return localDevice(dirname(canonical), seen, depth + 1);
    throw new PersonalCustodyError('unknown-locality');
  }
  if (slaves.length) {
    if (slaves.length > registry.deviceMaxDepth) throw new PersonalCustodyError('unknown-locality');
    for (const slave of slaves) await localDevice(join(canonical, 'slaves', slave), seen, depth + 1);
    return;
  }
  // Partitions inherit the block parent's transport. Do not bless virtual/loop, network block or unresolved overlay devices.
  if (await lstat(join(canonical, 'partition')).then(() => true, () => false)) return localDevice(dirname(canonical), seen, depth + 1);
  if (canonical.includes('/virtual/') || !registry.localDevicePaths.some(part => canonical.includes(part))) throw new PersonalCustodyError('unknown-locality');
  const transport = await readlink(join(canonical, 'device', 'subsystem')).catch(() => '');
  if (!transport || /iscsi|fabrics|network/su.test(transport)) throw new PersonalCustodyError('unknown-locality');
  // NVMe PCI devices must also report the local transport, rather than a fabric controller.
  if (canonical.includes('/nvme')) {
    let parent = canonical, local = false;
    for (let i = 0; i < registry.deviceMaxDepth && dirname(parent) !== parent; i++, parent = dirname(parent)) {
      const value = await custodyHostText(join(parent, 'transport'), registry.metadataMaxBytes).catch(() => null);
      if (value !== null) { local = value.trim() === 'pcie'; break; }
    }
    if (!local) throw new PersonalCustodyError('unknown-locality');
  }
}
