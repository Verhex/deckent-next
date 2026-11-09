import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, FIRST_RUN_POLICY_TEMPLATE_VERSION, FIRST_RUN_UPGRADE_RULE_IDS, FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_CURRENT_UPGRADE_VERSION, authorityDocuments, firstRunBindingsRevision, delegationWithin, describePolicyChange, evaluatePolicy, resolvePolicyBindings, firstRunTemplateAdditions, firstRunTemplateRollback, matchFirstRunPolicyTemplate, mcpPrincipalRef, planPolicyChange, principalGrants,
  type FirstRunPolicyTemplateInput, type FirstRunProposalCover, type Policy, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { optionalField, sha256 } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import { administeredSince, policyTemplateUpgradeKeyVersion, type AuthorityRevision, type AuthorityHistorySource } from '#engine/core/policy/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';
/** The upgrade's approval card id (`approval`/`decide`, an AI-floored authority card) and its change kind (the command id's tag). */
const UPGRADE = 'policy-template-upgrade';
/** What the person lacks for the governed upgrade, in order: the `policy.administer` operation, the right to decide its card, the cells I2 checks. */
export type TemplateUpgradeMissing = 'policy-administer' | 'approval-decide' | 'delegation' | 'lockout';
export interface TemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would add `rules`; `upgraded`: added now; `current`: nothing to add; `refused`: `missing` names why (nothing written);
   * `unavailable`: not a first-run lineage, or (rollback) its archived history is missing (`reason`); `rolled-back` / `nothing-to-roll-back`: upgrade
   * rules removed (a provably fresh install's own delta too, owner 2026-11-05) / none held (`no-upgrade-recorded` is no longer produced). */
  readonly status: 'preview' | 'upgraded' | 'current' | 'refused' | 'unavailable' | 'rolled-back' | 'nothing-to-roll-back' | 'conflict';
  readonly revision: string;
  readonly rules: readonly PolicyGrant[];
  readonly summary: string | null;
  readonly missing: readonly TemplateUpgradeMissing[];
  readonly reason: string | null;
  readonly conflicts: readonly string[]; /** A scoped (`only`) read: the current delta's rule ids the policy holds now, and those an allow covers instead. */ readonly held?: readonly string[]; readonly covered?: readonly FirstRunProposalCover[];
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
    /** The installer's first-run tool names, and the scope's configured runtime service id (Astra 2596: never a guessed default when one is configured). */
    private readonly names: Omit<FirstRunPolicyTemplateInput, 'scopeId' | 'principal'>) {}
  private missing(policy: Policy, principal: VerifiedPrincipal, scopeId: string, touched: Parameters<typeof delegationWithin>[2]): TemplateUpgradeMissing[] {
    const out: TemplateUpgradeMissing[] = [];
    if (evaluatePolicy(policy, { principal, scopeId, action: 'execute', resource: { kind: 'operation', id: POLICY_ADMINISTER_OPERATION.operation.id } }).decision === 'deny') out.push('policy-administer');
    if (evaluatePolicy(policy, { principal, scopeId, action: 'decide', resource: { kind: 'approval', id: UPGRADE } }).decision !== 'allow') out.push('approval-decide');
    if (!delegationWithin(policy, principal, touched).ok) out.push('delegation');
    return out;
  }
  private upgraded(entry: AuthorityRevision, principal: VerifiedPrincipal, scopeId: string): boolean {
    // The installer's key must name a version that can actually have added the current delta (v20's proposal rules; the automatic upgrade too).
    // Earlier template upgrades cannot prove custody of this later grant.
    const installer = policyTemplateUpgradeKeyVersion(entry.key);
    if (installer !== null && installer >= FIRST_RUN_CURRENT_UPGRADE_VERSION && installer <= FIRST_RUN_POLICY_TEMPLATE_VERSION) return true;
    if (entry.before.schemaVersion !== 2) return false;
    // The historical plan's own service id (the stop rule this entry added), not today's configuration: a later identity change keeps it recognizable.
    const before = entry.before, added = entry.after.schemaVersion === 2 ? entry.after.grants.find(rule => rule.id === FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown
      && !before.grants.some(item => item.id === rule.id)) : undefined;
    const serviceId = added && added.resource.ids !== 'all' && added.resource.ids.length === 1 ? added.resource.ids[0] : this.names.serviceId;
    const prior = authorityDocuments(entry.before).policy, aiGrants = principalGrants(entry.before, mcpPrincipalRef(principal)), plan = firstRunTemplateAdditions(prior, { person: principal, scopeId, ...this.names, ...optionalField('serviceId', serviceId), aiGrants });
    if (plan.status !== 'plan') return false;
    // The governed key binds the exact plan it submitted: the current one, or the same plan without the v12 owner rules (a governed upgrade
    // made before option A, owner 2026-10-16, must stay recognizable).
    // Astra 2598: when the historical stop was covered by another allow (no stop rule added), the plan then was today's without its stop rule; the
    // exact effect key below decides which one it was.
    const without = (ids: readonly string[]) => plan.change.changes.filter(change => change.kind !== 'grant.add' || !ids.includes(change.grant.id));
    const variants = [without([FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown]), without([FIRST_RUN_UPGRADE_RULE_IDS.scopeInspect, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown])]
      .filter((changes, index, all) => changes.length > 0 && changes.length < plan.change.changes.length && all.findIndex(other => other.length === changes.length) === index);
    const scoped = firstRunTemplateAdditions(prior, { person: principal, scopeId, ...this.names, ...optionalField('serviceId', serviceId), only: 'ai-proposals', aiGrants });
    return [plan.change, ...variants.map(changes => ({ ...plan.change, changes })), ...(scoped.status === 'plan' ? [scoped.change] : [])].some(change => { // scoped: /policy's re-enable (alpha.64)
      const tag = `template-v5:${change.changes.map(item => item.kind === 'grant.add' ? item.grant.id : '').join(',')}`;
      const commandId = sha256(`${UPGRADE}:1\0${scopeId}\0${principal.issuer}\0${principal.subject}\0${tag}\0${entry.before.revision}`);
      return entry.key === effectWireKey({ schemaVersion: 1, commandId, scopeId, operation: POLICY_ADMINISTER_OPERATION.operation,
        target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: entry.before.revision });
    });
  }
  async run(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly mode: 'preview' | 'apply' | 'rollback'; readonly expect?: string;
    readonly reason: string; /** alpha.64: preview and apply only the current delta (the AI actor's v20 proposal rules); rollback removes only it anyway. */ readonly only?: 'ai-proposals' }): Promise<TemplateUpgradeResult> {
    const policy = await this.deps.policy.load();
    const result = (status: TemplateUpgradeResult['status'], extra: Partial<TemplateUpgradeResult> = {}): TemplateUpgradeResult => Object.freeze({ schemaVersion: 1, status,
      revision: policy.revision, rules: [], summary: null, missing: [], reason: null, conflicts: [], ...extra });
    if (policy.schemaVersion !== 2) return result('unavailable', { reason: 'invalid' });
    if (input.expect !== undefined && input.expect !== policy.revision) return result('conflict', { reason: 'revision-changed' });
    const files = authorityDocuments(policy);
    if (input.mode === 'rollback') {
      const delta = firstRunTemplateRollback(files.policy, input.principal, input.scopeId);
      const history = await this.deps.policy.authorityHistory?.();
      // J3, amended by the owner 2026-11-05 (R4a) for the MCP-actor delta (v20 now): a policy at a template's own revision that carries the whole delta
      // (no `a-`/`m-` write since) is a provably fresh install, and the installer wrote that delta, so the same card removes it. Any other policy
      // without archived history stays `history-unavailable` (fail closed).
      const template = administeredSince(policy.revision) ? null : matchFirstRunPolicyTemplate(policy.policyRevision);
      // The whole expected delta held, none differing from the template's and none removed (a hand edit that kept the revision is not "the
      // template's own version"; review 2672).
      // An exact installer upgrade keeps the older template's bindings revision, so a lost archive after an upgrade stays a refusal rather than
      // "nothing to roll back".
      const installed = template !== null && template.version >= FIRST_RUN_CURRENT_UPGRADE_VERSION && policy.bindings.revision === firstRunBindingsRevision(policy.policyRevision)
        && delta.rules.length > 0 && delta.conflicts.length === 0 && (delta.missing ?? []).length === 0;
      if (!history || history.length === 0 && !installed) return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
      // Follow exact effective revisions back from the snapshot, never infer provenance from an id or current template alone.
      const chain = []; let revision = policy.revision;
      const visited = new Set<string>();
      while (!visited.has(revision)) {
        visited.add(revision);
        const candidates = history.filter(entry => entry.after.revision === revision);
        if (candidates.length > 1) return result('unavailable', { reason: 'history-unavailable' });
        const entry = candidates[0];
        if (!entry) {
          if (administeredSince(revision)) return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
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
      if (installed && chain.length === 0) held.push(...delta.rules.map(rule => rule.id));
      if (!held.length) return result('nothing-to-roll-back', { conflicts });
      const change = { schemaVersion: 1 as const, changes: held.map(id => ({ kind: 'grant.remove' as const, id })) };
      const planned = planPolicyChange(files.policy, files.bindings, change);
      const missing = this.missing(policy, input.principal, input.scopeId, planned.touched);
      // Never lock the person out: a rollback that would leave them without policy.administer or approval decisions is refused (`lockout`).
      const after = resolvePolicyBindings({ ...(planned.policy ?? files.policy as object), revision: 'planned' }, files.bindings);
      if (evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'execute', resource: { kind: 'operation', id: POLICY_ADMINISTER_OPERATION.operation.id } }).decision !== 'allow'
        || evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'decide', resource: { kind: 'approval', id: UPGRADE } }).decision !== 'allow') missing.push('lockout');
      if (missing.length) return result('refused', { missing, conflicts });
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change, tag: `template-v5-rollback:${held.join(',')}`,
        reason: input.reason, revision: policy.revision, kind: UPGRADE });
      return result('rolled-back', { reason: held.join(','), conflicts });
    }
    const plan = firstRunTemplateAdditions(files.policy, { person: input.principal, scopeId: input.scopeId, ...this.names, ...(input.only ? { only: input.only } : {}), aiGrants: principalGrants(policy, mcpPrincipalRef(input.principal)) });
    const held = input.only /* the delta rules held now (what a rollback removes) and those an allow covers: /policy's row and its cards */ ? { held: FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.filter(id => policy.grants.some(rule => rule.id === id)), ...(plan.status !== 'unavailable' && plan.covered ? { covered: plan.covered } : {}) } : {};
    if (plan.status === 'unavailable') return result('unavailable', { reason: plan.reason, ...held });
    if (plan.status === 'current') return result('current', held);
    const summary = describePolicyChange(files, plan.change);
    const missing = this.missing(policy, input.principal, input.scopeId, planPolicyChange(files.policy, files.bindings, plan.change).touched);
    if (input.mode === 'preview') return result('preview', { rules: plan.rules, summary, missing, ...held });
    if (missing.length) return result('refused', { rules: plan.rules, summary, missing });
    await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change: plan.change, tag: `template-v5:${plan.rules.map(rule => rule.id).join(',')}`,
      reason: input.reason, revision: policy.revision, kind: UPGRADE });
    return result('upgraded', { rules: plan.rules, summary });
  }
}
