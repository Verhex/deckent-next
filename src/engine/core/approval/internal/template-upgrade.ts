import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, FIRST_RUN_POLICY_TEMPLATE_VERSION, FIRST_RUN_UPGRADE_RULE_IDS, authorityDocuments, delegationWithin, describePolicyChange, evaluatePolicy, resolvePolicyBindings, firstRunTemplateAdditions, firstRunTemplateRollback, planPolicyChange, policySchema,
  type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import type { AuthorityRevision, AuthorityHistorySource } from '#engine/core/policy/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';

/** The template version that introduced the add-only delta this upgrade adds and rolls back (`FIRST_RUN_CURRENT_UPGRADE_RULE_IDS`). */
const FIRST_RUN_DELTA_VERSION = 11;
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
  readonly conflicts: readonly string[];
}

/**
 * `deckent policy upgrade --template current`: missing current first-run rules added through the governed `policy.administer@1` chain —
 * the same chain, delegation bound (I2), `authority-change` audit and authority archive (the backup of every change) as every policy change.
 * Preview reads only and names what the person lacks; apply submits only a non-empty plan on the revision read (`expect`: the caller's previewed
 * revision, else the current one), so a second run is `current` and writes nothing. Rollback removes only held rules introduced by the
 * current template version, through the same chain; earlier versions stay. Historical `template-v5` audit tags remain stable.
 */
export class PolicyTemplateUpgrade {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'administration' | 'approve'> & { readonly policy: PersistentStandingDependencies['policy'] & Partial<AuthorityHistorySource> },
    private readonly names: { readonly proposeMcpToolName: string; readonly mcpCallOperationId: string; readonly policyAdministerOperationId: string }) {}
  private async snapshot() { return policySchema.parse(await this.deps.policy.load()); }
  private missing(policy: ReturnType<typeof policySchema.parse>, principal: VerifiedPrincipal, scopeId: string, touched: Parameters<typeof delegationWithin>[2]): TemplateUpgradeMissing[] {
    const out: TemplateUpgradeMissing[] = [];
    if (evaluatePolicy(policy, { principal, scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision === 'deny') out.push('policy-administer');
    if (evaluatePolicy(policy, { principal, scopeId, action: 'decide', resource: { kind: 'approval', id: 'policy-template-upgrade' } }).decision !== 'allow') out.push('approval-decide');
    if (!delegationWithin(policy, principal, touched).ok) out.push('delegation');
    return out;
  }
  private upgraded(entry: AuthorityRevision, principal: VerifiedPrincipal, scopeId: string): boolean {
    // The installer's upgrade key names the template version it ran under. The rolled-back delta is v11's, so a v11 delta the installer added under
    // v11 or any later version is this upgrade's (POLICY-V12: the v12 bump must not orphan v11 upgrades already on disk).
    const installer = /^policy-template-upgrade-v(\d+)-([a-f0-9]{64})$/.exec(entry.key ?? '');
    if (installer && Number(installer[1]) >= FIRST_RUN_DELTA_VERSION && Number(installer[1]) <= FIRST_RUN_POLICY_TEMPLATE_VERSION) return true;
    if (entry.before.schemaVersion !== 2) return false;
    const plan = firstRunTemplateAdditions(authorityDocuments(entry.before).policy, { person: principal, ...this.names });
    if (plan.status !== 'plan') return false;
    // The governed key binds the exact plan it submitted: the current one, or the same plan without the v12 owner rules (a governed upgrade
    // made before option A, owner 2026-10-16, must stay recognizable).
    const v12: readonly string[] = [FIRST_RUN_UPGRADE_RULE_IDS.scopeInspect, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown];
    const earlier = plan.change.changes.filter(change => change.kind !== 'grant.add' || !v12.includes(change.grant.id));
    return [plan.change, ...(earlier.length && earlier.length < plan.change.changes.length ? [{ ...plan.change, changes: earlier }] : [])].some(change => {
      const tag = `template-v5:${change.changes.map(item => item.kind === 'grant.add' ? item.grant.id : '').join(',')}`;
      const commandId = sha256(`policy-template-upgrade:1\0${scopeId}\0${principal.issuer}\0${principal.subject}\0${tag}\0${entry.before.revision}`);
      return entry.key === effectWireKey({ schemaVersion: 1, commandId, scopeId, operation: POLICY_ADMINISTER_OPERATION.operation,
        target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: entry.before.revision });
    });
  }
  async run(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly mode: 'preview' | 'apply' | 'rollback'; readonly expect?: string;
    readonly reason: string }): Promise<TemplateUpgradeResult> {
    const policy = await this.snapshot();
    const result = (status: TemplateUpgradeResult['status'], extra: Partial<TemplateUpgradeResult> = {}): TemplateUpgradeResult => Object.freeze({ schemaVersion: 1, status,
      revision: policy.revision, rules: [], summary: null, missing: [], reason: null, conflicts: [], ...extra });
    if (policy.schemaVersion !== 2) return result('unavailable', { reason: 'invalid' });
    if (input.expect !== undefined && input.expect !== policy.revision) return result('conflict', { reason: 'revision-changed' });
    const files = authorityDocuments(policy);
    if (input.mode === 'rollback') {
      const delta = firstRunTemplateRollback(files.policy, input.principal, input.scopeId);
      const history = await this.deps.policy.authorityHistory?.();
      if (!history || history.length === 0) return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
      // Follow exact effective revisions back from the snapshot, never infer provenance from an id or current template alone.
      const chain = []; let revision = policy.revision;
      const visited = new Set<string>();
      while (!visited.has(revision)) {
        visited.add(revision);
        const candidates = history.filter(entry => entry.after.revision === revision);
        if (candidates.length > 1) return result('unavailable', { reason: 'history-unavailable' });
        const entry = candidates[0];
        if (!entry) {
          if (revision.split('+').some(part => part.startsWith('a-') || part.startsWith('m-'))) return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
          break;
        }
        chain.push(entry); revision = entry.before.revision;
      }
      if (chain.some(entry => entry.before.revision === policy.revision)) return result('unavailable', { reason: 'history-unavailable' });
      const conflicts = [...delta.conflicts], held: string[] = [];
      for (const rule of delta.rules) {
        const changes = chain.filter(entry => JSON.stringify(entry.before.grants.find(item => item.id === rule.id)) !== JSON.stringify(entry.after.grants.find(item => item.id === rule.id)));
        const added = changes.find(entry => !entry.before.grants.some(item => item.id === rule.id));
        if (!added) continue;
        if (!this.upgraded(added, input.principal, input.scopeId)) { conflicts.push(rule.id); continue; }
        if (changes[0] === added && JSON.stringify(added.after.grants.find(item => item.id === rule.id)) === JSON.stringify(rule)) held.push(rule.id);
        else conflicts.push(rule.id);
      }
      if (!held.length) return result('nothing-to-roll-back', { conflicts });
      const change = { schemaVersion: 1 as const, changes: held.map(id => ({ kind: 'grant.remove' as const, id })) };
      const planned = planPolicyChange(files.policy, files.bindings, change);
      const missing = this.missing(policy, input.principal, input.scopeId, planned.touched);
      // Never lock the person out: a rollback that would leave them without policy.administer or approval decisions is refused (`lockout`).
      const after = resolvePolicyBindings({ ...(planned.policy ?? files.policy as object), revision: 'planned' }, files.bindings);
      if (evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision !== 'allow'
        || evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'decide', resource: { kind: 'approval', id: 'policy-template-upgrade' } }).decision !== 'allow') missing.push('lockout');
      if (missing.length) return result('refused', { missing, conflicts });
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change, tag: `template-v5-rollback:${held.join(',')}`,
        reason: input.reason, revision: policy.revision, kind: 'policy-template-upgrade' });
      return result('rolled-back', { reason: held.join(','), conflicts });
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
