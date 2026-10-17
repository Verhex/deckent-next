import { TargetQueueError } from '#domain/index.js';
import { GitQueueTargetApplication } from '#engine/index.js';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { GitCommand } from './git-command.js';
export { GIT_QUEUE_DISPLAY } from '#engine/index.js';
export class GitQueueTarget extends GitQueueTargetApplication {
  constructor(options: GitWorkspaceOptions, installationId: string, registeredId: string, targets: readonly string[], protectedRefs: readonly string[]) {
    const git = new GitCommand(options);
    super(options, installationId, registeredId, targets, protectedRefs, { custody: () => git.custody(), run: (args, input) => git.run(args, input),
      common: () => git.common(() => new TargetQueueError('QUEUE_AUTHORITY_REQUIRED')) });
  }
}
