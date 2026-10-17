import { changedHistoryPaths, assertDisjointHistory } from './path-history.js';
import { WorkspacePatchError, patchPathSchema, type WorkspacePatch } from './contract.js';
import { gitBlobOid, hashAlgorithmOf, type SnapshotBudget } from './snapshot.js';
/** A forward base move is safe only when every touched path still has its approved before identity. */
export async function assertIntegrationBase(git: (args: string[]) => Promise<string>, patch: WorkspacePatch, head: string, budget: SnapshotBudget) {
  // The patch's own write rule comes first: a path it may never write (e.g. `.deckent/`) is PATCH_UNSAFE, whatever history touched.
  if (patch.changes.some(change => !patchPathSchema.safeParse(change.path).success)) throw new WorkspacePatchError('PATCH_UNSAFE');
  if (head === patch.baseCommit) return;
  // The caller disables replacement objects and grafts: ancestry must come from the actual immutable commits.
  await git(['merge-base', '--is-ancestor', patch.baseCommit, head]);
  // Compare every intervening commit, including merge parents: a changed-then-restored path is still stale input.
  const commits = (await git(['rev-list', `${patch.baseCommit}..${head}`])).trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    budget.entry();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new WorkspacePatchError('PATCH_CORRUPT');
    const paths = changedHistoryPaths(await git(['diff-tree', '--root', '-m', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', commit]));
    for (const path of paths) { budget.entry(); budget.path(path, 'history'); }
    assertDisjointHistory(paths, patch.changes.map(change => change.path));
  }
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
