import { companyIdSchema, policyDeclaredScopes, policyScopeGrants, policyScopeMembership } from '#domain/index.js';
import { PolicyAuthorizationError } from './authorize.js';

/** Durable scope → company pins (ledger `scope_registry`). Pins are insert-only; an absent scope has no row. */
export interface ScopeRegistry {
  pinnedCompanies(scopeIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Insert-only pin of declared scopes to `companyId`; returns each scope's effective pin (a concurrent pin elsewhere wins and is
   * returned as is), or null when no ledger exists to pin in (then no scoped record can be admitted: writers need an existing ledger). */
  pinDeclared(scopeIds: readonly string[], companyId: string): Promise<ReadonlyMap<string, string> | null>;
}
/** `write`: the request may admit scoped records, so a declared scope is pinned before it proceeds. `read`: nothing is written; an
 * unpinned declared scope has no records yet (every write admission pins first) and resolves to the request's company for this
 * request only. */
export type ScopeAccess = 'read' | 'write';

/**
 * Application-owned, fail-closed scope membership (H34 S1, Astra 2122). No trusted allow grant → `POLICY_DENIED` before the registry
 * is touched. A granted scope counts through its durable pin to the request's company. A scope the trusted policy names explicitly
 * and that has no pin yet is pinned here, insert-only, to the request's company at its first write admission — before the caller
 * admits any scoped record — so its company never follows a later `company.id` change; once pinned, another company gets
 * `SCOPE_UNKNOWN`. `'all'` never pins or declares. Unknown or pinned elsewhere → `SCOPE_UNKNOWN`; no flag relaxes this.
 */
export async function resolvePolicyScopeMembership(policy: unknown, actor: { readonly issuer: string; readonly subject: string },
  candidates: readonly string[], companyId: string, registry: ScopeRegistry, access: ScopeAccess): Promise<readonly string[]> {
  const company = companyIdSchema.parse(companyId);
  const granted = policyScopeGrants(policy, actor, candidates);
  if (!granted.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  const pins = new Map(await registry.pinnedCompanies(granted)); const declared = new Set(policyDeclaredScopes(policy));
  const unpinned = granted.filter(scope => !pins.has(scope) && declared.has(scope));
  if (unpinned.length) {
    const written = access === 'write' ? await registry.pinDeclared(unpinned, company) : null;
    for (const scope of unpinned) pins.set(scope, written ? written.get(scope) ?? '' : company);
  }
  const registered = new Set(granted.filter(scope => pins.get(scope) === company));
  const members = policyScopeMembership(policy, actor, granted, registered);
  if (!members.length) {
    const foreign = granted.some(scope => { const pin = pins.get(scope); return pin !== undefined && pin !== '' && pin !== company; });
    throw new PolicyAuthorizationError('SCOPE_UNKNOWN', foreign ? 'COMPANY' : 'UNREGISTERED');
  }
  return members;
}

/**
 * The same company rule where one installation acts on another installation's records (H34 S3): the target's membership resolved the
 * scope to `scopeCompany` (its pin, or the target's company for an unpinned read); a request made for `requestCompany` never reaches
 * it otherwise. Refused as `SCOPE_UNKNOWN` (reason `COMPANY`) before any of the target's records is read.
 */
export function assertRequestCompany(scopeCompany: string, requestCompany: string): void {
  if (companyIdSchema.parse(scopeCompany) !== companyIdSchema.parse(requestCompany)) throw new PolicyAuthorizationError('SCOPE_UNKNOWN', 'COMPANY');
}

/** First-start registration set: the installation's configured own scopes plus every scope the trusted policy names explicitly
 * (an unavailable policy names none). `'all'` contributes nothing. */
export function installationOwnScopes(policy: unknown, configured: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...configured, ...(policy === null ? [] : policyDeclaredScopes(policy))])]);
}

/** H34 S3 Q1 (owner 2026-09-27 evening decision 6): one or more of the installation's own scopes (from `installationOwnScopes`) is
 * already pinned to another company at start. `scopeIds` names only this installation's own scope ids, never the other company
 * (Astra 2122/2123 non-disclosure extends to start). */
export class ScopeRegistrationError extends Error {
  constructor(readonly code: 'RUNTIME_SERVICE_SCOPE_FOREIGN', readonly scopeIds: readonly string[]) { super(code); this.name = 'ScopeRegistrationError'; }
}
