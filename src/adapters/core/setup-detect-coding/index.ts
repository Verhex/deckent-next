// I-S2: setup detection for the coding/git family (repository, commits, own source checkout, work-target clones, coding-CLI sign-ins by stat).
export { detectCodingFacts, HOST_CODING_PORTS, type CodingCredentialSpec, type CodingDetectPorts, type PathKind } from './internal/detect.js';
export { applyFirstCommit, firstCommitGit, previewFirstCommit, FIRST_COMMIT_OPERATION_ID, type FirstCommitFlag, type FirstCommitGit, type FirstCommitGitResult, type FirstCommitPreview,
  type FirstCommitResult, type FirstCommitRow } from './internal/first-commit.js';
export { codingSetupFamily, codingFactsSchema, CODING_REPOSITORY_STAGE_ID, CODING_HOSTS_STAGE_ID, type CodingFacts } from './internal/family.js';
