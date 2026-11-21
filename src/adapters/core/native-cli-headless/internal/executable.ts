import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorRegistry } from '#platform/index.js';
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
    if (bytesRead > maxBytes || stamp(info) !== stamp(await file.stat({ bigint: true }))) throw new Error();
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

/** Diagnose package scripts declared as npm commands. A package may also expose a standalone binary. */
async function npmLauncherRelation(launcher: string, maxBytes: number): Promise<'none' | 'launcher' | 'undetermined'> {
  const parts = launcher.split(sep), modules = parts.lastIndexOf('node_modules');
  const packageEnd = modules + (parts[modules + 1]?.startsWith('@') ? 3 : 2);
  if (modules < 0 || packageEnd >= parts.length) return 'none';
  const packageRoot = parts.slice(0, packageEnd).join(sep);
  const manifest = await metadata(join(packageRoot, 'package.json'), maxBytes).catch(() => null);
  if (!manifest) return 'undetermined';
  const bin = manifest.value?.bin;
  const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
  if (!targets.some(path => typeof path === 'string' && !isAbsolute(path) && resolve(packageRoot, path) === launcher)) return 'none';
  const file = await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!file) return 'none';
  try {
    if (!(await file.stat()).isFile()) return 'none';
    const header = Buffer.alloc(2);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('ascii') === '#!' ? 'launcher' : 'none';
  } catch { return 'none'; }
  finally { await file.close(); }
}

export async function resolveHeadlessExecutable(entry: HeadlessEntry, chosen: string, ownerUid: number): Promise<HeadlessExecutable> {
  const launcher = await realpath(chosen).catch(() => null), launcherInfo = launcher ? await infoAt(launcher).catch(() => null) : null;
  if (!launcher || !launcherInfo?.isFile() || (launcherInfo.mode & 0o111n) === 0n) refuse('HEADLESS_CLI_UNAVAILABLE');
  const chosenInfo = await infoAt(chosen).catch(() => null);
  if (!chosenInfo) refuse('HEADLESS_CLI_UNAVAILABLE');
  const rule = entry.command.npmLauncher, suffix = rule && `/${rule.packagePath}/${rule.launcherPath}`;
  const target = rule && suffix && launcher.endsWith(suffix)
    ? await npmTarget(rule, chosen, launcher, launcher.slice(0, -suffix.length) || sep, ownerUid, launcherInfo, entry.headless.limits.preflightOutputBytes) : undefined;
  if (!target && await npmLauncherRelation(launcher, entry.headless.limits.preflightOutputBytes) !== 'none')
    headlessExecutableRefusal('npm-layout-unknown', chosen);
  const executable = target?.executable ?? launcher, info = target?.info ?? launcherInfo, fileStamp = stamp(info);
  return Object.freeze({ chosen, executable, fileStamp, size: Number(info.size), mtimeMs: Number(info.mtimeMs), ...(target ? { packageRoot: target.packageRoot } : {}),
    identity: digest([chosen, stamp(chosenInfo), launcher, stamp(launcherInfo), target?.packageIdentity, executable, fileStamp]) });
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
