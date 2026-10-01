import { createGlobMatcher } from '#platform/index.js';
import { WorkspacePatchError, type WorkspacePatch } from './contract.js';
/**
 * K6 = A (owner 2026-09-30; lane Jev c93ceea4): every changed path of a host-produced patch is classified against the task's declared
 * scope (`workInput.scope.paths`, task graph v3). Derived, never persisted: both inputs are immutable (content-addressed patch artifact,
 * Run snapshot frozen at admission), so the classification is reproducible from durable evidence; `matcher` names the match rules.
 * Matching (lane Jev 4c772497): the platform deny grammar on the full path (`*`/`?` within one segment, `**` across segments,
 * brackets literal); a literal is exactly one file, a directory is written `dir/**`. A rename is a deletion plus an addition, so both
 * sides are classified; deletions and mode-only changes count. No declared scope is `unscoped`, never "in scope".
 */
export const PATCH_SCOPE_MATCHER = 1 as const;
/** Paths an error carries (the result lists every out-of-scope path; the patch itself is bounded by the snapshot limits). */
export const PATCH_SCOPE_ERROR_PATHS = 16;
export type PatchScopeMode = 'warn' | 'enforce';
interface PatchScopeBase { readonly schemaVersion: 1; readonly matcher: typeof PATCH_SCOPE_MATCHER; readonly mode: PatchScopeMode }
export type PatchScope = Readonly<PatchScopeBase & ({ status: 'unscoped' }
  | { status: 'in-scope' | 'out-of-scope'; declared: readonly string[]; outOfScope: readonly string[] })>;

export function classifyPatchScope(patch: Pick<WorkspacePatch, 'changes'>, declared: readonly string[] | null, mode: PatchScopeMode): PatchScope {
  const base = { schemaVersion: 1 as const, matcher: PATCH_SCOPE_MATCHER, mode };
  if (declared === null) return Object.freeze({ ...base, status: 'unscoped' as const });
  const matchers = declared.map(createGlobMatcher);
  const outOfScope = Object.freeze(patch.changes.map(change => change.path).filter(path => !matchers.some(match => match(path))));
  return Object.freeze({ ...base, status: outOfScope.length ? 'out-of-scope' as const : 'in-scope' as const, declared: Object.freeze([...declared]), outOfScope });
}
/** The enforce gate before any delivery write (integration claim, delivery claim). Warn never refuses. */
export function assertPatchScope(scope: PatchScope): void {
  if (scope.mode !== 'enforce') return;
  if (scope.status === 'unscoped') throw new WorkspacePatchError('PATCH_SCOPE_UNDECLARED');
  if (scope.status === 'out-of-scope') {
    const shown = scope.outOfScope.slice(0, PATCH_SCOPE_ERROR_PATHS);
    throw new WorkspacePatchError('PATCH_SCOPE_VIOLATION', undefined,
      { count: scope.outOfScope.length, paths: shown.join(', '), omitted: scope.outOfScope.length - shown.length });
  }
}
