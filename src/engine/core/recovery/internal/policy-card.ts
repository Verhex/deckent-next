import { z } from 'zod';
import { RECOVERY_ACTIONS, RECOVERY_ROLLOUT, encodeCommandProjection, evaluatePolicy, identitySchema, isAiPrincipal, policyResources, policySchema, sameMcpCapabilityRule, type PolicyGrant,
  type RecoveryRolloutView, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import { PolicyAdministrationInspection } from '#engine/core/policy/index.js';
import { administerOwnPolicyChange, type PersistentStandingDependencies } from '#engine/core/approval/index.js';
import { RECOVERY_CONTINUE_ACTION } from './approval.js';

/** One card row: a standing grant of a recovery action, or the promotion of a Nervous rule at its exact version (`<ruleId>@<version>`).
 * `available` false: no executor in this release (never granted); `exits`: whether the measured exit criteria hold (null: the row has none). */
export type RecoveryPolicyRow = Readonly<{ kind: 'action' | 'rule'; id: string; managed: 'none' | 'granted' | 'conflict'; effective: 'allowed' | 'denied'; available: boolean;
  exits: boolean | null }>;
export type RecoveryPolicyView = Readonly<{ schemaVersion: 1; scopeId: string; revision: string; rows: readonly RecoveryPolicyRow[]; rollout: RecoveryRolloutView }>;
export const recoveryPolicyCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, kind: z.enum(['action', 'rule']), id: identitySchema,
  action: z.enum(['grant', 'revoke']), expectedRevision: identitySchema }).strict().readonly();
export type RecoveryPolicyCommand = z.infer<typeof recoveryPolicyCommandSchema>;
/** What the card reads besides the policy: the measured rollout view (re-read inside a change) and the stop actions with an executor. */
export type RecoveryPolicyPorts = Readonly<{ rollout: (scopeId: string) => Promise<RecoveryRolloutView>; executable: readonly string[] }>;

/**
 * alpha.56 G2 + G3 (owner Q-A1/Q-A2/Q-A4/Q-A9): one person card over the owner's own policy rules for lost-worker recovery — a standing grant
 * `recovery-action/apply <action>` per action (the six stop-list actions and `continue-new-attempt`) and the promotion `nervous-rule/promote
 * <ruleId>@<version>` of each measured lost-worker rule, per scope. Written only through `policy.administer` (revision CAS, sealed audit) by a
 * person at a real terminal; an AI is refused (and the AI floor refuses both resources). A grant whose measured exits do not hold (a rule's
 * detection cases, the decision agreement for a continuation) is refused visibly; an action without an executor is never granted; turning a
 * row off is never gated. The broker and the recovery decision read the policy fresh, so a change applies on the next page or decision.
 */
export class RecoveryPolicyCard {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'policy' | 'administration' | 'approve'>, private readonly ports: RecoveryPolicyPorts,
    private readonly interactive: () => Promise<boolean> = async () => false) {}
  private grant(scopeId: string, principal: VerifiedPrincipal, kind: RecoveryPolicyRow['kind'], id: string): PolicyGrant {
    const person = { issuer: principal.issuer, subject: principal.subject }, resource = kind === 'action' ? policyResources.recoveryAction : policyResources.nervousRule;
    const key = sha256(encodeCommandProjection('recovery-policy:1', { scopeId, person, kind, id })).slice(0, 32);
    return { id: `recovery-${kind}-${key}`, effect: 'allow', principals: [person], scopes: [scopeId], actions: [resource.actions[0]], resource: { kind: resource.kind, ids: [id] } };
  }
  async inspect(input: Readonly<{ schemaVersion: 1; scopeId: string }>, principal: VerifiedPrincipal): Promise<RecoveryPolicyView> {
    const { scopeId } = input;
    if (!principal.scopeIds.includes(scopeId)) throw ErrorRegistry.createError('POLICY_DENIED');
    const policy = policySchema.parse(await this.deps.policy.load());
    await new PolicyAdministrationInspection({ load: async () => policy }).inspect(principal, { schemaVersion: 1, scopeId });
    const rollout = await this.ports.rollout(scopeId);
    const row = (kind: RecoveryPolicyRow['kind'], id: string, available: boolean, exits: boolean | null): RecoveryPolicyRow => {
      const rule = this.grant(scopeId, principal, kind, id), held = policy.grants.find(item => item.id === rule.id);
      const { kind: resource, actions: [action] } = kind === 'action' ? policyResources.recoveryAction : policyResources.nervousRule;
      const allowed = evaluatePolicy(policy, { principal, scopeId, action, resource: { kind: resource, id } }).decision === 'allow';
      return Object.freeze({ kind, id, managed: held ? sameMcpCapabilityRule(held, rule) ? 'granted' : 'conflict' : 'none', effective: allowed ? 'allowed' : 'denied', available, exits });
    };
    const actions = [...RECOVERY_ACTIONS.map(id => row('action', id, this.ports.executable.includes(id), null)), row('action', RECOVERY_CONTINUE_ACTION, true, rollout.decisions.met)];
    const rules = rollout.rules.map(rule => row('rule', `${rule.id}@${rule.version}`, true, rule.met));
    return Object.freeze({ schemaVersion: 1, scopeId, revision: policy.revision, rows: Object.freeze([...actions, ...rules]), rollout });
  }
  async change(input: unknown, principal: VerifiedPrincipal): Promise<Readonly<{ status: 'applied' | 'current'; view: RecoveryPolicyView }>> {
    if (isAiPrincipal(principal)) throw ErrorRegistry.createError('AI_AUTHORITY_NON_DELEGABLE');
    const parsed = recoveryPolicyCommandSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('RECOVERY_TARGET_INVALID');
    const command = parsed.data;
    if (!await this.interactive()) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    // The measured view is re-read inside the change: a gate is never decided on an older card.
    const view = await this.inspect({ schemaVersion: 1, scopeId: command.scopeId }, principal), target = view.rows.find(row => row.kind === command.kind && row.id === command.id);
    if (!target) throw ErrorRegistry.createError('RECOVERY_TARGET_INVALID');
    if (view.revision !== command.expectedRevision || target.managed === 'conflict') throw ErrorRegistry.createError('POLICY_DELEGATION_CONFLICT');
    if (command.action === 'grant' ? target.managed === 'granted' : target.managed === 'none') return Object.freeze({ status: 'current' as const, view });
    if (command.action === 'grant' && !target.available) throw ErrorRegistry.createError('RECOVERY_ACTION_NO_EXECUTOR', { params: { action: target.id } });
    if (command.action === 'grant' && target.exits === false) {
      const criteria = command.kind === 'rule' ? RECOVERY_ROLLOUT.detection.id : RECOVERY_ROLLOUT.decision.id;
      throw ErrorRegistry.createError('RECOVERY_ROLLOUT_CRITERIA_UNMET', { params: { target: target.id, criteria, scope: command.scopeId } });
    }
    const grant = this.grant(command.scopeId, principal, command.kind, command.id);
    const change = { schemaVersion: 1 as const, changes: [command.action === 'grant' ? { kind: 'grant.add' as const, grant } : { kind: 'grant.remove' as const, id: grant.id }] };
    await administerOwnPolicyChange(this.deps, { scopeId: command.scopeId, principal, change, revision: command.expectedRevision, kind: 'policy-recovery',
      tag: sha256(encodeCommandProjection('recovery-policy-change:1', command)), reason: `${command.action}: ${command.kind} ${command.id}, ${command.scopeId}` });
    return Object.freeze({ status: 'applied' as const, view: await this.inspect({ schemaVersion: 1, scopeId: command.scopeId }, principal) });
  }
}
