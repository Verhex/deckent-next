import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorRegistry, isRecord } from '#platform/index.js';
import { refuse } from './contract.js';
import type { HeadlessEntry } from './env.js';

type Layout = NonNullable<HeadlessEntry['command']['npmLauncher']>;
export type HeadlessExecutable = Readonly<{ chosen: string; executable: string; identity: string; fileStamp: string; size: number; mtimeMs: number; packageRoot?: string }>;
const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.uid, info.mode, info.nlink].join(':');
const infoAt = (path: string) => lstat(path, { bigint: true });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const packageVersion = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/u;
// Linux O_PATH opens a stable reference even for a standalone program with execute-only permissions.
const O_PATH = 0o10000000;
const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
// ELF64 ABI fields used by the Linux x86-64 executable-kind check.
const ELF64 = {
  magic: 0x7f454c46, x86_64: 62, executable: 2, dynamic: 3,
  ident: { elfClass: 2, littleEndian: 1, version: 1, systemV: 0, linux: 3 },
  header: { size: 64, type: 16, machine: 18, version: 20, entry: 24, programOffset: 32, declaredSize: 52, programSize: 54, programCount: 56 },
  program: { size: 56, offset: 8, fileSize: 32, dynamic: 2 },
  dynamicEntry: { size: 16, value: 8, nullTag: 0n, flags1Tag: 0x6ffffffbn, pie: 0x08000000n },
} as const;
const ELF_TABLE_MAX_BYTES = 4_096;
const BIN_MAX_TARGETS = 64, BIN_MAX_DEPTH = 32;

export function headlessExecutableRefusal(check: string, chosen: string, executable?: string, params: Record<string, string> = {}): never {
  throw ErrorRegistry.retainHeadlessPaths(ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: { ...params, check } }), chosen, executable);
}

function trusted(info: BigIntStats, owners: readonly bigint[]) {
  return owners.includes(info.uid) && (info.mode & 0o6022n) === 0n;
}

async function parents(path: string, top: string, owners: readonly bigint[], installation = false) {
  for (let dir = top; ; ) {
    const info = await infoAt(dir);
    // A trusted sticky ancestor protects the next trusted entry, but the installation itself must be private to its owners.
    const sticky = !installation && owners.includes(info.uid) && (info.mode & 0o1000n) !== 0n;
    if (!info.isDirectory() || !trusted(info, owners) && !sticky) throw new Error();
    if (dir === path) return;
    dir = join(dir, relative(dir, path).split(sep, 1)[0]!);
  }
}

async function metadata(path: string, maxBytes: number, owners?: readonly bigint[]) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.size > maxBytes || owners && (info.nlink !== 1n || !trusted(info, owners))) throw new Error();
    const data = Buffer.alloc(maxBytes + 1), { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes || BigInt(bytesRead) !== info.size || stamp(info) !== stamp(await file.stat({ bigint: true }))) throw new Error();
    const value = JSON.parse(data.subarray(0, bytesRead).toString('utf8')) as { name?: unknown; version?: unknown; bin?: string | Record<string, unknown>; optionalDependencies?: Record<string, unknown> } | null;
    return { value, identity: stamp(info) };
  } finally { await file.close(); }
}

async function npmTarget(rule: Layout, chosen: string, launcher: string, prefix: string, ownerUid: number, launcherInfo: BigIntStats, maxBytes: number) {
  const packageRoot = join(prefix, rule.packagePath), chosenLink = join(prefix, rule.linkPath);
  if (process.platform !== rule.platform || process.arch !== rule.arch || chosen !== launcher && chosen !== chosenLink)
    headlessExecutableRefusal('npm-layout-unknown', chosen);
  try {
    const root = sep, owners = [BigInt(ownerUid), 0n];
    await parents(prefix === root ? root : dirname(prefix), root, [...owners, (await infoAt(root)).uid]);
    const packageInfo = await infoAt(packageRoot);
    if (!trusted(packageInfo, owners)) throw new Error();
    const packageOwners = [packageInfo.uid];
    await parents(dirname(launcher), prefix, owners, true);
    if (!trusted(launcherInfo, packageOwners) || launcherInfo.nlink !== 1n) throw new Error();
    if (chosen !== launcher) {
      await parents(dirname(chosen), prefix, owners, true);
      const link = await infoAt(chosen);
      if (!link.isSymbolicLink() || !owners.includes(link.uid) || resolve(dirname(chosen), await readlink(chosen)) !== launcher) throw new Error();
    }
    const platformRoot = join(packageRoot, rule.platformPackagePath), executable = join(platformRoot, rule.payloadPath);
    await parents(dirname(executable), packageRoot, packageOwners, true);
    const top = await metadata(join(packageRoot, 'package.json'), maxBytes, packageOwners);
    const platform = await metadata(join(platformRoot, 'package.json'), maxBytes, packageOwners);
    const version = top.value?.version, expected = `${version}-${rule.platform}-${rule.arch}`;
    if (top.value?.name !== rule.packageName || typeof top.value.bin === 'string' || top.value.bin?.[rule.command] !== rule.launcherPath
      || typeof version !== 'string' || !packageVersion.test(version)
      || top.value.optionalDependencies?.[rule.platformPackage] !== `npm:${rule.packageName}@${expected}`
      || platform.value?.name !== rule.packageName || platform.value.version !== expected) throw new Error();
    const info = await infoAt(executable);
    if (!info.isFile() || !trusted(info, packageOwners) || info.nlink !== 1n || (info.mode & 0o111n) === 0n) throw new Error();
    await access(executable, constants.X_OK);
    return { executable, packageRoot, info, packageIdentity: [rule, top.identity, platform.identity] };
  } catch (error) {
    headlessExecutableRefusal((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'npm-payload-missing' : 'npm-payload-unverified', chosen);
  }
}

/** The nearest package supplies the manifest. The outermost package is what the realm must mask. */
function packagePosition(path: string) {
  const parts = path.split(sep);
  let packageRoot: string | undefined, manifestRoot: string | undefined;
  for (const [index, part] of parts.entries()) {
    if (part !== 'node_modules') continue;
    const name = parts[index + 1];
    // npm's unscoped package names cannot start with a dot or underscore.
    if (!name || /^[._]/u.test(name)) continue;
    const end = index + (name.startsWith('@') ? 3 : 2);
    if (end >= parts.length) continue;
    manifestRoot = parts.slice(0, end).join(sep);
    packageRoot ??= manifestRoot;
  }
  return packageRoot && manifestRoot ? { packageRoot, manifestRoot } : undefined;
}

async function binTargetInfo(root: FileHandle, target: unknown) {
  if (typeof target !== 'string' || isAbsolute(target) || target.includes('\\') || target.includes('\0')) throw new Error();
  const parts = target.replace(/^\.\//u, '').split(sep);
  if (parts.length > BIN_MAX_DEPTH || parts.some(part => !part || part === '.' || part === '..')) throw new Error();
  let current = root;
  try {
    for (const [index, part] of parts.entries()) {
      const directory = index < parts.length - 1 ? constants.O_DIRECTORY : 0;
      const next = await open(`${fdPath(current)}/${part}`, O_PATH | constants.O_NOFOLLOW | directory);
      try { if (current !== root) await current.close(); }
      finally { current = next; }
    }
    const info = await current.stat({ bigint: true });
    if (!info.isFile()) throw new Error();
    return info;
  } finally { if (current !== root) await current.close(); }
}

async function manifestExcludesFile(packageRoot: string, chosen: BigIntStats, maxBytes: number): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const root = await open(packageRoot, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await root.stat({ bigint: true });
      const manifestPath = join(fdPath(root), 'package.json');
      const { value: manifest, identity: manifestStamp }: { value: unknown; identity: string } = await metadata(manifestPath, maxBytes);
      if (!isRecord(manifest)) return false;
      const { bin, directories } = manifest;
      if (directories !== undefined && (!isRecord(directories) || Object.hasOwn(directories, 'bin'))) return false;
      if (bin !== undefined && typeof bin !== 'string' && !isRecord(bin)) return false;
      const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
      if (targets.length > BIN_MAX_TARGETS) return false;
      for (const target of targets) {
        const info = await binTargetInfo(root, target);
        if (info.dev === chosen.dev && info.ino === chosen.ino) return false;
      }
      return manifestStamp === stamp(await infoAt(manifestPath)) && stamp(before) === stamp(await infoAt(packageRoot));
    } finally { await root.close(); }
  } catch { return false; }
}

/** ET_DYN also describes shared libraries. Require the linker's explicit PIE flag. */
async function isPie(file: FileHandle, header: Buffer, size: bigint): Promise<boolean> {
  const readTable = async (offset: bigint, length: number) => {
    if (offset < ELF64.header.size || length <= 0 || length > ELF_TABLE_MAX_BYTES || offset + BigInt(length) > size) return null;
    const table = Buffer.alloc(length);
    const { bytesRead } = await file.read(table, 0, length, offset);
    return bytesRead === length ? table : null;
  };
  if (header.readBigUInt64LE(ELF64.header.entry) === 0n || header.readUInt16LE(ELF64.header.programSize) !== ELF64.program.size) return false;
  const programs = await readTable(header.readBigUInt64LE(ELF64.header.programOffset), header.readUInt16LE(ELF64.header.programCount) * ELF64.program.size);
  if (!programs) return false;
  for (let i = 0; i < programs.length; i += ELF64.program.size) {
    if (programs.readUInt32LE(i) !== ELF64.program.dynamic) continue; // PT_DYNAMIC
    const length = programs.readBigUInt64LE(i + ELF64.program.fileSize);
    if (length > ELF_TABLE_MAX_BYTES || length % BigInt(ELF64.dynamicEntry.size) !== 0n) return false;
    const dynamic = await readTable(programs.readBigUInt64LE(i + ELF64.program.offset), Number(length));
    if (!dynamic) return false;
    let pie = false;
    for (let j = 0; j < dynamic.length; j += ELF64.dynamicEntry.size) {
      const tag = dynamic.readBigInt64LE(j);
      if (tag === ELF64.dynamicEntry.nullTag) return pie; // DT_NULL
      if (tag === ELF64.dynamicEntry.flags1Tag) pie = (dynamic.readBigUInt64LE(j + ELF64.dynamicEntry.value) & ELF64.dynamicEntry.pie) !== 0n; // DT_FLAGS_1 / DF_1_PIE
    }
    return false;
  }
  return false;
}

async function provesNativeExecutable(path: string, expected: BigIntStats): Promise<boolean> {
  if (process.platform !== 'linux' || process.arch !== 'x64') return false;
  try {
    const pinned = await open(path, O_PATH | constants.O_NOFOLLOW);
    try {
      const info = await pinned.stat({ bigint: true }), expectedStamp = stamp(expected);
      if (!info.isFile() || stamp(info) !== expectedStamp) return false;
      const file = await open(fdPath(pinned), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const header = Buffer.alloc(ELF64.header.size);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        const { ident } = ELF64;
        if (bytesRead !== header.length || header.readUInt32BE(0) !== ELF64.magic
          || header[4] !== ident.elfClass || header[5] !== ident.littleEndian || header[6] !== ident.version
          || header[7] !== ident.systemV && header[7] !== ident.linux
          || header.readUInt16LE(ELF64.header.machine) !== ELF64.x86_64 || header.readUInt32LE(ELF64.header.version) !== ident.version
          || header.readUInt16LE(ELF64.header.declaredSize) !== ELF64.header.size) return false;
        const type = header.readUInt16LE(ELF64.header.type); // ET_EXEC or ET_DYN with DF_1_PIE
        return (type === ELF64.executable || type === ELF64.dynamic && await isPie(file, header, info.size))
          && stamp(await file.stat({ bigint: true })) === expectedStamp;
      } finally { await file.close(); }
    } finally { await pinned.close(); }
  } catch { return false; }
}

export async function resolveHeadlessExecutable(entry: HeadlessEntry, chosen: string, ownerUid: number): Promise<HeadlessExecutable> {
  const launcher = await realpath(chosen).catch(() => null), launcherInfo = launcher ? await infoAt(launcher).catch(() => null) : null;
  if (!launcher || !launcherInfo?.isFile() || (launcherInfo.mode & 0o111n) === 0n) refuse('HEADLESS_CLI_UNAVAILABLE');
  const chosenInfo = await infoAt(chosen).catch(() => null);
  if (!chosenInfo) refuse('HEADLESS_CLI_UNAVAILABLE');
  const rule = entry.command.npmLauncher, suffix = rule && `/${rule.packagePath}/${rule.launcherPath}`;
  const target = rule && suffix && launcher.endsWith(suffix)
    ? await npmTarget(rule, chosen, launcher, launcher.slice(0, -suffix.length) || sep, ownerUid, launcherInfo, entry.headless.limits.preflightOutputBytes) : undefined;
  const position = target ? undefined : packagePosition(launcher);
  if (position && !await manifestExcludesFile(position.manifestRoot, launcherInfo, entry.headless.limits.preflightOutputBytes)
    && !await provesNativeExecutable(launcher, launcherInfo)) headlessExecutableRefusal('npm-layout-unknown', chosen);
  const executable = target?.executable ?? launcher, info = target?.info ?? launcherInfo, fileStamp = stamp(info);
  const packageRoot = target?.packageRoot ?? position?.packageRoot;
  return Object.freeze({ chosen, executable, fileStamp, size: Number(info.size), mtimeMs: Number(info.mtimeMs), ...(packageRoot ? { packageRoot } : {}),
    identity: digest([chosen, stamp(chosenInfo), launcher, stamp(launcherInfo), target?.packageIdentity ?? position?.packageRoot, executable, fileStamp]) });
}

export async function pinHeadlessExecutable(entry: HeadlessEntry, resolution: HeadlessExecutable) {
  const changed = () => headlessExecutableRefusal('executable-changed', resolution.chosen, resolution.executable);
  const file = await open(resolution.executable, O_PATH | constants.O_NOFOLLOW).catch(changed);
  try {
    const current = await resolveHeadlessExecutable(entry, resolution.chosen, process.getuid!()).catch(changed);
    const info = await file.stat({ bigint: true }).catch(changed);
    if (!info.isFile() || stamp(info) !== resolution.fileStamp || current.identity !== resolution.identity) changed();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
