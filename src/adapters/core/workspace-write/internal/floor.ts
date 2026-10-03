import { createGlobMatcher } from '#adapters/core/workspace-read/index.js';

/**
 * Writes that always need the owner's approval, whatever policy or mode allows (T-L4 contract §5): repository internals, hooks,
 * CI, package manifests, Deckent and agent configuration. Reads of secret paths are already denied by the workspace scope.
 */
export const WORKSPACE_WRITE_APPROVAL_FLOOR: readonly string[] = Object.freeze(['.github/**', '.gitlab-ci.yml', '.circleci/**', '.husky/**', '**/.husky/**',
  'package.json', '**/package.json', 'package-lock.json', '.deckent/**', '.claude/**', '.cursor/**', '.agents/**', 'AGENTS.md', 'CLAUDE.md', 'Makefile', 'Dockerfile']);
const floorMatchers = WORKSPACE_WRITE_APPROVAL_FLOOR.map(createGlobMatcher);
/** True when a resolved workspace-relative path is on the approval floor. */
export const isWriteApprovalFloored = (rel: string) => floorMatchers.some(match => match(rel));
/** True when a workspace-relative directory is on the approval floor by its own name or as a tree (`dir/-`: what it would hold). */
export const isDirectoryWriteApprovalFloored = (rel: string) => isWriteApprovalFloored(rel) || isWriteApprovalFloored(`${rel}/-`);

/** A2 policy data: only the running build's source repository gets this additional floor. */
export const SELF_SOURCE_WRITE_APPROVAL_FLOOR: readonly string[] = Object.freeze(['src/**', 'dist/**', 'scripts/**', 'assets/**']);
const selfSourceMatchers = SELF_SOURCE_WRITE_APPROVAL_FLOOR.map(createGlobMatcher);
export const isSelfSourceWriteFloored = (rel: string) => isWriteApprovalFloored(rel) || selfSourceMatchers.some(match => match(rel));
