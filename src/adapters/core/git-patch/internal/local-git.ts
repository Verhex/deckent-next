/** The shared local-only Git invocation construction is owned by the git-workspace adapter (work-target inspection runs it before a
 * target is trusted); this package keeps its import path. */
export { GIT_LOCAL_ENV, localGitArgs } from '#adapters/core/git-workspace/index.js';
