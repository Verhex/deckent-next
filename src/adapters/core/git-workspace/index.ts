export { GitWorkspaceBroker } from './internal/broker.js';
export type { GitWorkspaceOptions, GitWorkspaceLease } from './internal/broker.js';
export { gitSourcePreimageSchema, gitSourceBaseSchema, fingerprintGitSource } from './internal/source-base.js';
export type { GitSourcePreimage, GitSourceBase } from './internal/source-base.js';
export { GitRunWorkspaceProvider } from './internal/run-provider.js';
export { GIT_LOCAL_ENV, localGitArgs } from './internal/local-git.js';
export { resolveGitWorkTarget, selectWorkTarget } from './internal/work-target.js';
export type { ResolvedGitWorkTarget, WorkTargetDeclaration, WorkTargetExecution, WorkTargetSettings } from './internal/work-target.js';
