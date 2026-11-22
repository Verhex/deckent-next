import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { ErrorRegistry, isCodedError } from '#platform/index.js';
import { inspectPreparedInputEntry } from '#adapters/core/worker-tree-gate/index.js';
import type { cachedNpmInventory } from './npm-archive.js';
import { packageFile, packageSlot, readNpmLock, relativePackagePath, standardPackage, type LockEntry, type PreparedRow } from './npm-package-list.js';

type Package = Readonly<{ lock: LockEntry; files: Map<string, string> }>;
const refuse = (): never => { throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED'); };

async function localExecutable(source: string, packages: ReadonlyMap<string, Package>, pkg: Package, path: string) {
  const installed = await inspectPreparedInputEntry(join(source, path));
  if (!installed?.info.isFile() || installed.info.nlink < 2n) return null;
  for (const [name, version] of Object.entries(pkg.lock.optionalDependencies ?? {})) {
    const dependency = packages.get(name);
    if (!dependency || dependency.lock.version !== version) continue;
    for (const [file, digest] of dependency.files) {
      if (!packageFile(file)) continue;
      const linkedFrom = `${name}/${file}`, candidate = await inspectPreparedInputEntry(join(source, linkedFrom));
      if (candidate?.info.isFile() && candidate.info.dev === installed.info.dev && candidate.info.ino === installed.info.ino)
        return { path, digest, linkedFrom };
    }
  }
  return null;
}

/** Select installed, lock-pinned package content. Every proposed row goes through the normal verifier before it is written. */
export async function makeNpmPackageList(source: string, root: string, lockBytes: Buffer, maxFiles: number, maxListBytes: number,
  archive: ReturnType<typeof cachedNpmInventory>) {
  try {
    const lock = readNpmLock(lockBytes), packages = new Map<string, Package>(), bins = new Set<string>(), rows = new Map<string, PreparedRow>();
    const record = (row: PreparedRow) => {
      if (!rows.has(row.path) && rows.size >= maxFiles) return refuse();
      rows.set(row.path, row);
    };
    for (const [path, entry] of Object.entries(lock)) {
      if (!path.startsWith(`${root}/`)) continue;
      const directory = path.slice(root.length + 1);
      if (!relativePackagePath(directory) || !directory.split('/node_modules/').every(slot => standardPackage.test(slot))) return refuse();
      const installed = await inspectPreparedInputEntry(join(source, directory, 'package.json'));
      if (!installed) continue;
      if (!installed.info.isFile() || entry.link || !entry.version || !entry.integrity) return refuse();
      packages.set(directory, { lock: entry, files: await archive(entry.integrity, path) });
    }
    for (const [directory, pkg] of packages) {
      for (const [file, digest] of pkg.files) {
        if (packageFile(file)) record({ path: `${directory}/${file}`, digest });
      }
      for (const [bin, entry] of Object.entries(pkg.lock.bin ?? {})) {
        const executable = entry.replace(/^\.\//u, '');
        if (!relativePackagePath(bin) || posix.basename(bin) !== bin || !packageFile(executable)) return refuse();
        if (packageSlot(directory) === directory) bins.add(bin);
        if (pkg.lock.hasInstallScript) {
          const generated = await localExecutable(source, packages, pkg, `${directory}/${executable}`);
          if (generated) record(generated);
        }
      }
    }
    for (const bin of bins) {
      const path = `.bin/${bin}`, link = await inspectPreparedInputEntry(join(source, path), true);
      if (!link) continue;
      if (!link.target) return refuse();
      record({ path, digest: createHash('sha256').update(link.target).digest('hex') });
    }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entries: [...rows.values()].sort((a, b) => a.path < b.path ? -1 : 1) }) + '\n');
    return bytes.length <= maxListBytes ? bytes : refuse();
  } catch (error) {
    if (isCodedError(error, 'NATIVE_WORKER_DEPENDENCIES_REFUSED')) throw error;
    return refuse();
  }
}
