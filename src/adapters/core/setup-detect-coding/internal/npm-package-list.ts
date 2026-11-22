import { posix } from 'node:path';
import { ErrorRegistry, isCodedError } from '#platform/index.js';
import type { TreeSelection, TreeSelectionEntry } from '#adapters/core/worker-tree-gate/index.js';
import type { cachedNpmInventory } from './npm-archive.js';

export type LockEntry = Readonly<{ name?: string; version?: string; integrity?: string; link?: boolean; bin?: Record<string, string>; hasInstallScript?: boolean; optionalDependencies?: Record<string, string> }>;
export type PreparedRow = Readonly<{ path: string; digest: string; linkedFrom?: string }>;
const refuse = (): never => { throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED'); };
export const relativePackagePath = (path: unknown): path is string => typeof path === 'string' &&
  !/[\\\p{Cc}\p{Cf}]/u.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..');
const NPM_LOCKFILE_VERSION = 3;
export const standardPackage = /^(?:@[^/.][^/]*\/)?[^/.@][^/]*$/u;
export const packageSlot = (directory: string) => directory.split('/node_modules/').at(-1)!;
export const packageFile = (path: string) => relativePackagePath(path) &&
  !path.split('/').some(part => part === 'node_modules' || part === '.bin' || part === '.package-lock.json' || part === '.vitest-cache');
export function readNpmLock(bytes: Buffer) {
  const lock = JSON.parse(bytes.toString('utf8')) as { lockfileVersion: number; packages: Record<string, LockEntry> };
  if (lock.lockfileVersion !== NPM_LOCKFILE_VERSION || !lock.packages || Array.isArray(lock.packages) || typeof lock.packages !== 'object') return refuse();
  return lock.packages;
}

/** The committed lock fixes package identities and the person's committed list fixes the selected file digests. */
export async function npmPackageSelection(root: string, lockBytes: Buffer, listBytes: Buffer, maxFiles: number,
  archive: ReturnType<typeof cachedNpmInventory>): Promise<TreeSelection> {
  try {
    const packages = readNpmLock(lockBytes);
    const prepared = JSON.parse(listBytes.toString('utf8')) as { schemaVersion: number; entries: PreparedRow[] };
    if (prepared.schemaVersion !== 1 || !Array.isArray(prepared.entries) ||
      !prepared.entries.length || prepared.entries.length > maxFiles) return refuse();
    const entries = new Map<string, TreeSelectionEntry>();
    const bins: string[] = [], selected = new Map<string, LockEntry>();
    const files = new Map<string, { row: PreparedRow; directory: string; local: string }>();
    for (const row of prepared.entries) {
      if (!row || !relativePackagePath(row.path) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.digest) || entries.has(row.path)) return refuse();
      if (posix.dirname(row.path) === '.bin') {
        if (row.linkedFrom !== undefined) return refuse();
        bins.push(row.path);
        entries.set(row.path, { kind: 'link', digest: row.digest });
        continue;
      }
      let directory = posix.dirname(row.path);
      while (directory !== '.' && !Object.hasOwn(packages, `${root}/${directory}`)) directory = posix.dirname(directory);
      const pkg = packages[`${root}/${directory}`], slot = packageSlot(directory);
      const local = row.path.slice(directory.length + 1);
      if (directory === '.' || !pkg || pkg.link || !pkg.version || !pkg.integrity || !standardPackage.test(slot) ||
        !packageFile(local)) return refuse();
      selected.set(directory, pkg);
      files.set(row.path, { row, directory, local });
      entries.set(row.path, { kind: 'file', digest: row.digest, ...(local === 'package.json' ? { check(bytes: Buffer) {
        const installed = JSON.parse(bytes.toString('utf8')) as { name?: string; version?: string };
        if (installed.name !== (pkg.name ?? slot) || installed.version !== pkg.version) return refuse();
      } } : {}) });
    }
    const published = new Set<string>();
    const grouped = new Map<string, typeof files>();
    for (const [path, file] of files) {
      const group = grouped.get(file.directory) ?? new Map();
      group.set(path, file); grouped.set(file.directory, group);
    }
    for (const [dir, pkg] of selected) {
      if (!entries.has(`${dir}/package.json`)) return refuse();
      const inventory = await archive(pkg.integrity!, `${root}/${dir}`);
      for (const [path, { local, row }] of grouped.get(dir)!) {
        if (row.linkedFrom !== undefined) continue;
        if (inventory.get(local) !== row.digest) return refuse();
        published.add(path);
      }
    }
    // npm postinstall may replace a declared executable with a hard name of a locked optional dependency's published binary.
    for (const [path, { row, local, directory }] of files) {
      if (row.linkedFrom === undefined) continue;
      const source = files.get(row.linkedFrom), pkg = selected.get(directory)!;
      if (!source || !published.has(row.linkedFrom) || source.directory === directory || source.row.digest !== row.digest ||
        !pkg.hasInstallScript || !Object.values(pkg.bin ?? {}).some(bin => bin.replace(/^\.\//u, '') === local) ||
        pkg.optionalDependencies?.[source.directory] !== selected.get(source.directory)?.version ||
        !Object.hasOwn(pkg.optionalDependencies ?? {}, source.directory)) return refuse();
      entries.set(path, { ...entries.get(path)!, sameAs: row.linkedFrom });
    }
    for (const path of bins) {
      const bin = posix.basename(path);
      const candidates = [...selected].flatMap(([dir, pkg]) => {
        const relativeTarget = Object.hasOwn(pkg.bin ?? {}, bin) ? pkg.bin?.[bin] : undefined;
        const target = relativeTarget?.replace(/^\.\//u, '');
        return relativePackagePath(target) && !dir.includes('/node_modules/') && entries.get(`${dir}/${target}`)?.kind === 'file' ? [`${dir}/${target}`] : [];
      });
      if (!candidates.length) return refuse();
      entries.set(path, { ...entries.get(path)!, targets: candidates });
    }
    for (const path of entries.keys()) {
      for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
        const entry = entries.get(parent);
        if (entry?.kind === 'directory') break;
        if (entry || entries.size >= maxFiles) return refuse();
        entries.set(parent, { kind: 'directory' });
      }
    }
    return entries;
  } catch (error) {
    if (isCodedError(error, 'NATIVE_WORKER_DEPENDENCIES_REFUSED')) throw error;
    return refuse();
  }
}
