import { SystemTrustedClock, terminalSafeText } from '#platform/index.js';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import format from './delivery-format.json' with { type: 'json' };
import { gitFailure } from './snapshot.js';
import { GIT_LOCAL_ENV, localGitArgs } from './local-git.js';
export async function checkGitCustodyDirectory(path: string, explain = false) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || await realpath(path) !== path) throw new WorkspacePatchError('PATCH_UNSAFE');
  if (stat.mode & 0o022) {
    const displayPath = terminalSafeText(path).replace(/[\n\t]/gu, ' ');
    throw new WorkspacePatchError('PATCH_UNSAFE', undefined, explain ? { reason: 'git-directory-write', path: displayPath,
      command: displayPath === path ? format.directoryPermissionCommand.replace('{path}', `'${path.replaceAll("'", "'\"'\"'")}'`) : '',
      before: (stat.mode & 0o7777).toString(8).padStart(4, '0'), after: (stat.mode & 0o7777 & ~0o022).toString(8).padStart(4, '0') } : undefined);
  }
  return path;
}
/** Bounded Git process for reference writers: no hooks, fsmonitor, replace objects, network or user/system config.
 * The fixed author/committer identity also names reflog entries. */
export class GitCommand {
  constructor(private readonly options: GitWorkspaceOptions) {}
  run(args: string[], input: string | Uint8Array = '', index?: string, deadline = Date.now() + this.options.timeoutMs, deliveredAtMs = new SystemTrustedClock().sample().wallMs) {
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
  async gitDirectory() { return inspectGitDeliveryDirectory(this.options); }
  async custody() {
    for (const path of [this.options.sourceRoot, this.options.workspaceRoot]) await checkGitCustodyDirectory(path);
    await this.gitDirectory();
  }
  /** The canonical, owned, not group/other-writable Git common directory. Identity uses path and inode only; the device number is
   * returned solely to recognize a ticket bound before QUEUE-SMALL 2 (`legacyQueueBinding`). */
  async common(unsafe: () => Error = () => new WorkspacePatchError('PATCH_UNSAFE')) {
    const path = await realpath(await this.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])), stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw unsafe();
    return { path, inode: stat.ino, device: stat.dev };
  }
}

/** Read-only preflight, using the delivery writer's exact check and isolated Git command. */
export async function inspectGitDeliveryDirectory(options: GitWorkspaceOptions, capturePath?: (path: string) => void) {
  const path = await new GitCommand(options).run(['rev-parse', '--absolute-git-dir']);
  // Operational custody stays private to the permission helper; display params never contain this raw path.
  capturePath?.(path);
  return checkGitCustodyDirectory(path, true);
}
