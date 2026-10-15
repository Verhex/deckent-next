import { DecisionDelegationError, aiAuthorityFloor, delegationCommandSchema, delegationQuerySchema, delegationWithin, encodeCommandProjection, explicitDecisionGrant,
  getDecisionSteps, isAiPrincipal, mcpPrincipalRef, policySchema, principalGrants, sameMcpCapabilityRule, type DecisionDelegationView, type DecisionStep, type DelegationCommand,
  type DelegationQuery, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { PolicyAdministrationInspection } from '#engine/core/policy/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';

/** One bounded command over the existing authority application; no document writer or AI policy-administration ingress. */
export class DecisionDelegations {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'policy' | 'administration' | 'approve'>,
    private readonly interactive: () => Promise<boolean> = async () => false) {}
  private async snapshot(query: DelegationQuery, principal: VerifiedPrincipal) {
    if (!principal.scopeIds.includes(query.scopeId)) throw new DecisionDelegationError('POLICY_DENIED');
    const policy = policySchema.parse(await this.deps.policy.load());
    await new PolicyAdministrationInspection({ load: async () => policy }).inspect(principal, { schemaVersion: 1, scopeId: query.scopeId });
    return policy;
  }
  private rule(query: DelegationQuery, step: DecisionStep, principal: VerifiedPrincipal): PolicyGrant {
    const actor = isAiPrincipal(principal) ? { issuer: principal.issuer, subject: principal.subject } : mcpPrincipalRef(principal);
    const ids = query.resourceId ? [query.resourceId] : 'all' as const;
    const key = sha256(encodeCommandProjection('decision-delegation:1', { scopeId: query.scopeId, actor, step: step.id, ids })).slice(0, 32);
    return { id: `ai-step-${key}`, effect: 'allow', principals: [actor], scopes: [query.scopeId], actions: [step.action], resource: { kind: step.kind, ids } };
  }
  async inspect(input: DelegationQuery, principal: VerifiedPrincipal): Promise<DecisionDelegationView> {
    const query = delegationQuerySchema.parse(input), policy = await this.snapshot(query, principal);
    const actor = isAiPrincipal(principal) ? principal : { ...principal, ...mcpPrincipalRef(principal), assurance: 'workload-verified' as const };
    return { schemaVersion: 1, scopeId: query.scopeId, resourceId: query.resourceId ?? null, revision: policy.revision,
      principal: { issuer: actor.issuer, subject: actor.subject }, steps: getDecisionSteps().map(step => {
        const rule = this.rule(query, step, principal), held = policy.grants.find(item => item.id === rule.id);
        // Without an id the question is authority over the entire class, not a sample-id probe. Denies/asks intersecting any id win.
        const allowed = query.resourceId ? explicitDecisionGrant(policy, actor, query.scopeId, step.kind, query.resourceId, step.action) !== null
          : delegationWithin(policy, actor, [rule]).ok && principalGrants(policy, actor).some(item => item.effect === 'allow' && item.principals !== 'all'
            && item.principals.some(ref => ref.issuer === actor.issuer && ref.subject === actor.subject)
            && item.actions !== 'all' && item.actions.includes(step.action) && item.resource.kind === step.kind && item.resource.ids === 'all'
            && (item.scopes === 'all' || item.scopes.includes(query.scopeId)));
        return { step, managed: held ? sameMcpCapabilityRule(held, rule) ? 'granted' : 'conflict' : 'none', effective: allowed ? 'allowed' : 'denied' };
      }) };
  }
  async change(input: DelegationCommand, principal: VerifiedPrincipal): Promise<{ readonly status: 'applied' | 'current'; readonly view: DecisionDelegationView }> {
    if (isAiPrincipal(principal)) throw new DecisionDelegationError('AI_AUTHORITY_NON_DELEGABLE');
    const parsed = delegationCommandSchema.safeParse(input);
    if (!parsed.success) throw new DecisionDelegationError('POLICY_DELEGATION_STEP_INVALID');
    const command = parsed.data, step = getDecisionSteps().find(item => item.id === command.step);
    if (!step) throw new DecisionDelegationError('POLICY_DELEGATION_STEP_INVALID');
    if (command.resourceId && aiAuthorityFloor({ ...mcpPrincipalRef(principal), assurance: 'workload-verified' }, { kind: step.kind, id: command.resourceId }, step.action))
      throw new DecisionDelegationError('AI_AUTHORITY_NON_DELEGABLE');
    if (!await this.interactive()) throw new DecisionDelegationError('APPROVAL_INTERACTIVE_REQUIRED');
    const query = delegationQuerySchema.parse({ schemaVersion: 1, scopeId: command.scopeId, actor: command.actor, ...(command.resourceId ? { resourceId: command.resourceId } : {}) });
    const policy = await this.snapshot(query, principal);
    if (policy.revision !== command.expectedRevision) throw new DecisionDelegationError('POLICY_DELEGATION_CONFLICT');
    const grant = this.rule(query, step, principal), held = policy.grants.find(item => item.id === grant.id);
    if (held && !sameMcpCapabilityRule(held, grant)) throw new DecisionDelegationError('POLICY_DELEGATION_CONFLICT');
    if (command.action === 'grant' ? !!held : !held) return { status: 'current', view: await this.inspect(query, principal) };
    const change = { schemaVersion: 1 as const, changes: [command.action === 'grant' ? { kind: 'grant.add' as const, grant } : { kind: 'grant.remove' as const, id: grant.id }] };
    await administerOwnPolicyChange(this.deps, { scopeId: command.scopeId, principal, change, revision: command.expectedRevision,
      kind: 'policy-mcp-capability', tag: sha256(encodeCommandProjection('decision-delegation-change:1', command)), reason: `${command.action}: ${step.id}, ${command.scopeId}` });
    return { status: 'applied', view: await this.inspect(query, principal) };
  }
}
