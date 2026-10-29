import { createHash, randomUUID } from 'node:crypto';
import { effectCommandSchema, queueNextState, evaluatePolicy, policySchema, policyNamedScopes, principalGrants, isAiPrincipal, type VerifiedPrincipal, type EffectCommand } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { assertAuthorityWitness, describeRuntimeServiceWithin, runtimeMonotonicDeadline, type AuthorityWitness, type RuntimeServiceDescriptor } from '#engine/core/runtime/index.js';
import { authorizeApproval, authorizeOwnApproval, type ApprovalApplication } from '#engine/core/approval/index.js';
import { OperationPolicyAuthorization, type EffectApplication } from '#engine/core/effect/index.js';
import { uninstallApplySchema, UninstallError, UNINSTALL_TIERS, type UninstallItem, type UninstallPlan, type UninstallResult } from './uninstall-contract.js';
import { createUninstallPlan, uninstallRegistry, uninstallBlockerError, uninstallPlanDrift, uninstallOperationDescriptors, type UninstallInventory } from './uninstall-plan.js';
import { PolicyAuthorizationError, RunPolicyAuthorization } from '#engine/core/policy/index.js';

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
    // M14: deleting data first creates and verifies a backup under the same installation-wide grant; a person without it is told before any card.
    for (const backup of action === 'purge' ? ['create', 'verify'] as const : []) {
      const allowed = evaluatePolicy(document, { principal, scopeId, action: backup, resource: { kind: 'backup', id: installationId } });
      if (allowed.decision !== 'allow' || principalGrants(document, principal).find(grant => grant.id === allowed.ruleId)?.scopes !== 'all')
        throw ErrorRegistry.createError('UNINSTALL_BACKUP_DENIED', { params: { owner: allowed.ruleId ?? scopeId } });
    }
  }
  return document.revision;
}

/** Scopes a policy restriction names (company control): an unreconciled item there keeps data deletion closed, force included (K3). */
export const uninstallManagedScopes = (policy: unknown, affected: readonly string[]): readonly string[] => {
  const rules = policySchema.parse(policy).restrictions;
  return Object.freeze(affected.filter(scope => rules.some(rule => rule.scopes === 'all' || rule.scopes.includes(scope))));
};
/** Trusted, local interaction. Neither answers nor a witness are fields in UninstallApply. */
export interface UninstallInteraction {
  confirm(plan: UninstallPlan): Promise<boolean>; backupPassphrase?(): Promise<string>;
  /** A bounded wait's visible state: what is awaited and the time left (its owner is the configured cancellation budget). */
  progress?(event: { readonly remaining: number; readonly leftMs: number }): void;
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
type Ref = UninstallPlan['work']['running'][number];
export interface UninstallApplicationPorts {
  readonly witness: AuthorityWitness;
  readonly channel: 'mcp' | undefined;
  principal(): Promise<VerifiedPrincipal>;
  /** Fresh policy decision plus installation-wide grant; called before inventory/recovery and on every replay. */
  authorize(action: 'inspect' | 'uninstall' | 'purge', principal: VerifiedPrincipal): Promise<void>;
  inventory(): Promise<UninstallInventory>;
  /** Authenticated manifest owner, read only; null if no retained command exists. */
  retainedPlan(digest: string): Promise<UninstallPlan | null>;
  /** Missing owners → undefined, never a permissive default. `approved`: the confirmed digest D0 the archive binds to (the admitted plan is the fresh D1). */
  withAdmission?: <T>(plan: UninstallPlan, approved: string, work: (admission: UninstallAdmission) => Promise<T>) => Promise<T>;
  /** K3: the existing run cancellation and approval decision owners, as the witnessed person; nothing is closed, released or killed. */
  readonly force?: { cancelRun(ref: Ref): Promise<void>; rejectApproval(ref: Ref): Promise<void>; withdrawDelivery(ref: UninstallPlan['work']['deliveries'][number]): Promise<void> };
  /** M14, R8: every decision an owner takes after the card (force steps, deliveries, removals, their approval) taken before it, writing nothing. */
  preflight?(plan: UninstallPlan, principal: VerifiedPrincipal): Promise<void>;
  /** Configured wait for cancelled work: its budget and poll interval; a timeout leaves the work, and the fresh plan names it. */
  readonly settle?: { readonly budgetMs: number; wait(ms: number): Promise<unknown> };
  /** The runtime service: its describe answer, the user unit whose main process it is (K4 checks), governed shutdown and `disable --now`. */
  readonly service?: { withStoppedCustody?<T>(confirmed: UninstallPlan['service'], work: () => Promise<T>): Promise<T>; readonly budgetMs: number; describe(signal: AbortSignal): Promise<RuntimeServiceDescriptor>;
    unit(processId: number): Promise<{ readonly unit: string; readonly unitDisable: 'eligible' | 'command-only'; readonly command: string; readonly links?: readonly string[]; readonly unitFile?: string | null } | null>;
    shutdown(): Promise<unknown>; /** `disable --now` of the confirmed unit; its owner re-reads unit file and links right before (R3). */ disable(confirmed: UninstallPlan['service']): Promise<NonNullable<UninstallResult['unit']>> };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const queries = UNINSTALL_TIERS.flatMap(tier => [false, true].flatMap(force => [false, true].map(disableUnit => ({ schemaVersion: 2 as const, tier, force, disableUnit }))));
/** Joins lifecycle owners; EffectApplication alone claims, retries from target evidence and settles effects. */
export class UninstallApplication {
  private readonly plans = new Map<string, UninstallPlan>();
  constructor(private readonly ports: UninstallApplicationPorts, private readonly registry = uninstallRegistry()) {}
  /** The adapters' observation plus the service as it answers now; a service that does not answer is not running (the lock decides later). */
  private async observe(live = true): Promise<UninstallInventory> {
    const inventory = await this.ports.inventory(), service = live ? this.ports.service : undefined, principal = await this.ports.principal();
    const policyBlocker = await this.ports.authorize('purge', principal).then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'POLICY_DENIED');
    const found = service && (await describeRuntimeServiceWithin(service.describe, runtimeMonotonicDeadline(service.budgetMs))).descriptor;
    const unit = found && found.processId !== undefined ? await service.unit(found.processId) : null;
    return { ...inventory, policyBlocker, service: { running: !!found, unit: unit?.unit ?? null, unitDisable: unit?.unitDisable ?? 'none', command: unit?.command ?? null,
      links: unit?.links ?? [], unitFile: unit?.unitFile ?? null } };
  }
  /** Governed shutdown first; absence is observed, never assumed; only then K4's `disable --now` (its owner re-reads the unit first); then absence again. */
  private async stopService<T>(plan: UninstallPlan, work: (unit: UninstallResult['unit']) => Promise<T>): Promise<T> {
    const { service, settle } = this.ports, deadline = service && runtimeMonotonicDeadline(service.budgetMs);
    if (!service || !deadline || !settle) throw new UninstallError('UNINSTALL_UNSUPPORTED');
    const refused = () => ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { reason: 'new-instance-or-custody-unavailable', unit: plan.service.unit ?? '', command: plan.service.command ?? '' } });
    const answer = async () => (await describeRuntimeServiceWithin(service.describe, deadline)).descriptor, first = await answer();
    const gone = async (instance: string | null) => { for (let now = await answer(); now && now.instanceId === (instance ?? now.instanceId); now = await answer()) {
      if (deadline.expired()) throw refused();
      await settle.wait(this.registry.waitPollMs); } };
    if (first) { await service.shutdown(); await gone(first.instanceId); }
    const stopped = async () => {
      // R4 (lead 2026-10-28): a new instance after the shutdown may have accepted work: no `--now`, the person gets the command (K4 absence rule).
      if (await answer()) throw refused();
      const unit = plan.steps.disableUnit && plan.service.unit ? await service.disable(plan.service) : undefined;
      await gone(null);
      return work(unit);
    };
    if (plan.steps.disableUnit && !service.withStoppedCustody) throw refused();
    return service.withStoppedCustody ? service.withStoppedCustody(plan.service, stopped) : stopped();
  }
  async preview(query: unknown): Promise<UninstallPlan> {
    const principal = await this.ports.principal();
    await this.ports.authorize('inspect', principal);
    const plan = createUninstallPlan(query, await this.observe(), this.registry);
    this.plans.clear(); this.plans.set(plan.planDigest, plan);
    return plan;
  }
  private async person(purge = false) {
    await assertAuthorityWitness('uninstall', this.ports.channel, this.ports.witness);
    const principal = await this.ports.principal();
    if (isAiPrincipal(principal)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } });
    await this.ports.authorize('uninstall', principal);
    if (purge) await this.ports.authorize('purge', principal);
  }
  private async currentPlan(digest: string): Promise<UninstallPlan | undefined> {
    const retained = await this.ports.retainedPlan(digest) ?? this.plans.get(digest);
    if (retained) return retained;
    await this.ports.authorize('inspect', await this.ports.principal());
    // Preview and apply can be separate SDK calls. Reconstruct only an exact current plan from one fresh observation;
    // changed observations never inherit the previous card's consent.
    const inventory = await this.observe();
    return queries.map(query => createUninstallPlan(query, inventory, this.registry)).find(plan => plan.planDigest === digest);
  }
  /** Under custody (`live` false) no service can hold the ledger, so the service is observed as stopped rather than described. */
  private async replan(plan: UninstallPlan, live = true) {
    return createUninstallPlan({ schemaVersion: 2, tier: plan.tier, force: plan.force, disableUnit: plan.disableUnit }, await this.observe(live), this.registry);
  }
  async apply(input: unknown, interaction: UninstallInteraction, signal?: AbortSignal): Promise<UninstallResult> {
    await this.person();
    const parsed = uninstallApplySchema.safeParse(input);
    if (!parsed.success) throw new UninstallError('UNINSTALL_INVALID');
    if (!this.ports.withAdmission) throw new UninstallError('UNINSTALL_UNSUPPORTED');
    const command = parsed.data, approved = await this.currentPlan(command.planDigest);
    if (!approved || approved.planDigest !== command.planDigest) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
    const admit = this.ports.withAdmission, gated = approved.tier !== 'keep-data';
    if (gated) await this.ports.authorize('purge', await this.ports.principal());
    // Every check precedes the one card (owner 2026-10-27): blockers refuse with their next step; nothing to do asks nothing.
    const blocked = uninstallBlockerError(approved);
    if (blocked) throw blocked;
    let plan = approved, admitted: UninstallAdmission | undefined, unit: UninstallResult['unit'];
    const states: { resourceId: string; state: UninstallResult['items'][number]['state'] }[] = plan.items.map(item => ({ resourceId: item.resourceId, state: null }));
    const result = (status: UninstallResult['status'], recoveryLocation: string | null, failureCode?: string): UninstallResult => ({ schemaVersion: 2,
      planDigest: plan.planDigest, status, items: states.map(item => ({ ...item })), recoveryLocation, backup: admitted?.verifiedBackup?.() ?? plan.backup,
      packageRemoval: plan.packageRemoval, uncertain: plan.work.uncertain, ...(unit ? { unit } : {}), ...(failureCode ? { failureCode } : {}) });
    if (approved.nothingToRemove) return result('noop', null);
    const { steps } = approved, forced = steps.cancelRuns.length + steps.rejectApprovals.length + steps.withdrawDeliveries.length;
    if (forced && !this.ports.force) throw new UninstallError('UNINSTALL_UNSUPPORTED');
    await this.ports.preflight?.(approved, await this.ports.principal());
    if (signal?.aborted || !await interaction.confirm(approved)) return result('cancelled', null);
    await this.person(gated); // a card answer grants no authority and may have outlived its session
    if (signal?.aborted) return result('cancelled', null);
    // Deliveries first (their owner decides again at the call; preflight already decided each one).
    for (const ref of steps.withdrawDeliveries) await this.ports.force!.withdrawDelivery(ref);
    for (const ref of steps.cancelRuns) await this.ports.force!.cancelRun(ref);
    for (const ref of steps.rejectApprovals) await this.ports.force!.rejectApproval(ref);
    if (forced && this.ports.settle) {
      const { budgetMs, wait } = this.ports.settle, deadline = runtimeMonotonicDeadline(budgetMs);
      for (let current = await this.replan(approved); ; current = await this.replan(approved)) {
        const left = current.work.running.length + (current.purge ? current.work.parked.length + current.work.approvals.length + current.work.deliveries.length : 0);
        if (!left || deadline.expired() || signal?.aborted) break;
        interaction.progress?.({ remaining: left, leftMs: Math.ceil(deadline.remaining()) }); await wait(Math.min(this.registry.waitPollMs, deadline.remaining()));
      }
    }
    const complete = async () => {
      // D1 = E(D0): a fresh plan of the same query may differ only in what the confirmation already covered.
      plan = await this.replan(approved);
      const drift = uninstallPlanDrift(approved, plan);
      if (drift.length) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED', { params: { diff: drift.slice(0, 8).join(', ') } });
      states.splice(0, states.length, ...plan.items.map(item => ({ resourceId: item.resourceId, state: null })));
      return admit(plan, approved.planDigest, async admission => {
        admitted = admission;
        // D2 under custody: the same expectation as D1, now that no service or other process can change the ledger.
        const custody = uninstallPlanDrift(approved, await this.replan(approved, false));
        if (custody.length) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED', { params: { diff: custody.slice(0, 8).join(', ') } });
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
        if (pending.every(item => states.find(state => state.resourceId === item.resourceId)!.state === 'settled') && !steps.stopService && !forced) {
          const noop = result('noop', admission.recoveryLocation); await admission.finish(noop); return noop;
        }
        if (plan.backup.required) {
          if (signal?.aborted) { const cancelled = result('cancelled', admission.recoveryLocation); await admission.finish(cancelled); return cancelled; }
          // K7: create → verify (audit included) → bind to this plan before the first deletion; an unverifiable backup deletes nothing.
          await this.person(gated); await admission.prepareBackup(await interaction.backupPassphrase?.());
        }
        await this.person(gated);
        await admission.revalidate(null); await admission.approvePlan();
        const remaining = new Set(pending.map(item => item.resourceId));
        while (remaining.size) {
          const item = pending.find(item => remaining.has(item.resourceId) && item.dependencies.every(id => !remaining.has(id)));
          if (!item) throw new UninstallError('UNINSTALL_INVALID');
          const state = states.find(state => state.resourceId === item.resourceId)!;
          if (state.state !== 'settled') {
            if (signal?.aborted) { const stopped = result('cancelled', admission.recoveryLocation); await admission.finish(stopped); return stopped; }
            try {
              await this.person(gated);
              await admission.revalidate(item);
              const outcome = await admission.effects.execute(commands.get(item.resourceId)!);
              if (outcome.status !== 'settled') throw new UninstallError('UNINSTALL_UNSUPPORTED');
              state.state = 'settled';
            }
            catch (error) {
              // Never fabricate failure/settlement after a lost result: the generic store remains the only truth. A store that can no longer
              // be read (the final tail already removed its policy or key) leaves the outcome unknown, never a policy error.
              state.state = (await admission.effects.inspect(admission.scopeId, commands.get(item.resourceId)!.commandId).catch(() => ({ state: 'unknown' as const })))?.state ?? null;
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
    };
    return steps.stopService ? this.stopService(approved, stoppedUnit => { unit = stoppedUnit; return complete(); }) : complete();
  }
}

/** M14, R8, F6: the owners' decisions of a plan's steps from one policy, writing nothing: force's cancels and rejections, each removal's operation and approval. */
export async function authorizeUninstallSteps(policy: unknown, plan: UninstallPlan, principal: VerifiedPrincipal, scopeId: string) {
  const source = { load: async () => policy }, runs = new RunPolicyAuthorization(source), operations = new OperationPolicyAuthorization(source);
  for (const ref of plan.steps.cancelRuns) await runs.authorize('cancel', { scopeId: ref.scopeId, runId: ref.id }, principal);
  for (const ref of plan.steps.rejectApprovals) authorizeApproval(policy, 'decide', ref.scopeId, ref.id, principal);
  for (const ref of plan.steps.withdrawDeliveries) {
    try { if (!ref.state) throw new UninstallError('UNINSTALL_INVALID'); queueNextState({ state: ref.state }, 'cancelled'); }
    catch { throw ErrorRegistry.createError('UNINSTALL_DELIVERY_QUEUED', { params: { count: '1', list: ref.id, owner: ref.scopeId } }); }
  }
  for (const id of new Set(plan.items.filter(item => item.action === 'remove').map(item => item.operation.id))) {
    await operations.authorize('execute', scopeId, { id, version: 1 }, principal); // the first claim's own decision (inspect is asked only of a stored record)
    authorizeOwnApproval(policy, scopeId, principal, uninstallOperationDescriptors().find(item => item.operation.id === id)!); // F6: as the decider would, before the card
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
