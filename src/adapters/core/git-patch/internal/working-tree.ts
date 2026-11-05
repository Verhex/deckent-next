import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { recordedProcessState } from '#platform/index.js';
import { patchDigest, SnapshotBudget, WorkspacePatchError, type IntegrationDeliveryCommand, type IntegrationDeliveryPlan, type IntegrationDeliveryTarget, type IntegrationManifest,
  type IntegrationCommitMetadata, type PatchFile, type PatchLimits, type WorkspacePatch } from '#engine/index.js';
import { GitIntegrationDelivery } from './delivery.js';
import format from './working-tree-format.json' with { type: 'json' };
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
const unsafe = () => { throw new WorkspacePatchError('PATCH_UNSAFE'); };

/** One repository-relative file below `root`, opened through descriptors (no symlink, special file, hard link or foreign owner on the way);
 * null when it or a parent is absent. A file that changes while it is read is PATCH_CONFLICT. */
export async function readTreeFile(root: FileHandle, path: string, budget: SnapshotBudget) {
  budget.entry(); budget.path(path);
  const parts = path.split('/'); let parent = root; const opened: FileHandle[] = [];
  try {
    for (let index = 0; index < parts.length; index++) {
      const directory = index < parts.length - 1;
      let handle: FileHandle;
      try { handle = await open(`/proc/self/fd/${parent.fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)); }
      catch (error) { if (code(error) === 'ENOENT') return null; throw new WorkspacePatchError('PATCH_UNSAFE'); }
      opened.push(handle); const before = await handle.stat();
      if (before.uid !== process.getuid!()) throw new WorkspacePatchError('PATCH_UNSAFE');
      if (directory) { if (!before.isDirectory()) throw new WorkspacePatchError('PATCH_UNSAFE'); parent = handle; continue; }
      if (!before.isFile() || before.nlink !== 1) throw new WorkspacePatchError('PATCH_UNSAFE');
      budget.size(before.size);
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        budget.time(); const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break; offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || after.size !== before.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || after.nlink !== 1)
        throw new WorkspacePatchError('PATCH_CONFLICT');
      return { bytes, mode: before.mode & 0o111 ? '100755' as const : '100644' as const, permissions: before.mode & 0o7777 };
    }
    throw new WorkspacePatchError('PATCH_UNSAFE');
  } finally { for (const handle of opened.reverse()) await handle.close(); }
}
/** A file's observed state (absent, or content digest and Git mode): what the journal keeps and the one equality both writing and settling use. */
type Observed = Pick<PatchFile, 'digest' | 'mode'> | null; type Read = (path: string) => ReturnType<typeof readTreeFile>;
/** R1 (Astra 3017): a file moved aside that stays in the checkout (journal directory on another filesystem), with the state it was compared at. */
type SetAside = { path: string; expected: Observed; atMs: number }; type Custody = { journal: string; kept: string[]; setAside: SetAside[] };
type Journal = { state?: unknown; root?: unknown; changes: { path: string; token?: unknown; before: Observed; after: Observed }[]; setAside?: SetAside[] };
const observed = (file: Observed): Observed => file && { digest: file.digest, mode: file.mode };
const holds = (file: Awaited<ReturnType<typeof readTreeFile>> | false, expected: Observed) =>
  file === null ? expected === null : !!file && expected !== null && file.mode === expected.mode && patchDigest(file.bytes) === expected.digest;
const names = (token: string) => ['.tmp', '.aside', '.ours'].map(suffix => `${format.aside}${token}${suffix}`) as [string, string, string];
const JOURNAL = /^[0-9a-f]{64}(\.rollback)?$/, ENTRY = new RegExp(`^${format.aside.replace(/\./g, '\\.')}[0-9a-f-]{36}\\.(aside|ours)$`);
const unsupported = (path: string) => new WorkspacePatchError('PATCH_WORKING_TREE_RECORD_UNSUPPORTED', undefined, { path });
/** A delivery's journal (null when absent). R3017: a record of another version is an explicit refusal, never settled or written over. */
async function journalAt(directory: string) {
  let journal: { schemaVersion?: unknown; changes?: unknown }; try { journal = JSON.parse(await readFile(join(directory, format.journal), 'utf8')) as typeof journal; } catch (error) { if (code(error) === 'ENOENT') return null; throw new WorkspacePatchError('PATCH_CORRUPT'); }
  if (journal?.schemaVersion !== format.journalVersion || !Array.isArray(journal.changes)) throw unsupported(directory);
  return journal as Journal;
}
/** The directory holding `path`, opened through descriptors (owned, no symlink); created on the way when `create`, else null when absent. */
async function directoryOf(root: FileHandle, path: string, create: boolean, handles: FileHandle[]) {
  let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    const at = `/proc/self/fd/${parent.fd}/${part}`;
    if (create) await mkdir(at).catch((error: unknown) => { if (code(error) !== 'EEXIST') unsafe(); });
    try { parent = await open(at, DIRECTORY); } catch (error) { if (!create && code(error) === 'ENOENT') return null; unsafe(); }
    handles.push(parent); if ((await parent.stat()).uid !== process.getuid!()) unsafe();
  }
  return parent;
}
/** F1 (Astra 3015): an entry Deckent moved aside from `path` goes back only by a no-clobber link (a filled name is never written over: it is kept and
 * named) and leaves only while it holds `expected`, as the very inode into the journal directory; R1 (Astra 3017): on another filesystem it is never
 * unlinked but stays, named in the journal and to the person, for `sweepSetAside`. */
function entries(parent: FileHandle, path: string, read: Read, custody: Custody) {
  const dir = path.slice(0, path.lastIndexOf('/') + 1), name = path.slice(dir.length), at = (entry: string) => `/proc/self/fd/${parent.fd}/${entry}`;
  const same = (entry: string, expected: Observed) => read(dir + entry).then(file => holds(file, expected), () => false);
  const retire = (entry: string, expected: Observed) => rename(at(entry), join(custody.journal, entry))
    .catch((error: unknown) => { if (code(error) !== 'EXDEV') throw error; custody.setAside.push({ path: dir + entry, expected, atMs: Date.now() }); });
  const recover = async (entry: string, expected: Observed) => {
    try { await link(at(entry), at(name)); } catch (error) {
      if (code(error) === 'ENOENT') return;
      const [moved, held] = code(error) === 'EEXIST' ? await Promise.all([lstat(at(entry)), lstat(at(name))]) : [];
      if (moved && held && moved.ino === held.ino && moved.dev === held.dev) return unlink(at(entry)); // a crash between the link back and its unlink
      if (code(error) === 'EEXIST' && await same(entry, expected)) return retire(entry, expected);
      custody.kept.push(dir + entry); return;
    }
    await unlink(at(entry));
  };
  return { at, name, same, retire, recover };
}
const syncDirectory = async (directory: string) => { const handle = await open(directory, DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } };
/** A small private record replaced atomically (0600 temporary file, fsync, rename, directory fsync). */
async function record(directory: string, name: string, data: string | Uint8Array) {
  const temporary = join(directory, `.${randomUUID()}.tmp`), file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(directory, name)); await syncDirectory(directory);
}
/** R1 (Astra 3017), the controlled cleanup: a set-aside file recorded before `since` is unlinked only while it still holds the state it was set aside
 * with; a changed, unreadable or unreachable one stays, counted and still named in its journal; one already gone is dropped from it. */
export async function sweepSetAside(workspaceRoot: string, since: number, limits: PatchLimits, timeoutMs: number) {
  const deliveries = join(workspaceRoot, format.deliveries), result = { removed: 0, kept: 0 };
  for (const name of (await readdir(deliveries).catch(() => [] as string[])).filter(name => JOURNAL.test(name))) {
    const directory = join(deliveries, name), journal = await journalAt(directory).catch(() => null), due = journal?.setAside?.filter(entry => entry.atMs < since) ?? []; if (!journal || !due.length) continue;
    const root = typeof journal.root === 'string' ? await open(journal.root, DIRECTORY).catch(() => null) : null, left = journal.setAside!.filter(entry => !due.includes(entry));
    try { for (const entry of due) {
      const handles: FileHandle[] = [], base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      try {
        const parent = root && ENTRY.test(base) ? await directoryOf(root, entry.path, false, handles).catch(() => null) : null;
        const file = parent ? await readTreeFile(root!, entry.path, new SnapshotBudget(limits, Date.now() + timeoutMs)).catch(() => false as const) : false;
        if (file !== null && holds(file, entry.expected)) { await unlink(`/proc/self/fd/${parent!.fd}/${base}`); result.removed++; } else if (file !== null) { left.push(entry); result.kept++; }
      } finally { for (const handle of handles.reverse()) await handle.close(); }
    } } finally { await root?.close(); }
    await record(directory, format.journal, JSON.stringify({ ...journal, setAside: left }));
  }
  return result;
}
/** Owner 2026-11-05 (R9p): a person's yes writes the accepted patch into the checkout's files (nothing in their repository), one delivery or rollback at a
 * time per checkout, never over or unlinking a file saved meanwhile; `publish`/`rollback` return the files set aside (R1, Astra 3017) for the person's
 * note. Protocol, crash recovery and limits: ARCHITECTURE approval-and-delivery.md "Working-tree delivery"; plan and diff are `delegate`'s. */
export class GitWorkingTreeDelivery implements IntegrationDeliveryTarget {
  readonly application = 'working-tree' as const;
  private readonly delegate: GitIntegrationDelivery;
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits) { this.delegate = new GitIntegrationDelivery(options); }
  plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch, metadata: IntegrationCommitMetadata) { return this.delegate.plan(command, manifest, patch, metadata); }
  describe(from: string, to: string) { return this.delegate.describe(from, to); }
  /** The plan's reference names this delivery's private journal (a rollback's: beside it); never written to the person's repository. */
  private journal(ref: string, suffix = '') { return join(this.options.workspaceRoot, format.deliveries, ref.slice(ref.lastIndexOf('/') + 1) + suffix); }
  async delivered(plan: IntegrationDeliveryPlan) { return (await journalAt(this.journal(plan.ref)))?.state === 'written'; }
  publish(plan: IntegrationDeliveryPlan, _manifest: IntegrationManifest, patch: WorkspacePatch) {
    return this.locked(plan.ref, 'deliver', async deadline => await this.delivered(plan) ? [] : this.write(plan, this.journal(plan.ref), patch.changes, deadline));
  }
  /** Puts back what a written delivery replaced: the inverse patch through the same writer (every path must still hold the delivery's `after`). */
  rollback(plan: IntegrationDeliveryPlan, patch: WorkspacePatch) {
    return this.locked(plan.ref, 'rollback', async deadline => {
      if (!await this.delivered(plan)) throw new WorkspacePatchError('PATCH_WORKING_TREE_NOT_WRITTEN');
      return this.write(plan, this.journal(plan.ref, format.rollback), patch.changes.map(change => ({ path: change.path, before: change.after, after: change.before })), deadline, 'PATCH_WORKING_TREE_CHANGED');
    });
  }
  /** One delivery or rollback at a time per checkout: an exclusive lock directory holding its owner record (bounded wait, taken over only from a holder proven gone). */
  private async locked(ref: string, operation: 'deliver' | 'rollback', work: (deadline: number) => Promise<string[]>) {
    // Descriptor-relative paths and O_NOFOLLOW are Linux guarantees here: refused elsewhere before any file is touched.
    if (process.platform !== 'linux') throw new WorkspacePatchError('PATCH_WORKING_TREE_UNSUPPORTED');
    const digest = patchDigest(this.options.sourceRoot), locks = join(this.options.workspaceRoot, format.locks), lock = join(locks, digest), deadline = Date.now() + this.options.timeoutMs;
    const owner = `${format.lockOwner}${randomUUID()}.json`, pending = join(this.options.workspaceRoot, format.pending, digest);
    await mkdir(locks, { recursive: true, mode: 0o700 });
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, owner), JSON.stringify({ schemaVersion: 1, pid: process.pid, atMs: Date.now(), ref, operation }), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      if (await this.takeOver(lock, pending)) continue;
      if (Date.now() >= deadline) throw new WorkspacePatchError('PATCH_WORKING_TREE_BUSY');
      await sleep(format.lockPollMs);
    }
    // R2 (Astra 3017): every holder first settles gone holders' custody (an entry goes once its journal no longer reads `writing`); then the work, with its own full time budget.
    try {
      let stop: unknown = null;
      for (const name of (await readdir(pending).catch(() => [] as string[])).filter(name => JOURNAL.test(name))) {
        const directory = join(this.options.workspaceRoot, format.deliveries, name);
        await this.settle(directory, Date.now() + this.options.timeoutMs).catch((error: unknown) => { stop ??= error; });
        if (await journalAt(directory).then(journal => journal?.state !== 'writing', () => false)) await unlink(join(pending, name));
      }
      if (stop) throw stop;
      return await work(Date.now() + this.options.timeoutMs);
    } finally { await unlink(join(lock, owner)); await rmdir(lock); }
  }
  /** A lock whose one owner record names a process proven gone (`recordedProcessState`): the journal of its operation (F3) enters durable custody (R2), then its
   * record and the empty lock go exactly. Ownerless, extra, unreadable or live: never taken (BUSY); a gone holder of another version: explicit refusal. */
  private async takeOver(lock: string, pending: string) {
    const names = await readdir(lock).catch(() => [] as string[]), name = names.length === 1 && names[0]!.startsWith(format.lockOwner) ? names[0]! : null;
    const held = name ? await readFile(join(lock, name), 'utf8').then(text => JSON.parse(text) as { pid?: unknown; atMs?: unknown; ref?: unknown; operation?: unknown }, () => null) : null;
    if (!held || typeof held.pid !== 'number' || !Number.isSafeInteger(held.pid) || held.pid <= 0 || typeof held.atMs !== 'number' || recordedProcessState(held.pid, held.atMs) !== 'gone') return false;
    const journal = typeof held.ref === 'string' && (held.operation === 'deliver' || held.operation === 'rollback') ? held.ref.slice(held.ref.lastIndexOf('/') + 1) + (held.operation === 'rollback' ? format.rollback : '') : '';
    if (!JOURNAL.test(journal)) throw unsupported(lock);
    await mkdir(pending, { recursive: true, mode: 0o700 }); await writeFile(join(pending, journal), '', { mode: 0o600 }); await syncDirectory(pending); await syncDirectory(join(pending, '..'));
    try { await unlink(join(lock, name!)); await rmdir(lock); return true; } catch { return false; }
  }
  /** A gone holder's `writing` journal: what its crash left beside a name is recovered first, then every path is classified in full, never completed blindly. */
  private async settle(directory: string, deadline: number) {
    const journal = await journalAt(directory); if (journal?.state !== 'writing') return;
    const changes = journal.changes, custody: Custody = { journal: directory, kept: [], setAside: [] }, seen = [];
    const root = await open(this.options.sourceRoot, DIRECTORY), read = (path: string) => readTreeFile(root, path, new SnapshotBudget(this.limits, deadline));
    try {
      for (const change of changes) {
        const handles: FileHandle[] = [], token = typeof change.token === 'string' && /^[0-9a-f-]{36}$/.test(change.token) ? change.token : null;
        try {
          const parent = token && await directoryOf(root, change.path, false, handles).catch(() => null);
          if (token && parent) {
            const [temp, aside, ours] = names(token), { at: entry, recover } = entries(parent, change.path, read, custody);
            await unlink(entry(temp)).catch(() => undefined); await recover(aside, change.before); await recover(ours, change.after);
          }
        } finally { for (const handle of handles.reverse()) await handle.close(); }
        seen.push({ change, file: await read(change.path).catch(() => false as const) });
      }
    } finally { await root.close(); }
    const paths = changes.map(change => change.path), written = seen.filter(({ change, file }) => holds(file, change.after)).map(({ change }) => change.path);
    const before = seen.every(({ change, file }) => holds(file, change.before));
    await record(directory, format.journal, JSON.stringify({ ...journal, state: written.length === changes.length ? 'written' : before ? 'interrupted' : 'partial', written,
      kept: custody.kept, setAside: [...journal.setAside ?? [], ...custody.setAside] }));
    if (custody.kept.length || (written.length !== changes.length && !before)) throw this.stopped(paths, written, custody);
  }
  /** PATCH_WORKING_TREE_PARTIAL with the written and unwritten lists; PATCH_WORKING_TREE_KEPT when a file moved aside stays beside its name. */
  private stopped(paths: readonly string[], written: readonly string[], custody: Custody) {
    const params = { written: written.join(', '), pending: paths.filter(path => !written.includes(path)).join(', ') }, kept = [...custody.kept, ...custody.setAside.map(entry => entry.path)];
    return kept.length ? new WorkspacePatchError('PATCH_WORKING_TREE_KEPT', undefined, { ...params, kept: kept.join(', ') }) : new WorkspacePatchError('PATCH_WORKING_TREE_PARTIAL', undefined, params);
  }
  private async write(plan: IntegrationDeliveryPlan, directory: string, changes: WorkspacePatch['changes'], deadline: number, changed: 'PATCH_CONFLICT' | 'PATCH_WORKING_TREE_CHANGED' = 'PATCH_CONFLICT') {
    const carried = (await journalAt(directory))?.setAside ?? [], custody: Custody = { journal: directory, kept: [], setAside: [...carried] };
    const root = await open(this.options.sourceRoot, DIRECTORY), read = (path: string) => readTreeFile(root, path, new SnapshotBudget(this.limits, deadline));
    const written: string[] = [], paths = changes.map(change => change.path);
    // F2: each path's full before/after state and the token naming what it moves aside, so a crash settles with the writer's own equality.
    const journaled = changes.map(change => ({ path: change.path, token: randomUUID(), before: observed(change.before), after: observed(change.after) }));
    const note = (state: string) => record(directory, format.journal, JSON.stringify({ schemaVersion: format.journalVersion, state, root: this.options.sourceRoot, ref: plan.ref,
      commit: plan.commit, paths, written, kept: custody.kept, setAside: custody.setAside, changes: journaled }));
    try {
      const pending = [];
      for (const change of changes) pending.push({ change, file: await read(change.path) });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The files are the evidence: all `after` = written (a resumed delivery); `before`/`after` mixed = an interrupted one, never completed blindly.
      const done = pending.filter(({ change, file }) => holds(file, change.after)).map(({ change }) => change.path);
      if (done.length === paths.length) { written.push(...paths); await note('written'); return []; }
      if (!pending.every(({ change, file }) => holds(file, change.before) || done.includes(change.path))) throw new WorkspacePatchError(changed);
      if (done.length) { written.push(...done); await note('partial'); throw this.stopped(paths, done, { ...custody, setAside: [] }); }
      for (const [index, { file }] of pending.entries()) if (file) await record(directory, `${format.original}${index}`, file.bytes);
      await note('writing');
      for (const [index, { change, file }] of pending.entries()) {
        try {
          await this.replace(root, change, journaled[index]!.token, file?.permissions ?? 0o644, read, custody); written.push(change.path);
          if (custody.kept.length) throw new WorkspacePatchError('PATCH_WORKING_TREE_KEPT'); // written, but a file it moved aside stays beside it (named below)
        } catch (error) {
          await note('partial').catch(() => undefined);
          throw written.length || custody.kept.length || custody.setAside.length > carried.length ? this.stopped(paths, written, { ...custody, setAside: custody.setAside.slice(carried.length) }) : error;
        }
      }
      await note('written'); return custody.setAside.slice(carried.length).map(entry => entry.path);
    } finally { await root.close(); }
  }
  /** F1 (Astra 3015): one path, taken aside by an atomic rename and compared, then the new file placed by a no-clobber link; a file saved meanwhile goes back
   * to its name and nothing is written for it (PATCH_CONFLICT), a write into the taken file through an open handle puts it back over ours. */
  private async replace(root: FileHandle, change: WorkspacePatch['changes'][number], token: string, permissions: number, read: Read, custody: Custody) {
    const handles: FileHandle[] = [];
    try {
      const parent = (await directoryOf(root, change.path, true, handles))!, [temp, aside, ours] = names(token);
      const { at, name, same, retire, recover } = entries(parent, change.path, read, custody), conflict = new WorkspacePatchError('PATCH_CONFLICT');
      try {
        if (change.after) {
          const file = await open(at(temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(change.after.text); await file.chmod(change.after.mode === '100755' ? permissions | 0o111 : permissions & ~0o111); await file.sync(); }
          finally { await file.close(); }
        }
        if (change.before) {
          await rename(at(name), at(aside)).catch((error: unknown) => { throw code(error) === 'ENOENT' ? conflict : error; });
          if (!await same(aside, change.before)) { await recover(aside, change.before); throw conflict; }
        }
        if (change.after) {
          await link(at(temp), at(name)).catch(async (error: unknown) => { if (change.before) await recover(aside, change.before); throw code(error) === 'EEXIST' ? conflict : error; });
          await unlink(at(temp));
        }
        if (change.before && !await same(aside, change.before)) {
          if (change.after) await rename(at(name), at(ours)).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error; });
          if (change.after && await same(ours, change.after)) { await recover(aside, change.before); await retire(ours, change.after); }
          else { if (change.after) await recover(ours, change.after); await recover(aside, change.before); }
          throw conflict;
        }
        if (change.before) await retire(aside, change.before);
        await parent.sync();
      } finally { await unlink(at(temp)).catch(() => undefined); }
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
}
