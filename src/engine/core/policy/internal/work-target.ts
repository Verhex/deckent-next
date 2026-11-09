import { type Policy, evaluatePolicy, matchingRuleIds, policyResources, type AttemptIdentity, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchAuthorization, DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { PolicyAuthorizationError, type PolicySource } from './authorize.js';
import { policyVerdictRefusal } from './verdict.js';
import { PoolPolicyAuthorization, type PoolAuthorization } from './pool.js';

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkTargetAction = typeof policyResources.workTarget.actions[number];
/** Current authority over one configured work target (WORK-TARGETS, owner 2026-09-30 K2 = A); the resource id is the target id. */
export class WorkTargetPolicyAuthorization {
  constructor(private readonly source: PolicySource) {}
  async authorize(action: WorkTargetAction, targetId: string, scopeId: string, principal: VerifiedPrincipal, policy?: Policy): Promise<void> {
    let decision;
    try { decision = evaluatePolicy(policy ?? await this.source.load(), { principal, action, scopeId, resource: { kind: policyResources.workTarget.kind, id: targetId } }); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    const refusal = policyVerdictRefusal(decision.decision, { deny: 'POLICY_DENIED' });
    if (refusal) throw new PolicyAuthorizationError(refusal);
  }
}
/** Execution resources a Run consumes at admission and reservation: its pool and, when a work target is configured, that target
 * (`work-target:use`). Without a target id this is exactly the pool check. Slice 1 takes the id from the current config at both checks;
 * the Run does not record it yet. */
export function executionResourceAuthorization(source: PolicySource, workTargetId: string | null): PoolAuthorization {
  const pool = new PoolPolicyAuthorization(source);
  if (workTargetId === null) return pool;
  const target = new WorkTargetPolicyAuthorization(source);
  return { async authorize(poolId, scopeId, principal) {
    await pool.authorize(poolId, scopeId, principal);
    await target.authorize('use', workTargetId, scopeId, principal);
  } };
}
/** `work-target:use` on a configured target before an operation reads or writes it outside an attempt check (a delivery-pinned Run
 * reads the target to pin its base). No target id: nothing to check. */
export async function authorizeWorkTargetUse(source: PolicySource, workTargetId: string | null, scopeId: string, principal: VerifiedPrincipal): Promise<void> {
  if (workTargetId !== null) await new WorkTargetPolicyAuthorization(source).authorize('use', workTargetId, scopeId, principal);
}
/** Target action each attempt action consumes (Sol WT-R1, lead 2026-09-30: no target is consumed without authority, reading it included).
 * execute clones the target, prepare-integration observes and clones it, deliver-integration observes it and writes its delivery ref:
 * `use`. Adopt/rollback move its branch: `adopt`. read-output/recover-output consume it only in operations that read the target
 * (`readsTarget`: patch preparation, integration check/prepare, delivery, adoption); elsewhere they read ledger/artifacts only. */
const TARGET_ACTIONS: Readonly<Partial<Record<CorePolicyAction<'attempt'>, WorkTargetAction>>> = Object.freeze({ execute: 'use',
  'prepare-integration': 'use', 'deliver-integration': 'use', 'adopt-integration': 'adopt', 'rollback-integration': 'adopt' });
/** Attempt authorization when a work target is configured: the attempt action AND the target action it consumes, at every check the
 * attempt authorization already has (the first check and each freshness re-check, e.g. the launch gate of DispatchApplication, the
 * publication re-check of delivery and the adoption re-check before the effect). attempt actions never substitute for the target action;
 * the attempt gate runs first and is never bypassed. The caller passes the id of the target the same operation consumes (one config
 * snapshot). Without a target id: unchanged. */
export function workTargetAttemptAuthorization<A extends DispatchAuthorization & DispatchIdentityAuthorization>(attempts: A, source: PolicySource,
  workTargetId: string | null, readsTarget = false): DispatchAuthorization & DispatchIdentityAuthorization {
  if (workTargetId === null) return attempts;
  const target = new WorkTargetPolicyAuthorization(source);
  const consumed = (action: CorePolicyAction<'attempt'>): WorkTargetAction | null => TARGET_ACTIONS[action]
    ?? (readsTarget && (action === 'read-output' || action === 'recover-output') ? 'use' : null);
  const authorizeIdentity = async (action: CorePolicyAction<'attempt'>, identity: AttemptIdentity, principal: VerifiedPrincipal, policy?: Policy) => {
    await attempts.authorizeIdentity(action, identity, principal, policy);
    const targetAction = consumed(action);
    if (targetAction) await target.authorize(targetAction, workTargetId, identity.scopeId, principal, policy);
  };
  return { authorizeIdentity, authorize: (action, request, principal) => authorizeIdentity(action, request.identity, principal) };
}
/** Owner 2026-11-05 ("ayar + şirket politikası"): a delivery that writes the person's files rides on `deliver-integration` and is open by default
 * (no new grant, no template or upgrade step); a company closes it with a deny grant or restriction on the attempt action `deliver-working-tree`,
 * checked at every `deliver-integration` check of that delivery. A deny is a typed refusal, never a fall back to the reference path. */
export function workingTreeDeliveryAuthorization(attempts: DispatchIdentityAuthorization, source: PolicySource): DispatchIdentityAuthorization {
  return { async authorizeIdentity(action, identity, principal) {
    if (action !== 'deliver-integration') return attempts.authorizeIdentity(action, identity, principal);
    let policy;
    try { policy = await source.load(); } catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    await attempts.authorizeIdentity(action, identity, principal, policy);
    // L1c: a company `require-approval` here would need a second approver this delivery has no path for: refused typed, never ignored.
    let denied, asked;
    try { const request = { principal, action: 'deliver-working-tree', scopeId: identity.scopeId, resource: { kind: policyResources.attempt.kind, id: identity.attemptId } };
      denied = matchingRuleIds(policy, request, 'deny'); asked = matchingRuleIds(policy, request, 'require-approval'); }
    catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
    if (denied.length) throw new PolicyAuthorizationError('DELIVERY_WORKING_TREE_DENIED');
    if (asked.length) throw new PolicyAuthorizationError('DELIVERY_WORKING_TREE_APPROVAL_UNSUPPORTED');
  } };
}
