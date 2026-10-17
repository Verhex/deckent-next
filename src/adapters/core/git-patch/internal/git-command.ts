import { SystemTrustedClock } from '#platform/index.js';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import format from './delivery-format.json' with { type: 'json' };
import { gitFailure } from './snapshot.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
/** Bounded Git process for reference writers: no hooks, fsmonitor, replace objects, network or user/system config.
 * The fixed author/committer identity also names reflog entries. */
export class GitCommand {
  constructor(private readonly options: GitWorkspaceOptions) {}
  run(args: string[], input = '', index?: string, deadline = Date.now() + this.options.timeoutMs, deliveredAtMs = new SystemTrustedClock().sample().wallMs) {
    // The remaining budget is spent before Git starts: report the configured bound like the snapshot scan does (Astra 2367 P2).
    if (Date.now() >= deadline) throw new WorkspacePatchError('PATCH_LIMIT', 'time', { observed: this.options.timeoutMs + Math.max(0, Date.now() - deadline), limit: this.options.timeoutMs });
    const date = new Date(deliveredAtMs).toISOString();
    const identity = this.options.deliveryIdentity ?? format;
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.options.gitExecutable, localGitArgs(this.options.sourceRoot, args), {
        env: { ...GIT_LOCAL_ENV,
          ...(index ? { GIT_INDEX_FILE: index } : {}), GIT_AUTHOR_NAME: identity.authorName, GIT_AUTHOR_EMAIL: identity.authorEmail,
          GIT_COMMITTER_NAME: identity.authorName, GIT_COMMITTER_EMAIL: identity.authorEmail, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        timeout: Math.max(1, deadline - Date.now()), maxBuffer: this.options.outputBytes, encoding: 'utf8',
      }, (error, stdout) => error ? reject(gitFailure(error)) : resolve(stdout.trim()));
      child.stdin?.on('error', () => undefined); child.stdin?.end(input);
    });
  }
  /** Source root, workspace root and Git directory are real, owned, not group/other-writable directories. */
  async custody() {
    for (const path of [this.options.sourceRoot, this.options.workspaceRoot, await this.run(['rev-parse', '--absolute-git-dir'])]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) || await realpath(path) !== path) throw new WorkspacePatchError('PATCH_UNSAFE');
    }
  }
  /** The canonical, owned, not group/other-writable Git common directory: the physical repository behind queue and adoption identities. */
  async common(unsafe: () => Error = () => new WorkspacePatchError('PATCH_UNSAFE')) {
    const path = await realpath(await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])), stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw unsafe();
    return { path, device: stat.dev, inode: stat.ino };
  }
}
