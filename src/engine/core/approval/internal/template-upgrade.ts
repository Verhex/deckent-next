import { authorityDocuments, delegationWithin, describePolicyChange, evaluatePolicy, resolvePolicyBindings, firstRunTemplateAdditions, FIRST_RUN_UPGRADE_RULE_IDS, planPolicyChange, policySchema,
  type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';

/** What the person lacks for the governed upgrade, in order: the `policy.administer` operation, the right to decide its card, the cells I2 checks. */
export type TemplateUpgradeMissing = 'policy-administer' | 'approval-decide' | 'delegation' | 'lockout';
export interface TemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would add `rules`; `upgraded`: added now; `current`: nothing to add; `refused`: `missing` names why (nothing written);
   * `unavailable`: not a first-run lineage (`reason`); `rolled-back` / `nothing-to-roll-back`: upgrade rules removed / none held. */
  readonly status: 'preview' | 'upgraded' | 'current' | 'refused' | 'unavailable' | 'rolled-back' | 'nothing-to-roll-back' | 'conflict';
  readonly revision: string;
  readonly rules: readonly PolicyGrant[];
  readonly summary: string | null;
  readonly missing: readonly TemplateUpgradeMissing[];
  readonly reason: string | null;
}

/**
 * `deckent policy upgrade --template current`: missing current first-run rules added through the governed `policy.administer@1` chain —
 * the same chain, delegation bound (I2), `authority-change` audit and authority archive (the backup of every change) as every policy change.
 * Preview reads only and names what the person lacks; apply submits only a non-empty plan on the revision read (`expect`: the caller's previewed
 * revision, else the current one), so a second run is `current` and writes nothing. Rollback removes held upgrade-rule ids (by
 * id), through the same chain; nothing else is touched. Historical `template-v5` audit tags remain stable.
 */
export class PolicyTemplateUpgrade {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'administration' | 'approve' | 'policy'>,
    private readonly names: { readonly proposeMcpToolName: string; readonly mcpCallOperationId: string; readonly policyAdministerOperationId: string }) {}
  private async snapshot() { return policySchema.parse(await this.deps.policy.load()); }
  private missing(policy: ReturnType<typeof policySchema.parse>, principal: VerifiedPrincipal, scopeId: string, touched: Parameters<typeof delegationWithin>[2]): TemplateUpgradeMissing[] {
    const out: TemplateUpgradeMissing[] = [];
    if (evaluatePolicy(policy, { principal, scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision === 'deny') out.push('policy-administer');
    if (evaluatePolicy(policy, { principal, scopeId, action: 'decide', resource: { kind: 'approval', id: 'policy-template-upgrade' } }).decision !== 'allow') out.push('approval-decide');
    if (!delegationWithin(policy, principal, touched).ok) out.push('delegation');
    return out;
  }
  async run(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly mode: 'preview' | 'apply' | 'rollback'; readonly expect?: string;
    readonly reason: string }): Promise<TemplateUpgradeResult> {
    const policy = await this.snapshot();
    const result = (status: TemplateUpgradeResult['status'], extra: Partial<TemplateUpgradeResult> = {}): TemplateUpgradeResult => Object.freeze({ schemaVersion: 1, status,
      revision: policy.revision, rules: [], summary: null, missing: [], reason: null, ...extra });
    if (policy.schemaVersion !== 2) return result('unavailable', { reason: 'invalid' });
    if (input.expect !== undefined && input.expect !== policy.revision) return result('conflict', { reason: 'revision-changed' });
    const files = authorityDocuments(policy);
    if (input.mode === 'rollback') {
      const held = Object.values(FIRST_RUN_UPGRADE_RULE_IDS).filter(id => policy.grants.some(grant => grant.id === id));
      if (!held.length) return result('nothing-to-roll-back');
      const change = { schemaVersion: 1 as const, changes: held.map(id => ({ kind: 'grant.remove' as const, id })) };
      const planned = planPolicyChange(files.policy, files.bindings, change);
      const missing = this.missing(policy, input.principal, input.scopeId, planned.touched);
      // Never lock the person out: a rollback that would leave them without policy.administer or approval decisions is refused (`lockout`).
      const after = resolvePolicyBindings({ ...(planned.policy ?? files.policy as object), revision: 'planned' }, files.bindings);
      if (evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision !== 'allow'
        || evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'decide', resource: { kind: 'approval', id: 'policy-template-upgrade' } }).decision !== 'allow') missing.push('lockout');
      if (missing.length) return result('refused', { missing });
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change, tag: `template-v5-rollback:${held.join(',')}`,
        reason: input.reason, revision: policy.revision, kind: 'policy-template-upgrade' });
      return result('rolled-back', { reason: held.join(',') });
    }
    const plan = firstRunTemplateAdditions(files.policy, { person: input.principal, ...this.names });
    if (plan.status === 'unavailable') return result('unavailable', { reason: plan.reason });
    if (plan.status === 'current') return result('current');
    const summary = describePolicyChange(files, plan.change);
    const missing = this.missing(policy, input.principal, input.scopeId, planPolicyChange(files.policy, files.bindings, plan.change).touched);
    if (input.mode === 'preview') return result('preview', { rules: plan.rules, summary, missing });
    if (missing.length) return result('refused', { rules: plan.rules, summary, missing });
    await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change: plan.change, tag: `template-v5:${plan.rules.map(rule => rule.id).join(',')}`,
      reason: input.reason, revision: policy.revision, kind: 'policy-template-upgrade' });
    return result('upgraded', { rules: plan.rules, summary });
  }
}
