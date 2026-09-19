import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export interface PackageMeasurementLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly maxDepth: number }
export interface MeasuredPackageFile { readonly path: string; readonly size: number; readonly sha256: string; readonly mode: number; readonly executable: boolean }
export interface InstalledPackageMeasurement {
  readonly schemaVersion: 1; readonly packageName: string; readonly packageVersion: string;
  readonly files: readonly MeasuredPackageFile[]; readonly declaredMissing: readonly string[];
  readonly dependencyCoverage: 'excluded'; readonly origin: 'installed-bytes'; readonly measurementDigest: string;
}
export type InstallationArtifactErrorCode = 'INSTALLATION_ARTIFACT_INVALID' | 'INSTALLATION_ARTIFACT_UNSAFE'
  | 'INSTALLATION_ARTIFACT_LIMIT' | 'INSTALLATION_ARTIFACT_CHANGED' | 'INSTALLATION_ARTIFACT_UNAVAILABLE';
export class InstallationArtifactError extends Error {
  constructor(readonly code: InstallationArtifactErrorCode) { super(code); this.name = 'InstallationArtifactError'; }
}

interface Entry { readonly path: string; readonly absolute: string; readonly stat: BigIntStats }
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function limits(input: PackageMeasurementLimits) {
  if (!input || ![input.maxFiles, input.maxFileBytes, input.maxTotalBytes, input.maxDepth]
    .every(value => Number.isSafeInteger(value) && value > 0)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  return input;
}
function safeDeclaration(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[*?[\]{}]/.test(value)
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || parts[0] === 'node_modules' || parts[0]?.startsWith('.')) {
    throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
  }
  return parts.join('/');
}
function generation(stat: BigIntStats) {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function assertRegular(stat: BigIntStats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
}
async function statOrMissing(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNAVAILABLE');
  }
}
async function tree(root: string, declarations: readonly string[], cap: PackageMeasurementLimits) {
  const entries = new Map<string, Entry>(), observed = new Map<string, string>(), missing: string[] = [];
  const observe = (path: string, stat: BigIntStats) => {
    if (!observed.has(path) && observed.size >= cap.maxFiles) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
    observed.set(path, generation(stat));
  };
  const add = (path: string, absolute: string, stat: BigIntStats) => {
    if (entries.has(path)) return;
    entries.set(path, { path, absolute, stat });
  };
  const walk = async (absolute: string, path: string, depth: number, known?: BigIntStats): Promise<void> => {
    if (depth > cap.maxDepth) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
    const stat = known ?? await statOrMissing(absolute);
    if (!stat) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
    if (stat.isSymbolicLink()) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
    observe(path, stat);
    if (stat.isFile()) { assertRegular(stat); add(path, absolute, stat); return; }
    if (!stat.isDirectory()) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
    const names: string[] = [];
    try { const directory = await opendir(absolute); try { for await (const child of directory) {
      if (names.length + observed.size >= cap.maxFiles) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT'); names.push(child.name);
    } } finally { await directory.close().catch(() => undefined); } }
    catch (error) { if (error instanceof InstallationArtifactError) throw error; throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNAVAILABLE'); }
    names.sort();
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
        || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
      await walk(resolve(absolute, name), `${path}/${name}`, depth + 1);
    }
  };
  const rootStat = await statOrMissing(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new InstallationArtifactError(rootStat ? 'INSTALLATION_ARTIFACT_UNSAFE' : 'INSTALLATION_ARTIFACT_UNAVAILABLE');
  observe('', rootStat);
  const packageStat = await statOrMissing(resolve(root, 'package.json'));
  if (!packageStat) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNAVAILABLE');
  assertRegular(packageStat); observe('package.json', packageStat); add('package.json', resolve(root, 'package.json'), packageStat);
  for (const declaration of declarations) {
    let absolute = root, stat: BigIntStats | null = null, missingPath = false;
    const parts = declaration.split('/');
    for (let index = 0; index < parts.length; index++) {
      absolute = resolve(absolute, parts[index]!); stat = await statOrMissing(absolute);
      if (!stat) { missingPath = true; break; }
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
      observe(parts.slice(0, index + 1).join('/'), stat);
    }
    const within = relative(root, absolute);
    if (!within || within === '..' || within.startsWith(`..${sep}`)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
    if (missingPath || !stat) { missing.push(declaration); continue; }
    await walk(absolute, declaration, 1, stat);
  }
  return { entries: [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), missing: [...new Set(missing)].sort(),
    observed: [...observed].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
}
async function stableRead(entry: Entry, cap: PackageMeasurementLimits, remaining = cap.maxTotalBytes): Promise<{ readonly measurement: MeasuredPackageFile; readonly bytes: Buffer }> {
  assertRegular(entry.stat);
  if (entry.stat.size > BigInt(cap.maxFileBytes) || entry.stat.size > BigInt(remaining)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
  let handle;
  try {
    handle = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = await handle.stat({ bigint: true });
    assertRegular(opened);
    if (generation(opened) !== generation(entry.stat)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
    if (opened.size > BigInt(cap.maxFileBytes) || opened.size > BigInt(remaining)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    const after = await handle.stat({ bigint: true }), named = await lstat(entry.absolute, { bigint: true }); assertRegular(after); assertRegular(named);
    if (offset !== bytes.length || generation(after) !== generation(opened) || generation(named) !== generation(opened)) {
      throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
    }
    const mode = Number(opened.mode & 0o777n);
    return { measurement: Object.freeze({ path: entry.path, size: bytes.length, sha256: digest(bytes), mode, executable: (mode & 0o111) !== 0 }), bytes };
  } catch (error) {
    if (error instanceof InstallationArtifactError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new InstallationArtifactError(code === 'ELOOP' ? 'INSTALLATION_ARTIFACT_UNSAFE' : code === 'ENOENT' ? 'INSTALLATION_ARTIFACT_CHANGED' : 'INSTALLATION_ARTIFACT_UNAVAILABLE');
  } finally { await handle?.close(); }
}

export async function measureInstalledPackage(rootInput: string, inputLimits: PackageMeasurementLimits): Promise<InstalledPackageMeasurement> {
  if (typeof rootInput !== 'string' || !rootInput) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const root = resolve(rootInput), cap = limits(inputLimits);
  const rootStat = await statOrMissing(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new InstallationArtifactError(rootStat ? 'INSTALLATION_ARTIFACT_UNSAFE' : 'INSTALLATION_ARTIFACT_UNAVAILABLE');
  const packageStat = await statOrMissing(resolve(root, 'package.json'));
  if (!packageStat) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNAVAILABLE');
  const initialPackage = await stableRead({ path: 'package.json', absolute: resolve(root, 'package.json'), stat: packageStat }, cap);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(initialPackage.bytes)); }
  catch { throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const record = raw as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || !record['name'] || typeof record['version'] !== 'string' || !record['version']
    || !Array.isArray(record['files']) || !record['files'].length) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const declarations = record['files'].map(safeDeclaration);
  if (new Set(declarations).size !== declarations.length) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const before = await tree(root, declarations, cap); const files: MeasuredPackageFile[] = [];
  let total = initialPackage.measurement.size;
  for (const entry of before.entries) {
    if (entry.path === 'package.json') { if (generation(entry.stat) !== generation(packageStat)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
      files.push(initialPackage.measurement); continue; }
    const measured = (await stableRead(entry, cap, cap.maxTotalBytes - total)).measurement; total += measured.size; files.push(measured);
  }
  const after = await tree(root, declarations, cap);
  if (JSON.stringify(before.observed) !== JSON.stringify(after.observed) || JSON.stringify(before.missing) !== JSON.stringify(after.missing)
    || files.find(file => file.path === 'package.json')?.sha256 !== initialPackage.measurement.sha256) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
  const evidence = { schemaVersion: 1 as const, packageName: record['name'], packageVersion: record['version'], files: Object.freeze(files),
    declaredMissing: Object.freeze(before.missing), dependencyCoverage: 'excluded' as const, origin: 'installed-bytes' as const };
  const measurementDigest = digest(`deckent.installed-package.v1\n${JSON.stringify(evidence)}`);
  return Object.freeze({ ...evidence, measurementDigest });
}
