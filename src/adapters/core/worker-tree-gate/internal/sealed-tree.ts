import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rmdir, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ErrorRegistry, privateDirectory, readPrivateFile } from '#platform/index.js';
import { WORKER_TREE_SHOWN_PATHS } from '#engine/index.js';
import { scanWorkerTree, type WorkerTreeGateOptions, type WorkerTreeKnownSecrets } from './scan.js';
import gate from './gate.json' with { type: 'json' };
import { capture, digest, refused, readFlags, SealedFileSizeError, type Entry, type TreeLimits, type TreeSelection } from './sealed-capture.js';
import { reserveSealedCapacity } from './sealed-capacity.js';

type Row = Omit<Entry, 'target'> & Readonly<{ target?: string; rules: readonly string[] }>;
type Manifest = Readonly<{ schemaVersion: 2; entries: readonly Row[] }>;
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const captureTree = (...args: Parameters<typeof capture>) => capture(...args).catch((error: unknown) => {
  if (error instanceof SealedFileSizeError) throw ErrorRegistry.createError(error.code, { params: { size: error.size, bound: error.bound } });
  throw refused();
});
const list = (tree: Awaited<ReturnType<typeof capture>>, rules = new Map<string, readonly string[]>()): Manifest => ({
  schemaVersion: 2, entries: tree.entries.map(entry => {
    const base = { path: entry.path, mode: entry.mode, kind: entry.kind, size: entry.size, digest: entry.digest };
    return { ...base, ...(entry.kind === 'link' ? { target: tree.targets.get(entry.path)! } : {}), rules: rules.get(entry.path) ?? [] };
  }),
});
const listDigest = (manifest: Manifest) => digest(text(manifest));

const text = (manifest: Manifest) => JSON.stringify(manifest);
const sealedMode = (entry: Pick<Row, 'kind' | 'mode'>) => entry.kind === 'directory' ? 0o500 : entry.kind === 'file' ? 0o400 | (entry.mode & 0o111) : 0o777;
const sealedManifest = (manifest: Manifest): Manifest => ({ schemaVersion: 2, entries: manifest.entries.map(entry => ({ ...entry, mode: sealedMode(entry) })) });

export async function inspectSealedWorkerTree(source: string, limits: TreeLimits) {
  const manifest = list(await captureTree(source, limits));
  return { digest: listDigest(manifest), manifest };
}

export function sealedWorkerTreeLocation(artifacts: string, identity: Readonly<{ layout: string; platform: string; project: string; workTarget: string;
  listDigest: string; lockfileDigest: string; approval: Readonly<{ scopeId: string }> }>) {
  const { layout, platform, project, workTarget, listDigest, lockfileDigest, approval } = identity;
  return join(artifacts, 'sealed-worker-inputs', digest(JSON.stringify([approval.scopeId, layout, platform, project, workTarget, listDigest, lockfileDigest])));
}

function patternRefusal(findings: readonly Readonly<{ path: string; rule: string }>[]) {
  return ErrorRegistry.createError('WORKER_TREE_SECRET_REFUSED', { params: {
    count: findings.length, paths: findings.slice(0, WORKER_TREE_SHOWN_PATHS).map(({ path, rule }) => `${path} (${rule})`).join(', '),
    omitted: Math.max(0, findings.length - WORKER_TREE_SHOWN_PATHS) } });
}

async function scan(source: string, label: string, entries: readonly Row[], options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets,
  collect?: Map<string, readonly string[]>, selectedSource = false) {
  const result = await scanWorkerTree([{ source, label, sealedPatterns: { entries,
    ...(collect ? { collect: (path, rules) => { collect.set(path, rules); }, selectedSource } : {}) } }], options, known)
    .catch(() => { throw refused(); });
  if (result.status === 'refused') throw patternRefusal(result.findings);
  if (result.status !== 'clean') throw ErrorRegistry.createError('WORKER_TREE_SCAN_INCOMPLETE');
}

/** The person's list may contain names and link text. Check it before displaying any of it. */
export async function reviewSealedWorkerTree(source: string, label: string, options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets, selection?: TreeSelection) {
  const observed = await captureTree(source, options, selection ? { selection } : {}), rules = new Map<string, readonly string[]>();
  await scan(source, label, list(observed).entries, options, known, rules, selection !== undefined);
  const checked = await captureTree(source, options, selection ? { selection } : {});
  if (listDigest(list(checked)) !== listDigest(list(observed))) throw refused();
  const manifest = list(checked, rules);
  if (Buffer.byteLength(text(manifest)) > gate.maxSealedListBytes) throw refused();
  return { digest: listDigest(manifest), manifest };
}

/** Publication renames a private, verified directory. An existing object is usable only through full verification. */
type SealedCapacity = Readonly<{ run<T>(store: string, work: () => Promise<T>): Promise<T>; maxBytes(): Promise<number> }>;

export function sealWorkerTree(source: string, object: string, label: string, approvedDigest: string, options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets,
  selection?: TreeSelection, capacity?: SealedCapacity) {
  const publish = () => publishSealedWorkerTree(source, object, label, approvedDigest, options, known, selection, capacity);
  const locks = join(dirname(dirname(object)), 'sealed-worker-input-locks');
  return capacity ? capacity.run(join(locks, basename(object)), publish) : publish();
}

async function publishSealedWorkerTree(source: string, object: string, label: string, approvedDigest: string, options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets,
  selection: TreeSelection | undefined, capacity: SealedCapacity | undefined) {
  const parentDirectory = dirname(object);
  if (!await privateDirectory(dirname(parentDirectory))) throw refused();
  await mkdir(parentDirectory, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw refused(); });
  if (!await privateDirectory(parentDirectory)) throw refused();
  const present = (error: unknown) => (error as NodeJS.ErrnoException).code !== 'ENOENT';
  if (await lstat(object).then(() => true, present)) {
    if (selection && (await reviewSealedWorkerTree(source, label, options, known, selection)).digest !== approvedDigest) throw refused();
    await reopenWorkerTree(object, label, approvedDigest, options, known);
    return { copyMs: 0, scanMs: 0, bytes: 0 };
  }
  const approved = capacity ? await reviewSealedWorkerTree(source, label, options, known, selection) : undefined;
  if (approved && approved.digest !== approvedDigest) throw refused();
  const reserved = approved && new Map(approved.manifest.entries.map(entry => [entry.path, entry]));
  const underCapacity = <T>(work: () => Promise<T>) => capacity ? capacity.run(parentDirectory, work) : work();
  const dirs: string[] = [], files: string[] = [];
  let stage: string | undefined, published = false;
  async function writeReceipt(directory: string, record: string) {
    const path = join(directory, 'manifest.json'), receipt = await open(path, createFlags, 0o400);
    files.push(path);
    try { await receipt.writeFile(record); await receipt.sync(); } finally { await receipt.close(); }
  }
  try {
    const started = performance.now();
    // A complete, charged private stage exists before releasing the store-wide capacity lock.
    const { directory, packages, observed, sourceList, verified } = await underCapacity(async () => {
      if (capacity && approved) {
        const sizes = [0, 0, Buffer.byteLength(text(approved.manifest)), ...approved.manifest.entries.map(entry => entry.size)];
        await reserveSealedCapacity(parentDirectory, await capacity.maxBytes(), sizes);
      }
      const directory = stage = await mkdtemp(join(parentDirectory, '.sealing-')), packages = join(directory, 'tree');
      dirs.push(packages);
      await mkdir(packages, { mode: 0o700 });
      const observed = await captureTree(source, options, { ...(selection ? { selection } : {}), async copy(entry, bytes) {
        const reservedEntry = reserved?.get(entry.path);
        if (reserved && (!reservedEntry || reservedEntry.kind !== entry.kind || reservedEntry.size !== entry.size || reservedEntry.digest !== entry.digest)) throw refused();
        const target = join(packages, entry.path);
        if (entry.kind === 'directory') { await mkdir(target, { mode: 0o700 }); dirs.push(target); }
        if (entry.kind === 'file') {
          const file = await open(target, createFlags, sealedMode(entry)); files.push(target);
          try { await file.writeFile(bytes!); await file.chmod(sealedMode(entry)); await file.sync(); } finally { await file.close(); }
        }
      } });
      const sourceList = list(observed), staged = list(await captureTree(packages, options, { independent: true }));
      if (approved && text(sourceList) !== text({ ...approved.manifest, entries: approved.manifest.entries.map(entry => ({ ...entry, rules: [] })) })) throw refused();
      const copied = sealedManifest(sourceList).entries.filter(entry => entry.kind !== 'link')
        .map(entry => entry.kind === 'directory' ? { ...entry, mode: 0o700 } : entry);
      if (text(staged) !== text({ schemaVersion: 2, entries: copied })) throw refused();
      for (const entry of observed.entries) if (entry.kind === 'link') {
        const target = join(packages, entry.path); await symlink(entry.target, target); files.push(target);
      }
      for (const directory of [...dirs].reverse()) {
        const handle = await open(directory, readFlags | constants.O_DIRECTORY);
        try { await handle.chmod(0o500); await handle.sync(); } finally { await handle.close(); }
      }
      const verified = list(await captureTree(packages, options, { independent: true }));
      if (text(verified) !== text(sealedManifest(sourceList))) throw refused();
      if (approved) await writeReceipt(directory, text(approved.manifest));
      return { directory, packages, observed, sourceList, verified };
    });
    const copyMs = performance.now() - started, scanStart = performance.now(), rules = new Map<string, readonly string[]>();
    await scan(packages, label, verified.entries, options, known, rules);
    const scanMs = performance.now() - scanStart, manifest = list(observed, rules), record = text(manifest);
    if (Buffer.byteLength(record) > gate.maxSealedListBytes) throw refused();
    if (listDigest(manifest) !== approvedDigest) {
      if (listDigest(sourceList) === approvedDigest) {
        const findings = manifest.entries.flatMap(entry => entry.rules.map(rule => ({ path: `${label}/${entry.path}`, rule })));
        if (findings.length) throw patternRefusal(findings);
      }
      throw refused();
    }
    if (text(list(await captureTree(packages, options, { independent: true }), rules)) !== text(sealedManifest(manifest))) throw refused();
    if (approved && record !== text(approved.manifest)) throw refused();
    if (!approved) await writeReceipt(directory, record);
    const handle = await open(directory, readFlags | constants.O_DIRECTORY);
    try { await handle.sync(); } finally { await handle.close(); }
    await underCapacity(async () => {
      if (!await lstat(object).then(() => true, present)) try { await rename(directory, object); published = true; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw refused(); }
    });
    if (published) {
      const parent = await open(dirname(object), readFlags | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    } else await reopenWorkerTree(object, label, approvedDigest, options, known);
    return { copyMs, scanMs, bytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0) };
  } finally {
    if (!published && stage) await underCapacity(async () => {
      for (const dir of dirs) await chmod(dir, 0o700).catch(() => undefined);
      for (const file of files) await unlink(file).catch(() => undefined);
      for (const dir of [...dirs].reverse()) await rmdir(dir).catch(() => undefined);
      await rmdir(stage!).catch(() => undefined);
    });
  }
}

/** Reopens the reference for integrity verification. The Attempt must also run the current admitted secret scan. */
export async function verifySealedWorkerTree(object: string, approvedDigest: string, options: TreeLimits) {
  const source = join(object, 'tree');
  const manifest = await (async () => {
    if (!await privateDirectory(object)) throw refused();
    const manifestPath = join(object, 'manifest.json');
    if (((await lstat(manifestPath)).mode & 0o222) || ((await lstat(source)).mode & 0o777) !== 0o500) throw refused();
    const raw = await readPrivateFile(manifestPath, gate.maxSealedListBytes, { mode: 'mask' });
    if (!raw || digest(raw) !== approvedDigest) throw refused();
    const stored = JSON.parse(raw.toString('utf8')) as Manifest;
    if (stored.schemaVersion !== 2) throw refused();
    return stored;
  })().catch(() => { throw refused(); });
  const verified = list(await captureTree(source, options, { independent: true }), new Map(manifest.entries.map(entry => [entry.path, entry.rules])));
  if (text(verified) !== text(sealedManifest(manifest))) throw refused();
  return { source, digest: approvedDigest, entries: verified.entries };
}

export async function reopenWorkerTree(object: string, label: string, approvedDigest: string, options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets) {
  const { source, digest, entries } = await verifySealedWorkerTree(object, approvedDigest, options);
  await scan(source, label, entries, options, known);
  return { source, digest };
}
