import { spawn } from 'node:child_process';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
/** Bounded object-only transport into a service-owned private repository: the objects reachable from `commit` (without `exclude`'s), streamed
 * from `pack-objects` into `index-pack` (no buffer bound on history size; the time bound holds). No refs, hooks, remote or shared writable metadata. */
export async function copyPrivateCommit(options: GitWorkspaceOptions, from: string, to: string, commit: string, exclude?: string) {
  if (![commit, ...exclude === undefined ? [] : [exclude]].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw new WorkspacePatchError('PATCH_CORRUPT');
  const git = (root: string, args: string[]) => spawn(options.gitExecutable, localGitArgs(root, args), { env: GIT_LOCAL_ENV, timeout: options.timeoutMs, stdio: ['pipe', 'pipe', 'ignore'] });
  const pack = git(from, ['pack-objects', '--stdout', '--revs']), index = git(to, ['index-pack', '--stdin']);
  const ended = (child: ReturnType<typeof git>) => new Promise<boolean>(resolve => { child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0)); });
  for (const stream of [pack.stdin, index.stdin, pack.stdout]) stream.on('error', () => undefined);
  pack.stdout.pipe(index.stdin); index.stdout.resume(); pack.stdin.end(`${commit}\n${exclude === undefined ? '' : `^${exclude}\n`}`);
  if (!(await Promise.all([ended(pack), ended(index)])).every(Boolean)) throw new WorkspacePatchError('PATCH_CONFLICT');
}
