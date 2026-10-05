import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { sameAttemptIdentity } from '#domain/index.js';
import { HandoffError, patchDigest, workspacePatchSchema, type AcceptedPredecessorPatch, type PatchLimits, type WorkspaceLease } from '#engine/index.js';
import { GitWorkspaceBroker, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { diffAgainstBase, hashAlgorithmOf, listBase, readWorkspace, snapshotDigest, SnapshotBudget, type Snapshot } from './snapshot.js';
import { applyWorkspacePatchChanges } from './patch-apply.js';
const recordSchema = z.object({ schemaVersion: z.literal(1), state: z.enum(['applying', 'ready']),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
async function durable(path: string, value: z.infer<typeof recordSchema>) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function existing(path: string, maxBytes: number) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.mode & (constants.S_IRWXG | constants.S_IRWXO) || stat.uid !== process.getuid!()) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    return recordSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
/** Applied only before a worker starts. Private sidecar fences interrupted writes; replay verifies all resulting bytes.
 * Run custody and checkout HEAD remain the original base. Patch receipts are separately recorded on the attempt by the engine. */
export async function applyAcceptedPredecessorPatches(lease: WorkspaceLease, options: GitWorkspaceOptions, limits: PatchLimits,
  starts: readonly AcceptedPredecessorPatch[]) {
  if (!starts.length) return Object.freeze([]);
  try {
    const recorded = await new GitWorkspaceBroker(options).openRecorded(lease.identity);
    if (!recorded || recorded.workspace !== lease.workspace || recorded.baseCommit !== lease.baseCommit) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    const receipts = starts.map(start => ({ sourceTaskId: start.source.taskId, sourceAttemptId: start.source.attemptId, digest: start.receipt.digest }));
    const bindingDigest = patchDigest(JSON.stringify({ identity: lease.identity, baseCommit: lease.baseCommit, receipts }));
    const path = join(dirname(lease.workspace), 'handoff-start.json');
    const budget = () => new SnapshotBudget(limits, Date.now() + options.timeoutMs);
    const changes = starts.flatMap(start => {
      const patch = workspacePatchSchema.parse(start.patch);
      if (!sameAttemptIdentity(patch.identity, start.source) || start.source.scopeId !== lease.identity.scopeId || start.source.runId !== lease.identity.runId
        || start.source.taskId === lease.identity.taskId || start.receipt.scopeId !== lease.identity.scopeId
        || start.receipt.byteLength !== Buffer.byteLength(JSON.stringify(start.patch)) || patchDigest(JSON.stringify(start.patch)) !== start.receipt.digest
        || patch.baseCommit !== lease.baseCommit || JSON.stringify(patch.source) !== JSON.stringify({ schemaVersion: 1, adapter: recorded.sourceBase.adapter,
          sourceFingerprint: recorded.sourceBase.sourceFingerprint })) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      return [...patch.changes];
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (new Set(changes.map(change => change.path)).size !== changes.length) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    const prior = await existing(path, options.outputBytes);
    const listing = await listBase(recorded, options, budget()); const algorithm = hashAlgorithmOf(lease.baseCommit);
    const current = await readWorkspace(lease.workspace, budget(), { listing, algorithm, keep: new Set(changes.map(change => change.path)) });
    if (prior) {
      if (prior.state !== 'ready' || prior.bindingDigest !== bindingDigest || prior.snapshotDigest !== snapshotDigest(current)) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      return Object.freeze(receipts);
    }
    if (diffAgainstBase(listing, current, algorithm).length) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    const expected: Snapshot = new Map(current);
    for (const change of changes) {
      if (JSON.stringify(current.get(change.path) ?? null) !== JSON.stringify(change.before)) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
      if (change.after) expected.set(change.path, change.after); else expected.delete(change.path);
    }
    // Preflight expected output bounds before the first write, including newly added paths/bytes.
    const expectedBudget = budget();
    for (const [path, file] of expected) { expectedBudget.path(path); expectedBudget.entry(); expectedBudget.size(Buffer.byteLength(file.text)); }
    const record = { schemaVersion: 1 as const, state: 'applying' as const, bindingDigest, snapshotDigest: snapshotDigest(expected) };
    await durable(path, record);
    await applyWorkspacePatchChanges(lease.workspace, changes);
    if (snapshotDigest(await readWorkspace(lease.workspace, budget(), { listing, algorithm, keep: new Set(changes.map(change => change.path)) })) !== record.snapshotDigest) throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    await durable(path + '.pending', { ...record, state: 'ready' }); await rename(path + '.pending', path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return Object.freeze(receipts);
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
  }
}
