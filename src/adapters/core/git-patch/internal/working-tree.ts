import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rmdir, unlink, writeFile, type FileHandle } from 'node:fs/promises';
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
const holds = (file: Awaited<ReturnType<typeof readTreeFile>>, expected: PatchFile | null) =>
  file === null ? expected === null : expected !== null && file.mode === expected.mode && patchDigest(file.bytes) === expected.digest;
/** A small private record replaced atomically (0600 temporary file, fsync, rename, directory fsync). */
async function record(directory: string, name: string, data: string | Uint8Array) {
  const temporary = join(directory, `.${randomUUID()}.tmp`), file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(directory, name));
  const handle = await open(directory, DIRECTORY); try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Owner 2026-11-05 (R9p): the working-tree delivery target. A person's yes writes the accepted patch into the checkout's files: no commit, no
 * reference and no object in the person's repository, index and HEAD untouched. Deliveries into one checkout are serialized by an exclusive
 * lock directory in Deckent's workspace root (bounded wait, never broken). Every path is read first and must hold exactly its `before`, or
 * every path already its `after` (this delivery was written); otherwise nothing is written. The bytes a write replaces or removes are kept in
 * Deckent's own delivery directory before the write. Each write is a same-directory temporary file (fsync) renamed over the path only after
 * its bytes are compared once more; a removal is compared and unlinked. A failure in between stops at once: the journal names the written
 * paths and the delivery is refused as partial; nothing is rewritten blindly. Plan and diff are the reference target's own (`delegate`).
 * L1c: the lock names its holder (pid, time, delivery); a holder proven gone is taken over, and its journal still `writing` is settled from
 * the files first (all before: nothing written; all after: written; mixed: partial, refused with the lists). `rollback` puts a written
 * delivery's `before` contents back through the same lock and writer, only while every path still holds the delivery's `after`.
 */
export class GitWorkingTreeDelivery implements IntegrationDeliveryTarget {
  readonly application = 'working-tree' as const;
  private readonly delegate: GitIntegrationDelivery;
  constructor(private readonly options: GitWorkspaceOptions, private readonly limits: PatchLimits) { this.delegate = new GitIntegrationDelivery(options); }
  plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch, metadata: IntegrationCommitMetadata) { return this.delegate.plan(command, manifest, patch, metadata); }
  describe(from: string, to: string) { return this.delegate.describe(from, to); }
  /** The plan's reference names this delivery's private journal (a rollback's: beside it); never written to the person's repository. */
  private journal(ref: string, suffix = '') { return join(this.options.workspaceRoot, format.deliveries, ref.slice(ref.lastIndexOf('/') + 1) + suffix); }
  private async state(directory: string) {
    try { return JSON.parse(await readFile(join(directory, format.journal), 'utf8')) as { state?: unknown; changes?: unknown }; }
    catch (error) { if (code(error) === 'ENOENT') return null; throw new WorkspacePatchError('PATCH_CORRUPT'); }
  }
  async delivered(plan: IntegrationDeliveryPlan) { return (await this.state(this.journal(plan.ref)))?.state === 'written'; }
  async publish(plan: IntegrationDeliveryPlan, _manifest: IntegrationManifest, patch: WorkspacePatch) {
    await this.locked(plan.ref, async deadline => { if (!await this.delivered(plan)) await this.write(plan, this.journal(plan.ref), patch.changes, deadline); });
  }
  /** Puts back what a written delivery replaced: the inverse patch through the same writer (every path must still hold the delivery's `after`). */
  async rollback(plan: IntegrationDeliveryPlan, patch: WorkspacePatch) {
    await this.locked(plan.ref, async deadline => {
      if (!await this.delivered(plan)) throw new WorkspacePatchError('PATCH_WORKING_TREE_NOT_WRITTEN');
      await this.write(plan, this.journal(plan.ref, format.rollback), patch.changes.map(change => ({ path: change.path, before: change.after, after: change.before })), deadline, 'PATCH_WORKING_TREE_CHANGED');
    });
  }
  /** One delivery or rollback at a time per checkout: an exclusive lock directory holding its owner record (bounded wait, taken over only from a holder proven gone). */
  private async locked(ref: string, work: (deadline: number) => Promise<void>) {
    // Descriptor-relative paths and O_NOFOLLOW are Linux guarantees here: refused elsewhere before any file is touched.
    if (process.platform !== 'linux') throw new WorkspacePatchError('PATCH_WORKING_TREE_UNSUPPORTED');
    const locks = join(this.options.workspaceRoot, format.locks), lock = join(locks, patchDigest(this.options.sourceRoot)), deadline = Date.now() + this.options.timeoutMs;
    const owner = `${format.lockOwner}${randomUUID()}.json`, interrupted: string[] = [];
    await mkdir(locks, { recursive: true, mode: 0o700 });
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, owner), JSON.stringify({ schemaVersion: 1, pid: process.pid, atMs: Date.now(), ref }), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      const gone = await this.takeOver(lock); if (gone) { interrupted.push(gone); continue; }
      if (Date.now() >= deadline) throw new WorkspacePatchError('PATCH_WORKING_TREE_BUSY');
      await sleep(format.lockPollMs);
    }
    // The work gets its own full time budget once the lock is held: a long wait for it never cuts a write short.
    try { for (const gone of interrupted) await this.settle(this.journal(gone), Date.now() + this.options.timeoutMs); await work(Date.now() + this.options.timeoutMs); }
    finally { await unlink(join(lock, owner)); await rmdir(lock); }
  }
  /** The held lock's one owner record names a process proven gone (pid and start bound, `recordedProcessState`): its record and the empty lock are
   * removed exactly (never recursively) and its delivery reference returned. An ownerless, extra or unreadable lock is never taken (BUSY, as before). */
  private async takeOver(lock: string) {
    const names = await readdir(lock).catch(() => [] as string[]), name = names.length === 1 && names[0]!.startsWith(format.lockOwner) ? names[0]! : null;
    const held = name ? await readFile(join(lock, name), 'utf8').then(text => JSON.parse(text) as { pid?: unknown; atMs?: unknown; ref?: unknown }, () => null) : null;
    if (!held || typeof held.pid !== 'number' || !Number.isSafeInteger(held.pid) || held.pid <= 0 || typeof held.atMs !== 'number' || typeof held.ref !== 'string'
      || recordedProcessState(held.pid, held.atMs) !== 'gone') return null;
    try { await unlink(join(lock, name!)); await rmdir(lock); return held.ref; } catch { return null; }
  }
  /** A gone holder's journal still `writing` is classified from the files, never completed blindly. */
  private async settle(directory: string, deadline: number) {
    const journal = await this.state(directory); if (journal?.state !== 'writing' || !Array.isArray(journal.changes)) return;
    const changes = journal.changes as { path: string; before: string | null; after: string | null }[], root = await open(this.options.sourceRoot, DIRECTORY), at: (string | null)[] = [];
    try { for (const change of changes) { const file = await readTreeFile(root, change.path, new SnapshotBudget(this.limits, deadline)); at.push(file && patchDigest(file.bytes)); } } finally { await root.close(); }
    const written = changes.filter((change, index) => at[index] === change.after).map(change => change.path), before = changes.every((change, index) => at[index] === change.before);
    await record(directory, format.journal, JSON.stringify({ ...journal, state: written.length === changes.length ? 'written' : before ? 'interrupted' : 'partial', written }));
    if (written.length !== changes.length && !before) throw new WorkspacePatchError('PATCH_WORKING_TREE_PARTIAL', undefined, { written: written.join(', '), pending: changes.map(change => change.path).filter(path => !written.includes(path)).join(', ') });
  }
  private async write(plan: IntegrationDeliveryPlan, directory: string, changes: WorkspacePatch['changes'], deadline: number, changed: 'PATCH_CONFLICT' | 'PATCH_WORKING_TREE_CHANGED' = 'PATCH_CONFLICT') {
    const root = await open(this.options.sourceRoot, DIRECTORY), read = (path: string) => readTreeFile(root, path, new SnapshotBudget(this.limits, deadline));
    const written: string[] = [], paths = changes.map(change => change.path);
    const digests = changes.map(change => ({ path: change.path, before: change.before?.digest ?? null, after: change.after?.digest ?? null }));
    const note = (state: string) => record(directory, format.journal, JSON.stringify({ schemaVersion: 1, state, ref: plan.ref, commit: plan.commit, paths, written, changes: digests }));
    try {
      const pending = [];
      for (const change of changes) pending.push({ change, file: await read(change.path) });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const partial = (done: readonly string[]) => new WorkspacePatchError('PATCH_WORKING_TREE_PARTIAL', undefined, { written: done.join(', '), pending: paths.filter(path => !done.includes(path)).join(', ') });
      // The files are the evidence: all `after` = written (a resumed delivery); `before`/`after` mixed = an interrupted one, never completed blindly.
      const done = pending.filter(({ change, file }) => holds(file, change.after)).map(({ change }) => change.path);
      if (done.length === paths.length) { written.push(...paths); await note('written'); return; }
      if (!pending.every(({ change, file }) => holds(file, change.before) || done.includes(change.path))) throw new WorkspacePatchError(changed);
      if (done.length) { written.push(...done); await note('partial'); throw partial(done); }
      for (const [index, { file }] of pending.entries()) if (file) await record(directory, `${format.original}${index}`, file.bytes);
      await note('writing');
      for (const { change, file } of pending) {
        try { await this.replace(root, change, file?.permissions ?? 0o644, read); written.push(change.path); }
        catch (error) {
          await note('partial').catch(() => undefined);
          throw written.length ? partial(written) : error;
        }
      }
      await note('written');
    } finally { await root.close(); }
  }
  private async replace(root: FileHandle, change: WorkspacePatch['changes'][number], permissions: number, read: (path: string) => ReturnType<typeof readTreeFile>) {
    const parts = change.path.split('/'), name = parts.pop()!, handles: FileHandle[] = [];
    try {
      let parent = root;
      for (const part of parts) {
        const at = `/proc/self/fd/${parent.fd}/${part}`;
        await mkdir(at).catch((error: unknown) => { if (code(error) !== 'EEXIST') unsafe(); });
        parent = await open(at, DIRECTORY).catch(unsafe); handles.push(parent);
        if ((await parent.stat()).uid !== process.getuid!()) unsafe();
      }
      const at = (entry: string) => `/proc/self/fd/${parent.fd}/${entry}`, temporary = `.deckent-${randomUUID()}.tmp`;
      if (change.after) {
        const file = await open(at(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(change.after.text); await file.chmod(change.after.mode === '100755' ? permissions | 0o111 : permissions & ~0o111); await file.sync(); }
        finally { await file.close(); }
        // The person may have saved meanwhile: compared once more right before the rename, never written over.
        if (!holds(await read(change.path), change.before)) { await unlink(at(temporary)); throw new WorkspacePatchError('PATCH_CONFLICT'); }
        await rename(at(temporary), at(name));
      } else {
        if (!holds(await read(change.path), change.before)) throw new WorkspacePatchError('PATCH_CONFLICT');
        await unlink(at(name));
      }
      await parent.sync();
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
}
