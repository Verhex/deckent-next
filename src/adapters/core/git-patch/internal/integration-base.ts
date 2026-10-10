import { WorkspacePatchError, type WorkspacePatch } from '#engine/index.js';
import { gitBlobOid, hashAlgorithmOf, type SnapshotBudget } from './snapshot.js';
/** A forward base move is safe only when every touched path still has its approved before identity. */
export async function assertIntegrationBase(git: (args: string[]) => Promise<string>, patch: WorkspacePatch, head: string, budget: SnapshotBudget) {
  if (head === patch.baseCommit) return;
  // The caller disables replacement objects and grafts: ancestry must come from the actual immutable commits.
  await git(['merge-base', '--is-ancestor', patch.baseCommit, head]);
  for (const change of patch.changes) {
    budget.entry(); budget.path(change.path);
    const parts = change.path.split('/');
    const paths = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    // One exact path per query: combining a directory and its descendant makes ls-tree expand that directory.
    const entries = new Map<string, string>();
    for (const path of paths) {
      const row = await git(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', head, '--', path]);
      if (row) entries.set(path, row.slice(0, row.indexOf('\t')));
    }
    const expected = change.before ? `${change.before.mode} blob ${gitBlobOid(Buffer.from(change.before.text), hashAlgorithmOf(head))}` : undefined;
    if (entries.get(change.path) !== expected || paths.slice(0, -1).some(path => entries.has(path) && !entries.get(path)!.startsWith('040000 tree ')))
      throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
  }
}
