import { delegationWithin, policyResources, policySchema, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

const { kind, actions: [action] } = policyResources.monitor;
/**
 * MON-NAMES (owner 2026-10-19, PLAN §16): whether the viewer may read refused and failed scopes by name in the monitor. The action reveals
 * other scopes' names installation-wide, so it is decided like other installation-level actions (pool hold, global config): the viewer's own
 * grants must cover `monitor inspect-scope-diagnostics` over every scope and every monitor id (the v13 rule `scopes: all`, `ids: all`); a
 * one-scope grant, a deny or restriction, an approval rule or a grant to another principal is not it, and an MCP actor never inherits a
 * person's or an everyone rule. Policy data only, never a role check. An unreadable policy throws `POLICY_UNAVAILABLE` (the caller fails closed).
 */
export function monitorScopeDiagnosticsAllowed(policy: unknown, principal: Pick<VerifiedPrincipal, 'issuer' | 'subject'>): boolean {
  try {
    return delegationWithin(policySchema.parse(policy), principal, [{ id: 'monitor-scope-diagnostics', effect: 'allow', actions: [action], scopes: 'all',
      resource: { kind, ids: 'all' } }]).ok;
  } catch { throw ErrorRegistry.createError('POLICY_UNAVAILABLE'); }
}
