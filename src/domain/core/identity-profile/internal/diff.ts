import { evaluatePolicy, principalGrants, type Policy, type PolicyDecision } from '#domain/core/policy/index.js';
import { IDENTITY_PROFILE_LIMITS, IdentityProfileError, type IdentityPreviewInput } from './schema.js';

export type IdentityCellSelection = { readonly values: readonly string[] } | { readonly except: readonly string[] };
export interface IdentityPermissionDifference {
  readonly memberId: string; readonly scopeId: string; readonly resourceKind: string;
  readonly actions: IdentityCellSelection; readonly resourceIds: IdentityCellSelection;
  readonly before: PolicyDecision; readonly after: PolicyDecision; readonly change: 'gain' | 'loss' | 'unchanged';
}
function partitions(values: readonly ('all' | readonly string[])[]) {
  const names = [...new Set(values.flatMap(value => value === 'all' ? [] : value))].sort();
  const result = names.map(name => ({ representative: name, selection: Object.freeze({ values: Object.freeze([name]) }) as IdentityCellSelection }));
  if (values.includes('all')) {
    let representative = 'identity-preview-other';
    while (names.includes(representative)) representative += '-';
    result.push({ representative, selection: Object.freeze({ except: Object.freeze(names) }) });
  }
  return result;
}
const authorityRank = { deny: 0, 'require-approval': 1, allow: 2 } as const;
/** Exact finite partition of the existing evaluator's equality/all grammar, including wildcard exceptions.
 * This is hypothetical policy comparison, never verification of a member's identity or live session.
 * Terminal permission modes, SoD and approval assurance are preserved; no execution/floor bypass is inferred.
 */
export function identityPermissionDiff(input: IdentityPreviewInput, current: Policy, candidate: Policy, scopes: readonly string[]) {
  const changes: IdentityPermissionDifference[] = []; let cells = 0;
  for (const member of input.members) {
    const principal = { ...member.principal, id: member.id, assurance: 'token-verified' as const, scopeIds: scopes };
    const rules = [...principalGrants(current, principal), ...current.restrictions, ...principalGrants(candidate, principal), ...candidate.restrictions]
      .filter(rule => rule.principals === 'all' || rule.principals.some(p => p.issuer === principal.issuer && p.subject === principal.subject));
    for (const scopeId of scopes) {
      const scoped = rules.filter(rule => rule.scopes === 'all' || rule.scopes.includes(scopeId));
      for (const resourceKind of [...new Set(scoped.map(rule => rule.resource.kind))].sort()) {
        const relevant = scoped.filter(rule => rule.resource.kind === resourceKind);
        const actions = partitions(relevant.map(rule => rule.actions)), resources = partitions(relevant.map(rule => rule.resource.ids));
        if (cells + actions.length * resources.length > IDENTITY_PROFILE_LIMITS.maxPreviewCells) throw new IdentityProfileError('IDENTITY_PREVIEW_LIMIT');
        for (const action of actions) for (const resource of resources) {
          cells++;
          const request = { principal, scopeId, action: action.representative, resource: { kind: resourceKind, id: resource.representative } };
          const before = evaluatePolicy(current, request), after = evaluatePolicy(candidate, request);
          const delta = authorityRank[after.decision] - authorityRank[before.decision];
          changes.push(Object.freeze({ memberId: member.id, scopeId, resourceKind, actions: action.selection, resourceIds: resource.selection,
            before, after, change: delta > 0 ? 'gain' : delta < 0 ? 'loss' : 'unchanged' }));
        }
      }
    }
  }
  return Object.freeze(changes);
}
