import { execFile } from 'node:child_process';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
/** Bounded object-only transport between service-owned private repositories. No refs, hooks, remote or shared writable metadata. */
export async function copyPrivateCommit(options: GitWorkspaceOptions, from: string, to: string, commit: string, exclude: string) {
  if (![commit, exclude].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw new WorkspacePatchError('PATCH_CORRUPT');
  const run = (root: string, args: string[], input: Uint8Array | string) => new Promise<Buffer>((resolve, reject) => {
    const child = execFile(options.gitExecutable, localGitArgs(root, args), { env: GIT_LOCAL_ENV, timeout: options.timeoutMs,
      maxBuffer: options.outputBytes, encoding: 'buffer' }, (error, output) => error ? reject(new WorkspacePatchError('PATCH_CONFLICT')) : resolve(output));
    child.stdin?.on('error', () => undefined); child.stdin?.end(input);
  });
  await run(to, ['index-pack', '--stdin'], await run(from, ['pack-objects', '--stdout', '--revs'], `${commit}\n^${exclude}\n`));
}
