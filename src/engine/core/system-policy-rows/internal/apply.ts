import { randomUUID } from 'node:crypto';
import { verifiedPrincipalSchema, isAiPrincipal } from '#domain/index.js';
import { AUDIT_EVENT_SCHEMA_VERSION, auditEventSchema, type AuditEvent } from '#domain/index.js';
import { authorityDocuments, type Policy, resolvePolicyBindings } from '#domain/index.js';
import { governedPolicyDigest } from '#engine/core/policy/index.js';
import { CORE_SYSTEM_POLICY_ROWS, loadSystemPolicyRows, systemPolicyDigest, systemPolicyCanonical } from './registry.js';
import { bindSystemPolicyRows, planSystemPolicyRows, type SystemPolicyRowsStore, type SystemPolicyRowsTarget, type SystemPolicyRowsPlan } from './plan.js';

export interface ReconcileSystemPolicyRowsInput {
  /** Trusted installer custody; never accepted as client-authored booleans or principal fields. */
  readonly owner: boolean; readonly caller: unknown; readonly target: SystemPolicyRowsTarget;
  readonly data?: unknown; readonly expectedDigest?: string; readonly expect: string; readonly apply: boolean;
  readonly action: 'apply' | 'rollback'; readonly audit: (event: AuditEvent) => void; readonly now: () => number;
}
export interface SystemPolicyRowsResult {
  readonly status: 'preview' | 'applied' | 'rolled-back' | 'current' | 'replayed' | 'conflict' | 'unavailable' | 'unknown';
  readonly reason: string | null; readonly key: string | null; readonly revision: string | null;
  readonly plan: SystemPolicyRowsPlan | null;
}
/** Explicit installer operation only. The one authority writer owns locking, CAS, archive and crash recovery. */
export async function reconcileSystemPolicyRows(store: SystemPolicyRowsStore, input: ReconcileSystemPolicyRowsInput): Promise<SystemPolicyRowsResult> {
  const result = (status: SystemPolicyRowsResult['status'], reason: string | null = null, plan: SystemPolicyRowsPlan | null = null): SystemPolicyRowsResult =>
    Object.freeze({ status, reason, key: plan?.key ?? null, revision: plan?.revision ?? null, plan });
  const caller = verifiedPrincipalSchema.safeParse(input.caller);
  if (!input.owner || !caller.success || isAiPrincipal(caller.data) || !caller.data.scopeIds.includes(input.target.scopeId)) return result('unavailable', 'installer-required');
  let bound: ReturnType<typeof bindSystemPolicyRows>;
  try {
    const pack = loadSystemPolicyRows(input.data ?? CORE_SYSTEM_POLICY_ROWS.data, input.expectedDigest ?? CORE_SYSTEM_POLICY_ROWS.digest);
    bound = bindSystemPolicyRows(pack.data, input.target);
  } catch { return result('unavailable', 'invalid-data-or-person'); }
  const key = input.action === 'apply' ? bound.key : bound.key.replace('spr1-', 'srr1-');
  const applied = await store.lookupAuthority(key);
  if (applied === null) return result('unknown', 'journal-unavailable');
  // The durable committed key survives manual deletion and rollback: routine upgrades never re-grant it.
  if (applied.status === 'applied') return Object.freeze({ ...result('replayed'), key, revision: applied.version });
  const snapshot = await store.updateAuthority(value => ({ write: null, result: value }));
  const history = await store.authorityHistory();
  if (history === null) return result('unknown', 'journal-unavailable');
  let plan: SystemPolicyRowsPlan;
  try { plan = planSystemPolicyRows({ data: bound.data, target: input.target, snapshot, history, action: input.action }); }
  catch { return result('unavailable', 'invalid-authority'); }
  if (plan.revision !== input.expect) return result('conflict', 'revision-changed', plan);
  if (plan.status !== 'preview' || !input.apply) return result(plan.status, plan.reason, plan);
  return store.updateAuthority(current => {
    const revision = resolvePolicyBindings(current.policy, current.bindings).revision;
    if (revision !== plan.revision || systemPolicyCanonical(current) !== systemPolicyCanonical(snapshot)) return { write: null, result: result('conflict', 'revision-changed', plan) };
    const next = plan.next!;
    const before = governedPolicyDigest(current.policy, current.bindings), after = governedPolicyDigest(next.policy, next.bindings);
    if (!before || !after) return { write: null, result: result('unavailable', 'invalid-authority', plan) };
    const event = () => systemPolicyRowsPublicationEvent(bound.data, input.target, current, next, caller.data, key, input.now(), input.action);
    return { write: { policy: next.policy, bindings: next.bindings, order: input.action === 'apply' ? 'policy-first' : 'bindings-first',
      beforePublish: () => input.audit(event()) }, result: Object.freeze({ ...result(input.action === 'apply' ? 'applied' : 'rolled-back', null, plan),
        key, revision: resolvePolicyBindings(next.policy, next.bindings).revision }) };
  }, key);
}

/** Sealed before the containing installer publication, using the same data identity as the standalone reconciler. */
export function systemPolicyRowsPublicationEvent(data: import('./registry.js').SystemPolicyRows, target: SystemPolicyRowsTarget,
  before: { policy: unknown; bindings: unknown } | Policy, after: { policy: unknown; bindings: unknown },
  caller: { issuer: string; subject: string }, commandId: string, atMs: number, action: 'apply' | 'rollback' = 'apply'): AuditEvent {
  const pack = bindSystemPolicyRows(data, target), initial = 'policy' in before ? before : authorityDocuments(before);
  return auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: target.scopeId,
    principal: { issuer: caller.issuer, subject: caller.subject }, policyRevision: resolvePolicyBindings(initial.policy, initial.bindings).revision, atMs,
    subject: { kind: 'authority-change', installer: { basis: 'system-policy-rows', packageId: data.id, dataRevision: data.revision, packageDigest: pack.digest, person: target.person },
      action, commandId, inputDigest: systemPolicyDigest(after), revision: { before: resolvePolicyBindings(initial.policy, initial.bindings).revision,
        after: resolvePolicyBindings(after.policy, after.bindings).revision }, policyDigestBefore: governedPolicyDigest(initial.policy, initial.bindings), policyDigest: governedPolicyDigest(after.policy, after.bindings) } });
}
