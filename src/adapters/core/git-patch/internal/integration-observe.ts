import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintGitSource, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { patchFile, patchDigest, workingTreeSource, WorkspacePatchError, PATCH_SCOPE_ERROR_PATHS, type WorkspacePatch, type PatchLimits } from '#engine/index.js';
import { gitFailure, SnapshotBudget } from './snapshot.js';
import { readTreeFile } from './working-tree.js';
import { filteredBasePaths } from './working-tree-base.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
import { assertIntegrationBase } from './integration-base.js';
const exec = promisify(execFile);
export async function observeIntegration(options: GitWorkspaceOptions, limits: PatchLimits, patch: WorkspacePatch) {
  const budget = new SnapshotBudget(limits, Date.now() + options.timeoutMs);
  const source = options.sourceRoot;
  if (process.platform !== 'linux' || await realpath(source) !== source) throw new WorkspacePatchError('PATCH_UNSAFE');
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o022)) throw new WorkspacePatchError('PATCH_UNSAFE');
  const git = async (args: string[]) => {
    budget.time();
    try { return (await exec(options.gitExecutable, localGitArgs(source, args),
      { env: { ...GIT_LOCAL_ENV, GIT_GRAFT_FILE: '/dev/null' }, timeout: Math.max(1, budget.deadline - Date.now()), maxBuffer: options.outputBytes, encoding: 'utf8' })).stdout; }
    catch (error) {
      if (args[0] === 'merge-base' && (error as { code?: unknown }).code === 1) throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
      throw gitFailure(error);
    }
  };
  const repository = (await git(['rev-parse', '--show-toplevel'])).trim();
  if (options.baseRef !== undefined) {
    // Ref-only delivery checks the named branch and its touched tree identities, never the detached checkout or index.
    const tip = (await git(['rev-parse', '--verify', `${options.baseRef}^{commit}`])).trim();
    if (source !== repository || fingerprintGitSource({ schemaVersion: 1, sourceRoot: source, repositoryRoot: repository }) !== patch.source.sourceFingerprint)
      throw new WorkspacePatchError('PATCH_CONFLICT');
    await assertIntegrationBase(git, patch, tip, budget);
    return Object.freeze({ source, head: tip, digest: patchDigest(JSON.stringify({ source, baseRef: options.baseRef, head: tip })) });
  }
  // Working-tree Run (pinned by its patch's source): the base is the Run's own commit of the files (never compared with HEAD), the index is not consulted.
  const files = workingTreeSource(patch.source), head = files ? patch.baseCommit : (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (source !== repository || fingerprintGitSource({ schemaVersion: 1, sourceRoot: source, repositoryRoot: repository }) !== patch.source.sourceFingerprint)
    throw new WorkspacePatchError('PATCH_CONFLICT');
  await assertIntegrationBase(git, patch, head, budget);
  // K-1 (owner 2026-11-08): a filtered path (Git LFS, git-crypt) kept its HEAD blob in the Run's base; a patch writing it is refused, never delivered.
  const filtered = files ? await filteredBasePaths(options.workspaceRoot, patch.identity) : new Set<string>(), touched = patch.changes.map(change => change.path).filter(path => filtered.has(path));
  if (touched.length) throw new WorkspacePatchError('PATCH_WORKING_TREE_FILTERED', undefined, { count: touched.length, paths: touched.slice(0, PATCH_SCOPE_ERROR_PATHS).join(', '), omitted: Math.max(0, touched.length - PATCH_SCOPE_ERROR_PATHS) });
  const index = new Map<string, string>();
  for (const entry of files ? [] : (await git(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
    budget.time();
    const tab = entry.indexOf('\t'); const path = entry.slice(tab + 1);
    if (!patch.changes.some(change => path === change.path || path.startsWith(change.path + '/') || change.path.startsWith(path + '/'))) continue;
    const match = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0$/.exec(entry.slice(0, tab));
    if (!match || index.has(path)) throw new WorkspacePatchError('PATCH_CONFLICT');
    index.set(path, match[1] + ' ' + match[2]);
  }
  const root = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const change of patch.changes) {
      const expected = change.before ? change.before.mode + ' ' + createHash(head.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${Buffer.byteLength(change.before.text)}\0`).update(change.before.text).digest('hex') : undefined;
      if (!files && (index.get(change.path) !== expected || [...index.keys()].some(path => path !== change.path && (path.startsWith(change.path + '/') || change.path.startsWith(path + '/')))))
        throw new WorkspacePatchError('PATCH_CONFLICT');
      const read = await readTreeFile(root, change.path, budget), file = JSON.stringify(read && patchFile(read.bytes, read.mode));
      // A working-tree path already holding its `after` is an interrupted delivery's own write; the writer leaves it as it is.
      if (file !== JSON.stringify(change.before) && !(files && file === JSON.stringify(change.after))) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  } finally { await root.close(); }
  return Object.freeze({ source, head, digest: patchDigest(JSON.stringify({ source, head, index: [...index].sort(),
    files: patch.changes.map(change => ({ path: change.path, before: change.before?.digest ?? null, mode: change.before?.mode ?? null })) })) });
}
