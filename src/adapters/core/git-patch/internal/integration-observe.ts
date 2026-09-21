import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintGitSource, type GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { patchFile, patchDigest, WorkspacePatchError, type WorkspacePatch, type PatchLimits } from '#engine/index.js';
import { SnapshotBudget } from './snapshot.js';
const exec = promisify(execFile);
function missing(error: unknown) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
/** Read only the affected paths: unrelated source WIP and node_modules are not scanned. */
async function touched(root: FileHandle, path: string, budget: SnapshotBudget) {
  budget.entry(); budget.path(path);
  const parts = path.split('/'); let parent = root; const opened: FileHandle[] = [];
  try {
    for (let index = 0; index < parts.length; index++) {
      const directory = index < parts.length - 1;
      let handle: FileHandle;
      try { handle = await open(`/proc/self/fd/${parent.fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)); }
      catch (error) { if (missing(error)) return null; throw new WorkspacePatchError('PATCH_UNSAFE'); }
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
      return patchFile(bytes, before.mode & 0o111 ? '100755' : '100644');
    }
    throw new WorkspacePatchError('PATCH_UNSAFE');
  } finally { for (const handle of opened.reverse()) await handle.close(); }
}
export async function observeIntegration(options: GitWorkspaceOptions, limits: PatchLimits, patch: WorkspacePatch) {
  const budget = new SnapshotBudget(limits, Date.now() + options.timeoutMs);
  const source = options.sourceRoot;
  if (process.platform !== 'linux' || await realpath(source) !== source) throw new WorkspacePatchError('PATCH_UNSAFE');
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o022)) throw new WorkspacePatchError('PATCH_UNSAFE');
  const git = async (args: string[]) => {
    budget.time();
    try { return (await exec(options.gitExecutable, ['--no-replace-objects', '-C', source, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
        timeout: Math.max(1, budget.deadline - Date.now()), maxBuffer: options.outputBytes, encoding: 'utf8' })).stdout; }
    catch { throw new WorkspacePatchError('PATCH_UNAVAILABLE'); }
  };
  const repository = (await git(['rev-parse', '--show-toplevel'])).trim();
  const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (source !== repository || head !== patch.baseCommit || fingerprintGitSource({ schemaVersion: 1, sourceRoot: source, repositoryRoot: repository }) !== patch.source.sourceFingerprint)
    throw new WorkspacePatchError('PATCH_CONFLICT');
  const index = new Map<string, string>();
  for (const entry of (await git(['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)) {
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
      if (index.get(change.path) !== expected || [...index.keys()].some(path => path !== change.path && (path.startsWith(change.path + '/') || change.path.startsWith(path + '/'))))
        throw new WorkspacePatchError('PATCH_CONFLICT');
      const file = await touched(root, change.path, budget);
      if (JSON.stringify(file) !== JSON.stringify(change.before)) throw new WorkspacePatchError('PATCH_CONFLICT');
    }
  } finally { await root.close(); }
  return Object.freeze({ source, head, digest: patchDigest(JSON.stringify({ source, head, index: [...index].sort(),
    files: patch.changes.map(change => ({ path: change.path, before: change.before?.digest ?? null, mode: change.before?.mode ?? null })) })) });
}
