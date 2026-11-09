import { spawn } from 'node:child_process';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import { GIT_COPY_BYTES, redactBounded, terminalSafeText } from '#platform/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
/** Bounded object-only transport into a service-owned private repository: the objects reachable from `commit` (without `exclude`'s), streamed
 * from `pack-objects` into `index-pack` within the time bound and `copyBytes` (A6-6: past it both stop, PATCH_LIMIT). No refs, hooks, remote or shared writable metadata. */
export async function copyPrivateCommit(options: GitWorkspaceOptions, from: string, to: string, commit: string, exclude?: string) {
  if (![commit, ...exclude === undefined ? [] : [exclude]].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw new WorkspacePatchError('PATCH_CORRUPT');
  const git = (root: string, args: string[]) => spawn(options.gitExecutable, localGitArgs(root, args), { env: GIT_LOCAL_ENV, timeout: options.timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
  const pack = git(from, ['pack-objects', '--stdout', '--revs']), index = git(to, ['index-pack', '--stdin']), limit = options.copyBytes ?? GIT_COPY_BYTES; let copied = 0;
  const ended = (child: ReturnType<typeof git>) => new Promise<boolean>(resolve => { child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0)); });
  let stderr = Buffer.alloc(0);
  for (const child of [pack, index]) child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk.subarray(-options.outputBytes)]).subarray(-options.outputBytes); });
  for (const stream of [pack.stdin, index.stdin, pack.stdout]) stream.on('error', () => undefined);
  pack.stdout.on('data', (chunk: Buffer) => { if ((copied += chunk.length) > limit) { pack.kill(); index.kill(); } }).pipe(index.stdin); index.stdout.resume(); pack.stdin.end(`${commit}\n${exclude === undefined ? '' : `^${exclude}\n`}`);
  const finished = (await Promise.all([ended(pack), ended(index)])).every(Boolean);
  if (copied > limit || !finished) throw copied > limit ? new WorkspacePatchError('PATCH_LIMIT', 'git-copy', { observed: copied, limit })
    : new WorkspacePatchError('PATCH_CONFLICT', undefined, stderr.length ? { detail: redactBounded(terminalSafeText(stderr.toString('utf8')), undefined, options.outputBytes) } : undefined);
}
