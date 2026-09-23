import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { WorkspacePatchError } from '#engine/index.js';
import format from './delivery-format.json' with { type: 'json' };
import { gitFailure } from './snapshot.js';
/** Bounded Git process for reference writers: no hooks, fsmonitor, replace objects, network or user/system config.
 * The fixed author/committer identity also names reflog entries. */
export class GitCommand {
  constructor(private readonly options: GitWorkspaceOptions) {}
  run(args: string[], input = '', index?: string, deadline = Date.now() + this.options.timeoutMs) {
    if (Date.now() >= deadline) throw new WorkspacePatchError('PATCH_LIMIT', 'time');
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.options.gitExecutable, ['--no-replace-objects', '-C', this.options.sourceRoot,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
          ...(index ? { GIT_INDEX_FILE: index } : {}), GIT_AUTHOR_NAME: format.authorName, GIT_AUTHOR_EMAIL: format.authorEmail,
          GIT_COMMITTER_NAME: format.authorName, GIT_COMMITTER_EMAIL: format.authorEmail, GIT_AUTHOR_DATE: format.date, GIT_COMMITTER_DATE: format.date },
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
}
