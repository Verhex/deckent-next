export { GitWorkspaceBroker, runBaseRepository, runBasesRoot } from './internal/broker.js';
export type { GitWorkspaceOptions, GitWorkspaceLease } from './internal/broker.js';
export { gitSourcePreimageSchema, gitSourceBaseSchema, fingerprintGitSource } from './internal/source-base.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ GitSourcePreimage, GitSourceBase } from './internal/source-base.js';
export { GitRunWorkspaceProvider } from './internal/run-provider.js';
export { GIT_LOCAL_ENV, localGitArgs } from './internal/local-git.js';
export { resolveGitWorkTarget, selectWorkTarget } from './internal/work-target.js';
export { gitRefFileSource, workTargetRefFileSource } from './internal/committed-file.js';
export type { ResolvedGitWorkTarget, WorkTargetDeclaration, WorkTargetExecution, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WorkTargetSettings } from './internal/work-target.js';
