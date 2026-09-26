import { companyIdSchema, policyDeclaredScopes, policyScopeGrants, policyScopeMembership } from '#domain/index.js';
import { PolicyAuthorizationError } from './authorize.js';

/** Durable scope → company pins (ledger `scope_registry`). Pins are insert-only; an absent scope has no row. */
export interface ScopeRegistryReader { pinnedCompanies(scopeIds: readonly string[]): Promise<ReadonlyMap<string, string>> }

/**
 * Application-owned, fail-closed scope membership (H34 S1). No trusted allow grant → `POLICY_DENIED` before the registry is
 * read. A granted scope counts only when it is registered to the request's company: its durable pin, or — without a pin — an
 * explicit declaration in the trusted policy (which registers it to the request's company). Anything else, including a scope
 * pinned to another company, is `SCOPE_UNKNOWN`; no flag relaxes this.
 */
export async function resolvePolicyScopeMembership(policy: unknown, actor: { readonly issuer: string; readonly subject: string },
  candidates: readonly string[], companyId: string, registry: ScopeRegistryReader): Promise<readonly string[]> {
  const company = companyIdSchema.parse(companyId);
  const granted = policyScopeGrants(policy, actor, candidates);
  if (!granted.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  const pinned = await registry.pinnedCompanies(granted); const declared = new Set(policyDeclaredScopes(policy));
  const registered = new Set(granted.filter(scope => (pinned.get(scope) ?? (declared.has(scope) ? company : undefined)) === company));
  const members = policyScopeMembership(policy, actor, granted, registered);
  if (!members.length) throw new PolicyAuthorizationError('SCOPE_UNKNOWN');
  return members;
}

/** First-start registration set: the installation's configured own scopes plus every scope the trusted policy names explicitly
 * (an unavailable policy names none). `'all'` contributes nothing. */
export function installationOwnScopes(policy: unknown, configured: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...configured, ...(policy === null ? [] : policyDeclaredScopes(policy))])]);
}
