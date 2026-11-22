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
  program: { size: 56, offset: 8, fileSize: 32, memorySize: 40, load: 1, dynamic: 2 },
  dynamicEntry: { size: 16, value: 8, nullTag: 0n, flags1Tag: 0x6ffffffbn, pie: 0x08000000n },
} as const;
const ELF_TABLE_MAX_BYTES = 4_096;
const BIN_MAX_TARGETS = 64, BIN_MAX_DEPTH = 32;

export function headlessExecutableRefusal(check: string, chosen: string, executable?: string, params: Record<string, string> = {}): never {
  throw ErrorRegistry.retainHeadlessPaths(ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: { ...params, check } }), chosen, executable);
}

type SelectionFailure = 'unavailable' | 'directory' | 'not-regular-file' | 'not-executable';
export function headlessSelectionRefusal(chosen: string, reason: SelectionFailure): never {
  return headlessExecutableRefusal('selected-file', chosen, undefined, { reason });
}

type NpmCheckReason = 'missing' | 'not-directory' | 'not-regular-file' | 'not-expected-link' | 'untrusted-owner'
  | 'group-or-other-writable' | 'set-id' | 'multiple-hard-links' | 'manifest-mismatch' | 'manifest-too-large'
  | 'manifest-unreadable' | 'not-executable' | 'changed-during-check' | 'verification-unavailable';
function executableRecheckRefusal(path: string, reason: NpmCheckReason): never {
  throw ErrorRegistry.retainHeadlessFailedCheck(ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', {
    params: { check: 'executable-recheck', reason },
  }), path);
}

class NpmCheckFailure extends Error {
  constructor(readonly reason: NpmCheckReason) { super(reason); }
}

function checkTrust(info: BigIntStats, owners: readonly bigint[], allowSticky = false) {
  if (!owners.includes(info.uid)) throw new NpmCheckFailure('untrusted-owner');
  if (allowSticky && (info.mode & 0o1000n) !== 0n) return;
  if ((info.mode & 0o0022n) !== 0n) throw new NpmCheckFailure('group-or-other-writable');
  if ((info.mode & 0o6000n) !== 0n) throw new NpmCheckFailure('set-id');
}

function checkSingleLink(info: BigIntStats) {
  if (info.nlink !== 1n) throw new NpmCheckFailure(info.nlink > 1n ? 'multiple-hard-links' : 'changed-during-check');
}

async function parents(path: string, top: string, owners: readonly bigint[], checking: (path: string) => string, installation = false) {
  for (let dir = top; ; ) {
    const info = await infoAt(checking(dir));
    // A trusted sticky ancestor protects the next trusted entry, but the installation itself must be private to its owners.
    if (!info.isDirectory()) throw new NpmCheckFailure('not-directory');
    checkTrust(info, owners, !installation);
    if (dir === path) return;
    dir = join(dir, relative(dir, path).split(sep, 1)[0]!);
  }
}

async function metadata(path: string, maxBytes: number, owners?: readonly bigint[]) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ELOOP') throw new NpmCheckFailure('not-regular-file');
    throw error;
  });
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new NpmCheckFailure('not-regular-file');
    if (info.size > maxBytes) throw new NpmCheckFailure('manifest-too-large');
    if (owners) {
      checkSingleLink(info);
      checkTrust(info, owners);
    }
    const data = Buffer.alloc(maxBytes + 1), { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw new NpmCheckFailure('manifest-too-large');
    if (BigInt(bytesRead) !== info.size) throw new NpmCheckFailure('manifest-unreadable');
    if (stamp(info) !== stamp(await file.stat({ bigint: true }))) throw new NpmCheckFailure('changed-during-check');
    const value = JSON.parse(data.subarray(0, bytesRead).toString('utf8')) as { name?: unknown; version?: unknown; bin?: string | Record<string, unknown>; optionalDependencies?: Record<string, unknown> } | null;
    return { value, identity: stamp(info) };
  } finally { await file.close(); }
}

function checkReason(error: unknown): NpmCheckReason {
  if (error instanceof NpmCheckFailure) return error.reason;
  if (error instanceof SyntaxError) return 'manifest-mismatch';
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case 'ENOENT': return 'missing';
    case 'ENOTDIR': return 'not-directory';
    default: return 'verification-unavailable';
  }
}

async function npmTarget(rule: Layout, chosen: string, launcher: string, prefix: string, ownerUid: number, launcherInfo: BigIntStats, maxBytes: number, recheck: boolean) {
  const packageRoot = join(prefix, rule.packagePath), chosenLink = join(prefix, rule.linkPath);
  if (process.platform !== rule.platform || process.arch !== rule.arch || chosen !== launcher && chosen !== chosenLink)
    headlessExecutableRefusal('npm-layout-unknown', chosen);
  let failedPath: string = sep, expected: string | undefined;
  const checking = (path: string) => { failedPath = path; return path; };
  try {
    const root = sep, owners = [BigInt(ownerUid), 0n];
    await parents(prefix === root ? root : dirname(prefix), root, [...owners, (await infoAt(root)).uid], checking);
    const packageInfo = await infoAt(checking(packageRoot));
    checkTrust(packageInfo, owners);
    const packageOwners = [packageInfo.uid];
    await parents(dirname(launcher), prefix, owners, checking, true);
    checking(launcher);
    checkTrust(launcherInfo, packageOwners);
    checkSingleLink(launcherInfo);
    if (chosen !== launcher) {
      await parents(dirname(chosen), prefix, owners, checking, true);
      const link = await infoAt(checking(chosen));
      if (!link.isSymbolicLink()) throw new NpmCheckFailure('not-expected-link');
      if (!owners.includes(link.uid)) throw new NpmCheckFailure('untrusted-owner');
      const target = await readlink(chosen).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EINVAL') throw new NpmCheckFailure('not-expected-link');
        throw error;
      });
      if (resolve(dirname(chosen), target) !== launcher) throw new NpmCheckFailure('not-expected-link');
    }
    const platformRoot = join(packageRoot, rule.platformPackagePath), executable = join(platformRoot, rule.payloadPath);
    expected = executable;
    await parents(dirname(executable), packageRoot, packageOwners, checking, true);
    const topPath = join(packageRoot, 'package.json'), platformPath = join(platformRoot, 'package.json');
    const top = await metadata(checking(topPath), maxBytes, packageOwners);
    const platform = await metadata(checking(platformPath), maxBytes, packageOwners);
    checking(topPath);
    const version = top.value?.version;
    const expectedVersion = typeof version === 'string' ? `${version}-${rule.platform}-${rule.arch}` : null;
    if (top.value?.name !== rule.packageName || typeof top.value.bin === 'string' || top.value.bin?.[rule.command] !== rule.launcherPath
      || typeof version !== 'string' || !packageVersion.test(version)
      || top.value.optionalDependencies?.[rule.platformPackage] !== `npm:${rule.packageName}@${expectedVersion}`) throw new NpmCheckFailure('manifest-mismatch');
    checking(platformPath);
    if (platform.value?.name !== rule.packageName || platform.value.version !== expectedVersion) throw new NpmCheckFailure('manifest-mismatch');
    const info = await infoAt(checking(executable));
    if (!info.isFile()) throw new NpmCheckFailure('not-regular-file');
    checkTrust(info, packageOwners);
    checkSingleLink(info);
    if ((info.mode & 0o111n) === 0n) throw new NpmCheckFailure('not-executable');
    await access(executable, constants.X_OK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EACCES') throw new NpmCheckFailure('not-executable');
      throw error;
    });
    return { executable, packageRoot, info, packageIdentity: [rule, top.identity, platform.identity] };
  } catch (error) {
    const reason = checkReason(error), check = reason === 'missing' ? 'npm-payload-missing' : 'npm-payload-unverified';
    throw ErrorRegistry.retainHeadlessFailedCheck(ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', {
      params: recheck ? { check, reason, recheck: 1 } : { check, reason },
    }), failedPath, expected);
  }
}

/** Every enclosing package can declare a bin target. The realm masks the outermost one. */
function packagePosition(path: string) {
  const parts = path.split(sep), manifestRoots: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part !== 'node_modules') continue;
    const name = parts[index + 1];
    // npm's unscoped package names cannot start with a dot or underscore.
    if (!name || /^[._]/u.test(name)) continue;
    const end = index + (name.startsWith('@') ? 3 : 2);
    if (end >= parts.length) continue;
    manifestRoots.push(parts.slice(0, end).join(sep));
    if (manifestRoots.length > BIN_MAX_DEPTH) break;
  }
  const packageRoot = manifestRoots[0];
  return packageRoot ? { packageRoot, manifestRoots } : undefined;
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

async function remainingTargetsAfterExclusion(packageRoot: string, chosen: BigIntStats, maxBytes: number, remaining: number): Promise<number | null> {
  try {
    const root = await open(packageRoot, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await root.stat({ bigint: true });
      const manifestPath = join(fdPath(root), 'package.json');
      const { value: manifest, identity: manifestStamp }: { value: unknown; identity: string } = await metadata(manifestPath, maxBytes);
      if (!isRecord(manifest)) return null;
      const { bin, directories } = manifest;
      if (directories !== undefined && (!isRecord(directories) || Object.hasOwn(directories, 'bin'))) return null;
      if (bin !== undefined && typeof bin !== 'string' && !isRecord(bin)) return null;
      const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
      if (targets.length > remaining) return null;
      for (const target of targets) {
        const info = await binTargetInfo(root, target);
        if (info.dev === chosen.dev && info.ino === chosen.ino) return null;
      }
      if (manifestStamp !== stamp(await infoAt(manifestPath)) || stamp(before) !== stamp(await infoAt(packageRoot))) return null;
      return remaining - targets.length;
    } finally { await root.close(); }
  } catch { return null; }
}

async function manifestsExcludeFile(manifestRoots: readonly string[], chosen: BigIntStats, maxBytes: number): Promise<boolean> {
  if (process.platform !== 'linux' || manifestRoots.length > BIN_MAX_DEPTH) return false;
  let remaining = BIN_MAX_TARGETS;
  for (const root of manifestRoots) {
    const next = await remainingTargetsAfterExclusion(root, chosen, maxBytes, remaining);
    if (next === null) return false;
    remaining = next;
  }
  return true;
}

async function readElfTable(file: FileHandle, size: bigint, offset: bigint, length: number) {
  if (offset < ELF64.header.size || length <= 0 || length > ELF_TABLE_MAX_BYTES || offset + BigInt(length) > size) return null;
  const table = Buffer.alloc(length);
  const { bytesRead } = await file.read(table, 0, length, offset);
  return bytesRead === length ? table : null;
}

function hasLoadableSegment(programs: Buffer, size: bigint): boolean {
  for (let i = 0; i < programs.length; i += ELF64.program.size) {
    if (programs.readUInt32LE(i) !== ELF64.program.load) continue; // PT_LOAD
    const offset = programs.readBigUInt64LE(i + ELF64.program.offset);
    const length = programs.readBigUInt64LE(i + ELF64.program.fileSize);
    if (length > 0n && length <= programs.readBigUInt64LE(i + ELF64.program.memorySize) && offset + length <= size) return true;
  }
  return false;
}

/** ET_DYN also describes shared libraries. Require the linker's explicit PIE flag. */
async function isPie(file: FileHandle, programs: Buffer, size: bigint): Promise<boolean> {
  for (let i = 0; i < programs.length; i += ELF64.program.size) {
    if (programs.readUInt32LE(i) !== ELF64.program.dynamic) continue; // PT_DYNAMIC
    const length = programs.readBigUInt64LE(i + ELF64.program.fileSize);
    if (length > ELF_TABLE_MAX_BYTES || length % BigInt(ELF64.dynamicEntry.size) !== 0n) return false;
    const dynamic = await readElfTable(file, size, programs.readBigUInt64LE(i + ELF64.program.offset), Number(length));
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
          || header.readUInt16LE(ELF64.header.declaredSize) !== ELF64.header.size
          || header.readUInt16LE(ELF64.header.programSize) !== ELF64.program.size) return false;
        const type = header.readUInt16LE(ELF64.header.type); // ET_EXEC or ET_DYN with DF_1_PIE
        if (type !== ELF64.executable && type !== ELF64.dynamic) return false;
        const programs = await readElfTable(file, info.size, header.readBigUInt64LE(ELF64.header.programOffset),
          header.readUInt16LE(ELF64.header.programCount) * ELF64.program.size);
        return programs !== null && hasLoadableSegment(programs, info.size)
          && (type === ELF64.executable || header.readBigUInt64LE(ELF64.header.entry) !== 0n && await isPie(file, programs, info.size))
          && stamp(await file.stat({ bigint: true })) === expectedStamp;
      } finally { await file.close(); }
    } finally { await pinned.close(); }
  } catch { return false; }
}

export async function resolveHeadlessExecutable(entry: HeadlessEntry, chosen: string, ownerUid: number, context?: 'new' | 'recheck'): Promise<HeadlessExecutable> {
  const unavailable = (reason: SelectionFailure, failedPath = chosen): never => {
    if (context === 'new') headlessSelectionRefusal(chosen, reason);
    if (context === 'recheck') {
      const check = reason === 'directory' ? 'not-regular-file' : reason === 'unavailable' ? 'verification-unavailable' : reason;
      executableRecheckRefusal(failedPath, check);
    }
    return refuse('HEADLESS_CLI_UNAVAILABLE');
  };
  const launcher = await realpath(chosen).catch(() => null), launcherInfo = launcher ? await infoAt(launcher).catch(() => null) : null;
  if (!launcher || !launcherInfo) return unavailable('unavailable', launcher ?? chosen);
  if (!launcherInfo.isFile()) return unavailable(launcherInfo.isDirectory() ? 'directory' : 'not-regular-file', launcher);
  if ((launcherInfo.mode & 0o111n) === 0n) return unavailable('not-executable', launcher);
  const chosenInfo = await infoAt(chosen).catch(() => null);
  if (!chosenInfo) return unavailable('unavailable');
  const rule = entry.command.npmLauncher, suffix = rule && `/${rule.packagePath}/${rule.launcherPath}`;
  const target = rule && suffix && launcher.endsWith(suffix)
    ? await npmTarget(rule, chosen, launcher, launcher.slice(0, -suffix.length) || sep, ownerUid, launcherInfo, entry.headless.limits.preflightOutputBytes, context === 'recheck') : undefined;
  const position = target ? undefined : packagePosition(launcher);
  if (position && !await manifestsExcludeFile(position.manifestRoots, launcherInfo, entry.headless.limits.preflightOutputBytes)
    && !await provesNativeExecutable(launcher, launcherInfo)) headlessExecutableRefusal('npm-layout-unknown', chosen);
  const executable = target?.executable ?? launcher, info = target?.info ?? launcherInfo, fileStamp = stamp(info);
  const packageRoot = target?.packageRoot ?? position?.packageRoot;
  return Object.freeze({ chosen, executable, fileStamp, size: Number(info.size), mtimeMs: Number(info.mtimeMs), ...(packageRoot ? { packageRoot } : {}),
    identity: digest([chosen, stamp(chosenInfo), launcher, stamp(launcherInfo), target?.packageIdentity ?? position?.packageRoot, executable, fileStamp]) });
}

export async function pinHeadlessExecutable(entry: HeadlessEntry, resolution: HeadlessExecutable) {
  const changed = () => headlessExecutableRefusal('executable-changed', resolution.chosen, resolution.executable);
  const unreadable = (error: unknown) => executableRecheckRefusal(resolution.executable, checkReason(error));
  const file = await open(resolution.executable, O_PATH | constants.O_NOFOLLOW).catch(unreadable);
  try {
    const current = await resolveHeadlessExecutable(entry, resolution.chosen, process.getuid!(), 'recheck');
    const info = await file.stat({ bigint: true }).catch(unreadable);
    if (!info.isFile() || stamp(info) !== resolution.fileStamp || current.identity !== resolution.identity) changed();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
