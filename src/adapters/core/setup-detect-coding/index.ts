// I-S2: setup detection for the coding/git family (repository, commits, own source checkout, work-target clones, coding-CLI sign-ins by stat).
export { detectCodingFacts, workingTreeChanges } from './internal/detect.js';
export { applyFirstCommit, firstCommitGit, previewFirstCommit, observeFirstCommitRecovery, type FirstCommitGit } from './internal/first-commit.js';
export { gitTracksPaths } from './internal/tracked.js';
export { firstCommitTarget, FIRST_COMMIT_OPERATION } from './internal/first-commit-effect.js';
export { codingSetupFamily, type CodingFacts } from './internal/family.js';
