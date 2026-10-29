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
type Lookup = { readonly stat: BigIntStats | null } | { readonly error: unknown };
// Serial lstat/open/read round trips left one measurement of the ~3000-file package at ~2.3 s; the gain saturates near the default
// 4-thread libuv pool. In-flight work stays bounded by IO_PARALLEL operations, and read buffers by maxFileBytes as in a serial read.
const IO_PARALLEL = 8;
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
  const walk = async (absolute: string, path: string, depth: number, known?: Lookup): Promise<void> => {
    if (depth > cap.maxDepth) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
    if (known && 'error' in known) throw known.error;
    const stat = known ? known.stat : await statOrMissing(absolute);
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
    // Sibling lstats are looked up IO_PARALLEL at a time but consumed in name order, so the first refusal is the serial walk's.
    for (let start = 0; start < names.length; start += IO_PARALLEL) {
      const chunk = names.slice(start, start + IO_PARALLEL);
      const lookups = await Promise.all(chunk.map(name => statOrMissing(resolve(absolute, name)).then(stat => ({ stat }), (error: unknown) => ({ error }))));
      for (const [index, name] of chunk.entries()) {
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
          || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_UNSAFE');
        await walk(resolve(absolute, name), `${path}/${name}`, depth + 1, lookups[index]);
      }
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
    await walk(absolute, declaration, 1, { stat });
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

// Reads run up to IO_PARALLEL files wide while their buffers together stay within maxFileBytes, the serial read's own peak; a file that
// does not fit waits for the others. Order, byte budgets and the reported failure (the lowest-index failing file) stay those of the
// serial read: a file's budget comes from the walked sizes of the files before it.
async function readEntries(entries: readonly Entry[], packageStat: BigIntStats, packageFile: MeasuredPackageFile, cap: PackageMeasurementLimits) {
  const files: MeasuredPackageFile[] = new Array<MeasuredPackageFile>(entries.length), failures = new Map<number, unknown>(), running = new Set<Promise<void>>();
  let total = packageFile.size, next = 0, inFlightBytes = 0;
  const budgets = entries.map(entry => { if (entry.path === 'package.json') return 0; const budget = cap.maxTotalBytes - total; total += Number(entry.stat.size); return budget; });
  while (next < entries.length && failures.size === 0) {
    const index = next, entry = entries[index]!, size = Number(entry.stat.size);
    if (running.size >= IO_PARALLEL || (inFlightBytes > 0 && inFlightBytes + size > cap.maxFileBytes)) { await Promise.race(running); continue; }
    next++;
    if (entry.path === 'package.json') {
      if (generation(entry.stat) !== generation(packageStat)) failures.set(index, new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED'));
      else files[index] = packageFile;
      continue;
    }
    inFlightBytes += size;
    const task: Promise<void> = stableRead(entry, cap, budgets[index]!).then(read => { files[index] = read.measurement; }, (error: unknown) => { failures.set(index, error); })
      .finally(() => { inFlightBytes -= size; running.delete(task); });
    running.add(task);
  }
  await Promise.all(running);
  if (failures.size) throw failures.get(Math.min(...failures.keys()));
  return files;
}

/** Staged distribution v1 adds a complete unpacked inventory and its release record. Both records are themselves measured,
 * never exempted from the mounted distribution. package.files is npm's inclusion list; this inventory pins actual files. */
async function stagedInventory(root: string, cap: PackageMeasurementLimits, packageVersion: string) {
  const metadata = ['manifest.json', 'release.json'];
  const stats = await Promise.all(metadata.map(path => statOrMissing(resolve(root, path))));
  if (stats.every(stat => stat === null)) return null;
  if (stats.some(stat => stat === null)) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  let remaining = cap.maxTotalBytes;
  const records = [];
  for (const [index, path] of metadata.entries()) {
    const read = await stableRead({ path, absolute: resolve(root, path), stat: stats[index]! }, cap, remaining);
    remaining -= read.measurement.size; records.push(read);
  }
  const parse = (bytes: Buffer): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* A malformed release inventory is never an ordinary package fallback. */ }
    throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  };
  const manifest = parse(records[0]!.bytes), release = parse(records[1]!.bytes);
  if (release['schemaVersion'] !== 1 || release['packageVersion'] !== packageVersion || release['manifestSha256'] !== records[0]!.measurement.sha256
    || !Object.hasOwn(manifest, 'package.json')) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
  const expected = new Map<string, string>();
  for (const [path, hashMode] of Object.entries(manifest)) {
    safeDeclaration(path);
    if (metadata.includes(path) || typeof hashMode !== 'string' || !/^[a-f0-9]{64}:[0-7]{1,3}$/.test(hashMode)) {
      throw new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID');
    }
    expected.set(path, hashMode);
    if (expected.size + metadata.length > cap.maxFiles) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_LIMIT');
  }
  // Walk each inventory root once, keeping the bounded sibling I/O instead of repeating every ancestor per file.
  return { declarations: [...new Set([...expected.keys()].map(path => path.split('/')[0]!)), ...metadata], expected, metadata: records.map(record => record.measurement) };
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
  const staged = await stagedInventory(root, cap, record['version']);
  const measuredDeclarations = staged?.declarations ?? declarations;
  const before = await tree(root, measuredDeclarations, cap);
  const files = await readEntries(before.entries, packageStat, initialPackage.measurement, cap);
  if (staged) for (const file of files) {
    const expected = staged.expected.get(file.path), metadata = staged.metadata.find(entry => entry.path === file.path);
    if (expected !== undefined ? expected !== `${file.sha256}:${file.mode.toString(8)}` : !metadata || metadata.sha256 !== file.sha256 || metadata.mode !== file.mode) {
      throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
    }
  }
  const after = await tree(root, measuredDeclarations, cap);
  if (JSON.stringify(before.observed) !== JSON.stringify(after.observed) || JSON.stringify(before.missing) !== JSON.stringify(after.missing)
    || files.find(file => file.path === 'package.json')?.sha256 !== initialPackage.measurement.sha256) throw new InstallationArtifactError('INSTALLATION_ARTIFACT_CHANGED');
  const present = new Set(files.map(file => file.path));
  const missing = staged ? [...staged.expected.keys(), ...staged.metadata.map(file => file.path)].filter(path => !present.has(path)).sort() : before.missing;
  const evidence = { schemaVersion: 1 as const, packageName: record['name'], packageVersion: record['version'], files: Object.freeze(files),
    declaredMissing: Object.freeze(missing), dependencyCoverage: 'excluded' as const, origin: 'installed-bytes' as const };
  const measurementDigest = digest(`deckent.installed-package.v1\n${JSON.stringify(evidence)}`);
  return Object.freeze({ ...evidence, measurementDigest });
}
