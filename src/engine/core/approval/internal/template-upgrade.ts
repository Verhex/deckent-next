import { AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, FIRST_RUN_UPGRADE_RULE_IDS, FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_CURRENT_UPGRADE_VERSION, FIRST_RUN_PROPOSAL_UPGRADE_VERSION, FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS, isAiPrincipal, authorityDocuments, immutableJsonObjectSchema, policyFileSchema, firstRunBindingsRevision, delegationWithin, describePolicyChange, evaluatePolicy, resolvePolicyBindings, firstRunTemplateAdditions, namedPersonPolicyAdditions, firstRunTemplateRollback, firstRunExecutionRules, firstRunProposalRules, matchFirstRunPolicyTemplate, mcpPrincipalRef, planPolicyChange, principalGrants,
  type FirstRunPolicyTemplateInput, type FirstRunProposalCover, type Policy, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { optionalField, sha256 } from '#platform/index.js';
import { effectWireKey } from '#engine/core/effect/index.js';
import { administeredSince, policyTemplateUpgradeKey, policyTemplateUpgradeKeyVersion, type AuthorityRevision, type AuthorityHistorySource } from '#engine/core/policy/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';
/** The upgrade's approval card id (`approval`/`decide`, an AI-floored authority card) and its change kind (the command id's tag). */
const UPGRADE = 'policy-template-upgrade';
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). What the person lacks for the governed upgrade, in order: the `policy.administer` operation, the right to decide its card, the cells I2 checks. */
export type TemplateUpgradeMissing = 'policy-administer' | 'approval-decide' | 'delegation' | 'lockout';
export interface TemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would add `rules` (or remove them with `previewRollback`); `upgraded`: added now; `current`: nothing to add; `refused`: `missing` names why (nothing written);
   * `unavailable`: not a first-run lineage, or (rollback) its archived history is missing (`reason`); `rolled-back` / `nothing-to-roll-back`: upgrade
   * rules removed (a provably fresh install's own delta too, owner 2026-11-05) / none held (`no-upgrade-recorded` is no longer produced). */
  readonly status: 'preview' | 'upgraded' | 'current' | 'refused' | 'unavailable' | 'rolled-back' | 'nothing-to-roll-back' | 'conflict';
  readonly revision: string;
  readonly rules: readonly PolicyGrant[];
  /** Effective grants used only to describe a genuine partial execution upgrade. */
  readonly executionContext?: readonly PolicyGrant[];
  /** Validated scopes from the addition or removal planner (`*` includes all scopes); response only. */ readonly executionScopes?: readonly string[];
  /** Read-only observation of witnessed execution adds for this principal and scope; never persisted. */
  readonly executionHistory?: 'never' | 'withdrawn' | 'unknown';
  /** Complete ordered change description for previews/results; the separately sealed card keeps its own 2048 bound. */
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
  private upgraded(entry: AuthorityRevision, principal: VerifiedPrincipal, scopeId: string, proposals: boolean, rule?: PolicyGrant): boolean {
    if (rule && (entry.before.grants.some(item => item.id === rule.id)
      || JSON.stringify(entry.after.grants.find(item => item.id === rule.id)) !== JSON.stringify(rule))) return false;
    // The installer's key must name a version that can actually have added the current delta (v20's proposal rules; the automatic upgrade too).
    // Earlier template upgrades cannot prove custody of this later grant.
    const installer = policyTemplateUpgradeKeyVersion(entry.key);
    if (installer !== null && proposals) return installer >= FIRST_RUN_PROPOSAL_UPGRADE_VERSION && installer <= FIRST_RUN_CURRENT_UPGRADE_VERSION;
    if (installer !== null) {
      if (installer !== FIRST_RUN_CURRENT_UPGRADE_VERSION || entry.before.schemaVersion !== 2) return false;
      const files = authorityDocuments(entry.before), plan = firstRunTemplateAdditions(files.policy,
        { person: principal, scopeId, ...this.names, only: 'ai-execution', aiGrants: principalGrants(entry.before, mcpPrincipalRef(principal)) });
      const named = plan.status === 'unavailable' && plan.reason === 'not-first-run' ? namedPersonPolicyAdditions(files.policy,
        { person: principal, scopeId, ...this.names, only: 'ai-execution', aiGrants: principalGrants(entry.before, mcpPrincipalRef(principal)) }) : plan;
      if (named.status !== 'plan') return false;
      const prior = policyFileSchema.parse(files.policy);
      const body = { ...prior, grants: [...prior.grants, ...named.rules] };
      const revision = `a-${sha256(`policy-template-upgrade:1\0${prior.revision}\0${JSON.stringify({ ...body, revision: undefined })}`).slice(0, 40)}`;
      const after = { ...body, revision };
      return entry.key === policyTemplateUpgradeKey(FIRST_RUN_CURRENT_UPGRADE_VERSION, sha256(`${prior.revision}\0${JSON.stringify(immutableJsonObjectSchema.parse(after))}`))
        && JSON.stringify(policyFileSchema.parse(authorityDocuments(entry.after).policy)) === JSON.stringify(policyFileSchema.parse(after))
        && JSON.stringify(authorityDocuments(entry.after).bindings) === JSON.stringify(files.bindings);
    }
    if (entry.before.schemaVersion !== 2) return false;
    // The historical plan's own service id (the stop rule this entry added), not today's configuration: a later identity change keeps it recognizable.
    const before = entry.before, added = entry.after.schemaVersion === 2 ? entry.after.grants.find(rule => rule.id === FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown
      && !before.grants.some(item => item.id === rule.id)) : undefined;
    const serviceId = added && added.resource.ids !== 'all' && added.resource.ids.length === 1 ? added.resource.ids[0] : this.names.serviceId;
    const prior = authorityDocuments(entry.before).policy, aiGrants = principalGrants(entry.before, mcpPrincipalRef(principal));
    const additions = (only?: 'ai-proposals' | 'ai-execution') => {
      const names = { person: principal, scopeId, ...this.names, ...optionalField('serviceId', serviceId), ...optionalField('only', only), aiGrants };
      const firstRun = firstRunTemplateAdditions(prior, names);
      return firstRun.status === 'unavailable' && firstRun.reason === 'not-first-run' ? namedPersonPolicyAdditions(prior, names) : firstRun;
    };
    const plan = additions();
    if (plan.status !== 'plan') return false;
    // The governed key binds the exact plan it submitted: the current one, or the same plan without the v12 owner rules (a governed upgrade
    // made before option A, owner 2026-10-16, must stay recognizable).
    // Astra 2598: when the historical stop was covered by another allow (no stop rule added), the plan then was today's without its stop rule; the
    // exact effect key below decides which one it was.
    const without = (ids: readonly string[]) => plan.change.changes.filter(change => change.kind !== 'grant.add' || !ids.includes(change.grant.id));
    const variants = [without(FIRST_RUN_CURRENT_UPGRADE_RULE_IDS), without([...FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown]), without([...FIRST_RUN_CURRENT_UPGRADE_RULE_IDS, FIRST_RUN_UPGRADE_RULE_IDS.scopeInspect, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown]), without([FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown]), without([FIRST_RUN_UPGRADE_RULE_IDS.scopeInspect, FIRST_RUN_UPGRADE_RULE_IDS.serviceShutdown])]
      .filter((changes, index, all) => changes.length > 0 && changes.length < plan.change.changes.length && all.findIndex(other => other.length === changes.length) === index);
    const execution = additions('ai-execution');
    const scoped = additions('ai-proposals');
    return [plan.change, ...variants.map(changes => ({ ...plan.change, changes })), ...(scoped.status === 'plan' ? [scoped.change] : []), ...(execution.status === 'plan' ? [execution.change] : [])].some(change => { // scoped: /policy's re-enable (alpha.64)
      const tag = `template-v5:${change.changes.map(item => item.kind === 'grant.add' ? item.grant.id : '').join(',')}`;
      const commandId = sha256(`${UPGRADE}:1\0${scopeId}\0${principal.issuer}\0${principal.subject}\0${tag}\0${entry.before.revision}`);
      return (!rule || change.changes.some(item => item.kind === 'grant.add' && JSON.stringify(item.grant) === JSON.stringify(rule)))
        && entry.key === effectWireKey({ schemaVersion: 1, commandId, scopeId, operation: POLICY_ADMINISTER_OPERATION.operation,
          target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: change, expectedVersion: entry.before.revision });
    });
  }
  private async executionHistory(policy: Policy, principal: VerifiedPrincipal, scopeId: string, root?: Policy | null): Promise<'never' | 'withdrawn' | 'unknown'> {
    try {
      const history = await this.deps.policy.authorityHistory?.();
      if (!history) return 'unknown';
      const keys = history.flatMap(entry => entry.key === null ? [] : [entry.key]);
      if (new Set(keys).size !== keys.length) return 'unknown';
      const chain: AuthorityRevision[] = [], visited = new Set<string>();
      const canonical = (value: Policy) => JSON.stringify(immutableJsonObjectSchema.parse(value));
      let terminal = policy, revision = policy.revision;
      while (true) {
        if (visited.has(revision)) return 'unknown';
        visited.add(revision);
        const candidates = history.filter(entry => entry.after.revision === revision);
        if (candidates.length > 1) return 'unknown';
        const entry = candidates[0];
        if (!entry) break;
        if (history.filter(item => item.before.revision === entry.before.revision).length !== 1) return 'unknown';
        if (canonical(entry.after) !== canonical(terminal)) return 'unknown';
        chain.push(entry); terminal = entry.before; revision = entry.before.revision;
      }
      // Disconnected, truncated or duplicate archive branches cannot prove the installation's earlier state.
      if (chain.length !== history.length) return 'unknown';
      const family = (rule: PolicyGrant) => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => id === rule.id) && rule.scopes !== 'all'
        && rule.scopes.includes(scopeId) && firstRunExecutionRules([], principal, rule.scopes).wanted.some(want => JSON.stringify(want) === JSON.stringify(rule));
      const recognized = (entry: AuthorityRevision, rule: PolicyGrant) => rule.scopes !== 'all' && rule.scopes.some(scope => this.upgraded(entry, principal, scope, false, rule));
      const witnessed = chain.flatMap(entry => entry.after.grants.filter(rule => family(rule) && recognized(entry, rule)));
      const states = [policy, terminal, ...(root ? [root] : []), ...chain.flatMap(entry => [entry.before, entry.after])];
      if ([...terminal.grants, ...(root?.grants ?? [])].some(family)
        || states.some(state => state.grants.some(rule => family(rule) && !witnessed.some(added => JSON.stringify(added) === JSON.stringify(rule))))
        || chain.some(entry => entry.after.grants.some(rule => family(rule)
          && !entry.before.grants.some(old => JSON.stringify(old) === JSON.stringify(rule)) && !recognized(entry, rule)))) return 'unknown';
      if (witnessed.some(rule => !policy.grants.some(held => JSON.stringify(held) === JSON.stringify(rule)))) return 'withdrawn';
      // A witnessed add proves withdrawal above a missing older prefix, just as rollback does; absence never proves 'never'.
      if (administeredSince(revision) && !(root && terminal.revision === root.revision && canonical(terminal) === canonical(root))) return 'unknown';
      // An unproved current/initial execution rule must never be described as never granted.
      if (policy.grants.some(family) || (chain.at(-1)?.before.grants ?? []).some(family)) return 'unknown';
      return 'never';
    } catch { return 'unknown'; }
  }
  async run(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly mode: 'preview' | 'apply' | 'rollback'; readonly previewRollback?: boolean; readonly expect?: string;
    readonly reason: string; /** The v20 proposal toggle/rollback selects its family explicitly. */ readonly only?: 'ai-proposals' | 'ai-execution' }, verifiedRoot?: Policy | null): Promise<TemplateUpgradeResult> {
    const policy = await this.deps.policy.load();
    const executionHistory = input.mode === 'preview' && input.only !== 'ai-proposals'
      ? { executionHistory: await this.executionHistory(policy, input.principal, input.scopeId, verifiedRoot) } : {};
    const result = (status: TemplateUpgradeResult['status'], extra: Partial<TemplateUpgradeResult> = {}): TemplateUpgradeResult => Object.freeze({ schemaVersion: 1, status,
      revision: policy.revision, rules: [], summary: null, missing: [], reason: null, conflicts: [], ...executionHistory, ...extra });
    if (policy.schemaVersion !== 2) return result('unavailable', { reason: 'invalid' });
    if (input.mode !== 'preview' && isAiPrincipal(input.principal)) return result('refused', { missing: ['policy-administer'] });
    if (input.expect !== undefined && input.expect !== policy.revision) return result('conflict', { reason: 'revision-changed' });
    const files = authorityDocuments(policy);
    if (input.mode === 'rollback' || input.mode === 'preview' && input.previewRollback) {
      const selected = firstRunTemplateRollback(files.policy, input.principal, input.scopeId, input.only);
      const history = await this.deps.policy.authorityHistory?.();
      // Origin first: the historical BEFORE planner and exact key must prove each absent-before/add-after rule.
      const witnessed = input.only === 'ai-proposals' ? [] : policy.grants.filter(rule => FIRST_RUN_CURRENT_UPGRADE_RULE_IDS.some(id => id === rule.id)
        && history?.some(entry => this.upgraded(entry, input.principal, input.scopeId, false, rule)))
        // Only a proven after-rule supplies its scope list for canonical shape; today's read anchor is irrelevant.
        .filter(rule => rule.scopes !== 'all' && rule.scopes.includes(input.scopeId)
          && firstRunExecutionRules([], input.principal, rule.scopes).wanted.some(want => JSON.stringify(want) === JSON.stringify(rule)));
      const delta = { ...selected, rules: [...selected.rules, ...witnessed.filter(rule => !selected.rules.some(item => item.id === rule.id))],
        conflicts: selected.conflicts.filter(id => !witnessed.some(rule => rule.id === id)) };
      // J3, amended by the owner 2026-11-05 (R4a) for the MCP-actor delta (v20 now): a policy at a template's own revision that carries the whole delta
      // (no `a-`/`m-` write since) is a provably fresh install, and the installer wrote that delta, so the same card removes it. Any other policy
      // without archived history stays `history-unavailable` (fail closed).
      const installedAt = (snapshot: Policy) => {
        if (snapshot.schemaVersion !== 2) return false;
        const template = administeredSince(snapshot.revision) ? null : matchFirstRunPolicyTemplate(snapshot.policyRevision);
        const expected = firstRunTemplateRollback(authorityDocuments(snapshot).policy, input.principal, input.scopeId, input.only);
        return template !== null && template.version >= (input.only === 'ai-proposals' ? FIRST_RUN_PROPOSAL_UPGRADE_VERSION : FIRST_RUN_CURRENT_UPGRADE_VERSION)
          && snapshot.bindings.revision === firstRunBindingsRevision(snapshot.policyRevision) && expected.rules.length > 0 && expected.conflicts.length === 0 && expected.missing?.length === 0;
      };
      const installed = installedAt(policy);
      if (!history || history.length === 0 && !installed) return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
      // Follow exact effective revisions back from the snapshot, never infer provenance from an id or current template alone.
      const chain: AuthorityRevision[] = []; let revision = policy.revision;
      const visited = new Set<string>();
      while (true) {
        if (visited.has(revision)) return result('unavailable', { reason: 'history-unavailable' });
        visited.add(revision);
        const candidates = history.filter(entry => entry.after.revision === revision);
        if (candidates.length > 1) return result('unavailable', { reason: 'history-unavailable' });
        const entry = candidates[0];
        if (!entry) {
          if (administeredSince(revision)) {
            // Only an exact selected-rule ADD proves custody above an unavailable older prefix; a v20 upgrade is no witness.
            if (input.only === 'ai-proposals' || !chain.some(item => delta.rules.some(rule => this.upgraded(item, input.principal, input.scopeId, false, rule))))
              return result('unavailable', { reason: 'history-unavailable', conflicts: delta.conflicts });
          }
          break;
        }
        if (input.only !== 'ai-proposals' && history.filter(item => item.before.revision === entry.before.revision).length > 1)
          return result('unavailable', { reason: 'history-unavailable' });
        chain.push(entry); revision = entry.before.revision;
      }
      // A later family change must not erase custody of a fresh template's other family. Trust only the verified chain's complete initial delta.
      const initial = installedAt(chain.at(-1)?.before ?? policy);
      const conflicts = [...delta.conflicts], held: string[] = [];
      for (const rule of delta.rules) {
        const changes = chain.filter(entry => JSON.stringify(entry.before.grants.find(item => item.id === rule.id)) !== JSON.stringify(entry.after.grants.find(item => item.id === rule.id)));
        const added = changes.find(entry => !entry.before.grants.some(item => item.id === rule.id));
        if (!added) { if (initial) { if (changes.length) conflicts.push(rule.id); else held.push(rule.id); } else if (input.only !== 'ai-proposals') conflicts.push(rule.id); continue; }
        if (!this.upgraded(added, input.principal, input.scopeId, input.only === 'ai-proposals', input.only === 'ai-proposals' ? undefined : rule)) { conflicts.push(rule.id); continue; }
        if (changes[0] === added && JSON.stringify(added.after.grants.find(item => item.id === rule.id)) === JSON.stringify(rule)) held.push(rule.id);
        else conflicts.push(rule.id);
      }
      if (!held.length) return result('nothing-to-roll-back', { conflicts });
      const change = { schemaVersion: 1 as const, changes: held.map(id => ({ kind: 'grant.remove' as const, id })) };
      const planned = planPolicyChange(files.policy, files.bindings, change);
      const missing = this.missing(policy, input.principal, input.scopeId, planned.touched);
      // Never lock the person out: a rollback that would leave them without policy.administer or approval decisions is refused (`lockout`).
      const after = resolvePolicyBindings({ ...(planned.policy ?? files.policy as object), revision: 'planned' }, files.bindings);
      if (evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'execute', resource: { kind: 'operation', id: POLICY_ADMINISTER_OPERATION.operation.id } }).decision !== 'allow'
        || evaluatePolicy(after, { principal: input.principal, scopeId: input.scopeId, action: 'decide', resource: { kind: 'approval', id: UPGRADE } }).decision !== 'allow') missing.push('lockout');
      // These are the current bodies of the proven remove ids on this plan's revision, never a fresh add plan's scopes.
      const executionScopes = [...new Set(planned.touched.flatMap(rule => rule.scopes === 'all' ? ['*'] : rule.scopes))];
      const removal = { rules: delta.rules.filter(rule => held.includes(rule.id)), executionScopes, summary: describePolicyChange(files, change), conflicts, missing };
      if (missing.length) return result('refused', removal);
      if (input.mode === 'preview') return result('preview', removal);
      await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change, tag: `template-v5-rollback:${held.join(',')}`,
        reason: input.reason, revision: policy.revision, kind: UPGRADE });
      const remaining = (input.only === 'ai-proposals' ? firstRunProposalRules : firstRunExecutionRules)(principalGrants(after, mcpPrincipalRef(input.principal)), input.principal, [input.scopeId]);
      return result('rolled-back', { reason: held.join(','), conflicts, executionScopes, covered: remaining.skipped });
    }
    const names = { person: input.principal, scopeId: input.scopeId, ...this.names, ...(input.only ? { only: input.only } : {}), aiGrants: principalGrants(policy, mcpPrincipalRef(input.principal)) };
    const firstRun = firstRunTemplateAdditions(files.policy, names);
    const plan = firstRun.status === 'unavailable' && firstRun.reason === 'not-first-run' ? namedPersonPolicyAdditions(files.policy, names) : firstRun;
    const held = input.only === 'ai-proposals' /* the delta rules held now (what a rollback removes) and those an allow covers: /policy's row and its cards */ ? { held: FIRST_RUN_PROPOSAL_UPGRADE_RULE_IDS.filter(id => policy.grants.some(rule => rule.id === id)), ...(plan.status !== 'unavailable' && plan.covered ? { covered: plan.covered } : {}) } : { ...(plan.status !== 'unavailable' && plan.covered ? { covered: plan.covered } : {}) };
    if (plan.status === 'unavailable') return result('unavailable', { reason: plan.reason, ...held });
    if (plan.status === 'current') return result('current', { conflicts: plan.conflicts, ...held });
    const summary = describePolicyChange(files, plan.change), executionContext = principalGrants(policy, mcpPrincipalRef(input.principal)), executionScopes = plan.executionScopes;
    const missing = this.missing(policy, input.principal, input.scopeId, planPolicyChange(files.policy, files.bindings, plan.change).touched);
    if (input.mode === 'preview') return result('preview', { rules: plan.rules, executionContext, executionScopes, summary, missing, conflicts: plan.conflicts, ...held });
    if (missing.length) return result('refused', { rules: plan.rules, executionContext, executionScopes, summary, missing, conflicts: plan.conflicts });
    await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal: input.principal, change: plan.change, tag: `template-v5:${plan.rules.map(rule => rule.id).join(',')}`,
      reason: input.reason, revision: policy.revision, kind: UPGRADE });
    return result('upgraded', { rules: plan.rules, executionContext, executionScopes, summary, conflicts: plan.conflicts });
  }
}
