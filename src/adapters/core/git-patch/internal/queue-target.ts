import { realpath, lstat } from 'node:fs/promises';
import { TargetQueueError } from '#domain/index.js';
import { GitQueueTargetApplication } from '#engine/index.js';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GitCommand } from './git-command.js';
export { GIT_QUEUE_DISPLAY } from '#engine/index.js';
export class GitQueueTarget extends GitQueueTargetApplication {
  constructor(options: GitWorkspaceOptions, installationId: string, registeredId: string, targets: readonly string[], protectedRefs: readonly string[]) {
    const git = new GitCommand(options);
    super(options, installationId, registeredId, targets, protectedRefs, { custody: () => git.custody(), run: (args, input) => git.run(args, input),
      async common() { const path = await realpath(await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'])), stat = await lstat(path);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
        return { path, device: stat.dev, inode: stat.ino }; } });
  }
}
