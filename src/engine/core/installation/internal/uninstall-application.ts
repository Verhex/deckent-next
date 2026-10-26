import { createHash, randomUUID } from 'node:crypto';
import { effectCommandSchema, evaluatePolicy, policySchema, policyNamedScopes, principalGrants, isAiPrincipal, type VerifiedPrincipal, type EffectCommand } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { assertAuthorityWitness, type AuthorityWitness } from '#engine/core/runtime/index.js';
import type { ApprovalApplication } from '#engine/core/approval/index.js';
import type { EffectApplication } from '#engine/core/effect/index.js';
import { uninstallApplySchema, UninstallError, type UninstallItem, type UninstallPlan, type UninstallResult } from './uninstall-contract.js';
import { createUninstallPlan, uninstallRegistry, uninstallAuthorityBlocker, type UninstallInventory } from './uninstall-plan.js';
import { PolicyAuthorizationError } from '#engine/core/policy/index.js';

/** Every scope the lifecycle decision covers: configured, every policy-named (deny/legal hold included) and every ledger-recorded scope. */
export const uninstallAffectedScopes = (policy: unknown, configured: readonly string[], recorded: readonly string[] = []): readonly string[] =>
  Object.freeze([...new Set([...configured, ...policyNamedScopes(policy), ...recorded])]);
/** An installation-wide lifecycle decision never inherits a project-only allow or overrides another scope's deny. */
export function authorizeUninstall(input: unknown, principal: VerifiedPrincipal, installationId: string, scopeIds: readonly string[], action: 'inspect' | 'uninstall' | 'purge') {
  const document = policySchema.parse(input);
  if (!scopeIds.length) throw new PolicyAuthorizationError('POLICY_DENIED');
  for (const scopeId of scopeIds) {
    const decision = evaluatePolicy(document, { principal, scopeId, action, resource: { kind: 'installation', id: installationId } });
    const grant = principalGrants(document, principal).find(grant => grant.id === decision.ruleId);
    if (decision.decision === 'require-approval') throw new PolicyAuthorizationError('POLICY_APPROVAL_UNSUPPORTED');
    if (decision.decision !== 'allow' || grant?.scopes !== 'all') {
      if (action === 'purge') throw ErrorRegistry.createError('UNINSTALL_PURGE_DENIED', { params: { owner: decision.ruleId ?? scopeId } });
      if (action === 'uninstall' && decision.reason === 'DENIED') throw ErrorRegistry.createError('UNINSTALL_MANAGED', { params: { owner: decision.ruleId ?? scopeId } });
      throw new PolicyAuthorizationError('POLICY_DENIED');
    }
  }
  return document.revision;
}

/** Trusted, local interaction. Neither answers nor a witness are fields in UninstallApply. */
export interface UninstallInteraction {
  confirm(plan: UninstallPlan): Promise<boolean>;
  backupPassphrase?(): Promise<string>;
}
/** The existing owners must provide ALL of these under durable lifecycle custody before apply is available.
 * The admission retains its hold on partial/unknown outcomes and fences service startup/admissions after a crash.
 * Recovery authenticates the retained plan, installation generation and actor; possession of its path is insufficient. */
export interface UninstallAdmission {
  readonly scopeId: string;
  readonly recoveryLocation: string;
  readonly effects: Pick<EffectApplication, 'execute' | 'inspect'>;
  /** Re-observe remaining targets, policy, live session, ownership and hold; settled steps use retained generic receipts. */
  revalidate(item: UninstallItem | null): Promise<void>;
  /** Existing backup owner: create AND verify the standard restorable set outside every removal root. */
  prepareBackup(passphrase?: string): Promise<void>;
  verifiedBackup?(): UninstallPlan['backup'];
  /** Persist the exact plan/step approvals through the existing operation broker and authenticated recovery companion. */
  approvePlan(): Promise<void>;
  /** Sealed final outcome, after the generic receipts; release hold only when the owners prove it safe. */
  finish(result: UninstallResult): Promise<void>;
}
export interface UninstallApplicationPorts {
  readonly witness: AuthorityWitness;
  readonly channel: 'mcp' | undefined;
  principal(): Promise<VerifiedPrincipal>;
  /** Fresh policy decision plus installation-wide grant; called before inventory/recovery and on every replay. */
  authorize(action: 'inspect' | 'uninstall' | 'purge', principal: VerifiedPrincipal): Promise<void>;
  inventory(purge: boolean): Promise<UninstallInventory>;
  /** Authenticated manifest owner, read only; null if no retained command exists. */
  retainedPlan(digest: string): Promise<UninstallPlan | null>;
  /** Missing broker/hold/resource owners/final-tail → undefined, never a permissive default. */
  withAdmission?: <T>(plan: UninstallPlan, commandId: string, work: (admission: UninstallAdmission) => Promise<T>) => Promise<T>;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Joins lifecycle owners; EffectApplication alone claims, retries from target evidence and settles effects. */
export class UninstallApplication {
  private readonly plans = new Map<string, UninstallPlan>();
  constructor(private readonly ports: UninstallApplicationPorts, private readonly registry = uninstallRegistry()) {}
  async preview(purge: boolean): Promise<UninstallPlan> {
    const principal = await this.ports.principal();
    await this.ports.authorize('inspect', principal);
    const plan = createUninstallPlan({ schemaVersion: 1, purge }, await this.ports.inventory(purge), this.registry);
    this.plans.clear(); this.plans.set(plan.planDigest, plan);
    return plan;
  }
  private async person() {
    await assertAuthorityWitness('uninstall', this.ports.channel, this.ports.witness);
    const principal = await this.ports.principal();
    if (isAiPrincipal(principal)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } });
    await this.ports.authorize('uninstall', principal);
  }
  private async currentPlan(digest: string): Promise<UninstallPlan | undefined> {
    const retained = await this.ports.retainedPlan(digest) ?? this.plans.get(digest);
    if (retained) return retained;
    await this.ports.authorize('inspect', await this.ports.principal());
    // Preview and apply can be separate SDK calls. Reconstruct only an exact current plan;
    // changed observations never inherit the previous card's consent.
    for (const purge of [false, true]) {
      const plan = createUninstallPlan({ schemaVersion: 1, purge }, await this.ports.inventory(purge), this.registry);
      if (plan.planDigest === digest) return plan;
    }
    return undefined;
  }
  async apply(input: unknown, interaction: UninstallInteraction, signal?: AbortSignal): Promise<UninstallResult> {
    await this.person();
    const parsed = uninstallApplySchema.safeParse(input);
    if (!parsed.success) throw new UninstallError('UNINSTALL_INVALID');
    if (!this.ports.withAdmission) throw new UninstallError('UNINSTALL_UNSUPPORTED');
    const command = parsed.data;
    const plan = await this.currentPlan(command.planDigest);
    if (!plan || plan.planDigest !== command.planDigest) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
    const admit = this.ports.withAdmission;
    if (plan.purge) await this.ports.authorize('purge', await this.ports.principal());
    if (!admit || plan.blockers.length) throw uninstallAuthorityBlocker(plan) ?? new UninstallError(plan.purge ? 'UNINSTALL_BACKUP_COVERAGE' : 'UNINSTALL_OWNERSHIP');
    let admitted: UninstallAdmission | undefined;
    const states: { resourceId: string; state: UninstallResult['items'][number]['state'] }[] = plan.items.map(item => ({ resourceId: item.resourceId, state: null }));
    const result = (status: UninstallResult['status'], recoveryLocation: string | null, failureCode?: string): UninstallResult => ({ schemaVersion: 1,
      planDigest: plan.planDigest, status, items: states.map(item => ({ ...item })), recoveryLocation, backup: admitted?.verifiedBackup?.() ?? plan.backup, packageRemoval: plan.packageRemoval,
      ...(failureCode ? { failureCode } : {}) });
    if (signal?.aborted) return result('cancelled', null);
    if (!plan.purge) {
      if (!await interaction.confirm(plan)) return result('cancelled', null);
      await this.person(); // a card answer grants no authority and may have outlived its session
      if (signal?.aborted) return result('cancelled', null);
    }
    return admit(plan, command.commandId, async admission => {
      admitted = admission;
      await admission.revalidate(null);
      const pending = plan.items.filter(item => item.action === 'remove'), registry = this.registry;
      const commands = new Map<string, EffectCommand>();
      for (const item of pending) {
        const entry = registry.entries.find(entry => entry.id === item.contribution);
        if (!entry) throw new UninstallError('UNINSTALL_INVALID');
        // Per-plan keys survive a different CLI invocation id; paths never become effect target ids.
        const key = hash(JSON.stringify([plan.installation.id, plan.planDigest, item.resourceId]));
        commands.set(item.resourceId, { schemaVersion: 1, commandId: key, idempotencyKey: key, scopeId: admission.scopeId,
          operation: item.operation, target: { kind: entry.targetKind, id: item.resourceId }, expectedVersion: item.version,
          input: { planDigest: plan.planDigest, resourceId: item.resourceId } });
        const record = await admission.effects.inspect(admission.scopeId, key);
        states.find(state => state.resourceId === item.resourceId)!.state = record?.state ?? null;
      }
      if (pending.every(item => states.find(state => state.resourceId === item.resourceId)!.state === 'settled')) {
        const noop = result('noop', admission.recoveryLocation); await admission.finish(noop); return noop;
      }
      if (plan.purge) {
        if (signal?.aborted) { const cancelled = result('cancelled', admission.recoveryLocation); await admission.finish(cancelled); return cancelled; }
        await this.person(); await this.ports.authorize('purge', await this.ports.principal());
        await admission.prepareBackup(await interaction.backupPassphrase?.());
        if (signal?.aborted || !await interaction.confirm(plan)) {
          const cancelled = result('cancelled', admission.recoveryLocation); await admission.finish(cancelled); return cancelled;
        }
      }
      await this.person();
      if (plan.purge) await this.ports.authorize('purge', await this.ports.principal());
      await admission.revalidate(null); await admission.approvePlan();
      const remaining = new Set(pending.map(item => item.resourceId));
      while (remaining.size) {
        const item = pending.find(item => remaining.has(item.resourceId) && item.dependencies.every(id => !remaining.has(id)));
        if (!item) throw new UninstallError('UNINSTALL_INVALID');
        const state = states.find(state => state.resourceId === item.resourceId)!;
        if (state.state !== 'settled') {
          if (signal?.aborted) { const stopped = result('cancelled', admission.recoveryLocation); await admission.finish(stopped); return stopped; }
          try {
            await this.person();
            if (plan.purge) await this.ports.authorize('purge', await this.ports.principal());
            await admission.revalidate(item);
            const outcome = await admission.effects.execute(commands.get(item.resourceId)!);
            if (outcome.status !== 'settled') throw new UninstallError('UNINSTALL_UNSUPPORTED');
            state.state = 'settled';
          }
          catch (error) {
            // Never fabricate failure/settlement after a lost result: the generic store remains the only truth.
            state.state = (await admission.effects.inspect(admission.scopeId, commands.get(item.resourceId)!.commandId))?.state ?? null;
            if (state.state === 'claimed' || state.state === 'unknown') {
              const unknown = result('unknown', admission.recoveryLocation, 'EFFECT_OUTCOME_UNKNOWN'); await admission.finish(unknown); return unknown;
            }
            if (states.some(item => item.state === 'settled')) {
              const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ErrorRegistry.has(error.code) ? error.code : 'UNINSTALL_UNSUPPORTED';
              const partial = result('partial', admission.recoveryLocation, code); await admission.finish(partial); return partial;
            }
            throw error;
          }
        }
        remaining.delete(item.resourceId);
      }
      const completed = result('completed', admission.recoveryLocation); await admission.finish(completed); return completed;
    });
  }
}

/** One witnessed plan supplies only its exact commands to the existing broker. Required approvals remain durable and separate. */
export function approvedUninstallEffects(plan: UninstallPlan, scopeId: string, app: EffectApplication, decider: ApprovalApplication): UninstallAdmission['effects'] {
  return { inspect: (scope, id) => app.inspect(scope, id), async execute(input) {
    const command = effectCommandSchema.parse(input), item = plan.items.find(item => item.resourceId === command.target.id && item.action === 'remove');
    const entry = uninstallRegistry().entries.find(entry => entry.id === item?.contribution);
    if (!item || !entry || command.scopeId !== scopeId || command.operation.id !== item.operation.id || command.operation.version !== item.operation.version
      || command.target.kind !== entry.targetKind || command.expectedVersion !== item.version
      || JSON.stringify(command.input) !== JSON.stringify({ planDigest: plan.planDigest, resourceId: command.target.id })) throw new UninstallError('UNINSTALL_INVALID');
    let outcome = await app.submit('execute', command);
    if (outcome.status === 'approval-pending') {
      await decider.decide({ schemaVersion: 1, commandId: randomUUID(), scopeId, approvalId: outcome.approval.approvalId,
        expectedRevision: outcome.approval.revision, decision: 'allow', reason: plan.planDigest, channel: 'local-terminal-card' });
      outcome = await app.submit('execute', command);
    }
    if (outcome.status !== 'settled') throw ErrorRegistry.createError('EFFECT_APPROVAL_REQUIRED');
    return outcome;
  } };
}
