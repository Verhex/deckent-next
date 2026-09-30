import { sep } from 'node:path';
/** WORK-TARGETS (owner 2026-09-30 K1 = W2): a work target is a named source repository that Deckent's coding work runs against
 * instead of the project root. Slice 1 implements the Git kind only; a future non-Git workspace kind is another adapter producing
 * the same observation for its realm. Business systems (ERP) are not work targets: their effects stay on the C11 operation catalog
 * and EffectTarget port. The decision below is the one owner of the typed refusals; adapters only observe. */
export type WorkTargetErrorCode = 'WORK_TARGET_PATH_INVALID' | 'WORK_TARGET_UNSAFE' | 'WORK_TARGET_IN_DATA_ROOT' | 'WORK_TARGET_IS_PROJECT'
  | 'WORK_TARGET_NOT_WORKTREE' | 'WORK_TARGET_SHARES_PROJECT_REPOSITORY' | 'WORK_TARGET_ALTERNATES' | 'WORK_TARGET_BASE_MISSING';
export class WorkTargetError extends Error {
  constructor(readonly code: WorkTargetErrorCode) { super(code); this.name = 'WorkTargetError'; }
}
/** Facts an adapter observed about one configured target without trusting it. `null` = not observed (an earlier fact already refuses). */
export interface WorkTargetObservation {
  readonly path: string;
  /** Canonical path of an existing entry, or null when it does not resolve. */
  readonly realPath: string | null;
  /** A real directory (not a symbolic link), owned by the service user and not group/other-writable. */
  readonly safeDirectory: boolean;
  readonly repositoryRoot: string | null;
  readonly bare: boolean | null;
  /** Canonical Git common directory: shared by every worktree of one repository, so equal values mean one ref namespace. */
  readonly commonDirectory: string | null;
  readonly alternates: boolean | null;
  readonly baseCommit: string | null;
}
export interface WorkTargetContext {
  /** Canonical project root and its repository's common directory (null when the project is not inside a Git repository). */
  readonly projectRoot: string;
  readonly projectCommonDirectory: string | null;
  /** Canonical product data roots (layout root and separately located resources). */
  readonly dataRoots: readonly string[];
}
const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** Refuses, in a fixed order, every target Deckent must not write: a non-canonical path, an unsafe directory, product data, the project
 * itself, anything that is not a non-bare repository root, a repository sharing the running project's refs (a live worktree: Deckent
 * never targets its running source), borrowed objects, or a base branch that does not name a commit. */
export function assertWorkTarget(observation: WorkTargetObservation, context: WorkTargetContext): string {
  const { path, realPath } = observation;
  if (!path.startsWith('/') || realPath === null || realPath !== path) throw new WorkTargetError('WORK_TARGET_PATH_INVALID');
  if (!observation.safeDirectory) throw new WorkTargetError('WORK_TARGET_UNSAFE');
  if (context.dataRoots.some(root => within(path, root))) throw new WorkTargetError('WORK_TARGET_IN_DATA_ROOT');
  if (path === context.projectRoot) throw new WorkTargetError('WORK_TARGET_IS_PROJECT');
  if (observation.bare !== false || observation.repositoryRoot !== path || observation.commonDirectory === null) throw new WorkTargetError('WORK_TARGET_NOT_WORKTREE');
  if (observation.commonDirectory === context.projectCommonDirectory) throw new WorkTargetError('WORK_TARGET_SHARES_PROJECT_REPOSITORY');
  if (observation.alternates !== false) throw new WorkTargetError('WORK_TARGET_ALTERNATES');
  if (observation.baseCommit === null) throw new WorkTargetError('WORK_TARGET_BASE_MISSING');
  return observation.baseCommit;
}
