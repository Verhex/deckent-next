// I-S2: setup detection for the coding/git family (repository, commits, own source checkout, work-target clones, coding-CLI sign-ins by stat).
export { detectCodingFacts, HOST_CODING_PORTS, type CodingCredentialSpec, type CodingDetectPorts, type PathKind } from './internal/detect.js';
export { applyFirstCommit, firstCommitGit, previewFirstCommit, observeFirstCommitRecovery, FIRST_COMMIT_OPERATION_ID, type FirstCommitFlag, type FirstCommitGit, type FirstCommitGitResult, type FirstCommitPreview,
  type FirstCommitResult, type FirstCommitRow } from './internal/first-commit.js';
export { gitTracksPaths } from './internal/tracked.js';
export type { FirstCommitRecovery } from './internal/first-commit-recovery.js';
export { firstCommitTarget, FIRST_COMMIT_OPERATION } from './internal/first-commit-effect.js';
export { codingSetupFamily, codingFactsSchema, CODING_REPOSITORY_STAGE_ID, CODING_HOSTS_STAGE_ID, type CodingFacts } from './internal/family.js';
