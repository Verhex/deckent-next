import { canonicalModelMaker, independentMakerRows, roleModelKey, encodeCommandProjection, type ModelInvocationCommand, type RoleModelTarget } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { inspectRoleModelsInScope, roleModelInvocationReference, type RoleModelSources, type ModelCatalogInspection } from '#engine/core/model-activation/index.js';
import type { ModelInvocationApplication, ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { BeuserContractError, assertBeuserAccess, pinBeuserWalkerSummary, type BeuserContext, type BeuserModelRole, type BeuserModelResult, type ModelPort } from '#engine/core/beuser-contract/index.js';

/** Conservative reservations remain consumed on unknown replies; the same budget spans changed-evidence reruns. */
export class BeuserCallBudget {
  private calls = 0;
  private tokens = 0;
  private cost = 0;
  constructor(private readonly ceiling: BeuserContext['limits']) {}
  remaining() { return { calls: this.ceiling.maxCalls - this.calls, tokens: this.ceiling.maxTokens - this.tokens, cost: this.ceiling.maxCost - this.cost, currency: this.ceiling.currency }; }
  reserve(tokens: number, cost: number, currency: string): void {
    const left = this.remaining();
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(cost) || cost < 0 || currency !== left.currency
      || left.calls <= 0 || tokens > left.tokens || cost > left.cost) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
    this.calls++; this.tokens += tokens; this.cost += cost;
  }
}
export interface BeuserModelComposition {
  readonly invocation: Pick<ModelInvocationApplication, 'invoke'>;
  readonly credential: unknown;
  readonly sources: (context: BeuserContext) => Promise<{ roles: RoleModelSources; profiles: unknown; catalog: ModelCatalogInspection }>;
  readonly choices: Readonly<Record<BeuserModelRole, RoleModelTarget>>;
  readonly contributorModels: readonly unknown[];
  readonly walkerModels: readonly unknown[];
  readonly independence: 'required' | 'reduced';
  /** Trusted provider codec uses its current profile, tariff/quote and remaining envelope. No rubric/system authority in walker input. */
  readonly prepare: (context: BeuserContext, role: BeuserModelRole, reference: NonNullable<ReturnType<typeof roleModelInvocationReference>>,
    input: unknown, remaining: ReturnType<BeuserCallBudget['remaining']>) => Promise<{ command: ModelInvocationCommand; tokens: number; cost: number; currency: string }>;
  readonly cancel: (context: BeuserContext, invocationId: string) => Promise<void>;
  readonly now: () => number;
}
export function beuserIndependentRows<T>(rows: readonly T[], makerOf: (row: T) => string | null, contributors: readonly unknown[], walkers: readonly unknown[]) {
  return independentMakerRows(rows, row => canonicalModelMaker({ vendorId: makerOf(row) }), [...contributors, ...walkers].map(canonicalModelMaker));
}
/** Reuses role, activation, profile, binding, budget and immutable receipt authority on every call. */
export function createBeuserModelPort(ports: BeuserModelComposition, budget: BeuserCallBudget): ModelPort {
  const invocations = new Map<string, string>(), walkers: unknown[] = [...ports.walkerModels];
  const invoke = async (context: BeuserContext, role: BeuserModelRole, input: unknown): Promise<BeuserModelResult> => {
    assertBeuserAccess(context, context.binding, context.principal, { kind: 'attempt', id: context.binding.identity.attemptId }, 'evaluate');
    const source = await ports.sources(context), target = ports.choices[role];
    const inspected = await inspectRoleModelsInScope(source.roles, role, context.binding.identity.scopeId, ports.now());
    const row = inspected.models.find(row => roleModelKey(row) === roleModelKey(target));
    const unavailable = (reason: Extract<BeuserModelResult, { state: 'unavailable' }>['reason']): BeuserModelResult => ({ state: 'unavailable', code: 'BEUSER_MODEL_UNAVAILABLE', reason });
    if (!row) return unavailable('role-not-held');
    if (!row.active) return unavailable('not-active');
    const channel = source.catalog.channels.find(provider => provider.channelId === target.channelId);
    const model = source.catalog.scopeId === context.binding.identity.scopeId && channel?.access === 'allowed' ? channel.models.find(model => model.modelId === target.modelId)?.model : undefined;
    if (!model) return unavailable('model-unknown');
    const maker = canonicalModelMaker(model);
    if (maker === null && role === 'beuser-evaluator' && ports.independence === 'required') return unavailable('maker-unknown');
    if (role === 'beuser-evaluator' && ports.independence === 'required' && !beuserIndependentRows([row], () => maker, ports.contributorModels, walkers).length) return unavailable('independence');
    const reference = roleModelInvocationReference(source.roles, source.profiles, context.binding.identity.scopeId, target);
    if (!reference) return unavailable('model-unknown');
    const prepared = await ports.prepare(context, role, reference, input, budget.remaining());
    if (prepared.command.scopeId !== context.binding.identity.scopeId || JSON.stringify(prepared.command.reference) !== JSON.stringify(reference)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    context.signal.throwIfAborted();
    budget.reserve(prepared.tokens, prepared.cost, prepared.currency);
    const invocation = await ports.invocation.invoke(prepared.command, ports.credential, context.signal);
    invocations.set(invocation.receipt.claim.invocationId, JSON.stringify(context.binding));
    if (role === 'beuser-walker') walkers.push(model);
    return { state: 'invoked', receipt: { invocation, role, maker } };
  };
  return {
    // Build a new whitelist object, not a spread of caller/model context. The screen has already been redacted by the harness.
    walker: (context, summaryInput, screen) => {
      const summary = pinBeuserWalkerSummary(summaryInput);
      if (sha256(encodeCommandProjection('beuser-persona:1', summary)) !== context.binding.personaDigest) throw new BeuserContractError('BEUSER_INPUT_INVALID');
      assertBeuserAccess(context, screen.binding, context.principal, { kind: 'beuser-sandbox', id: screen.binding.realmId }, 'create');
      return invoke(context, 'beuser-walker', { persona: summary, goal: summary.goal, screen: screen.text, tools: ['look', 'type', 'press', 'wait'] });
    },
    evaluate: (context, transcriptDigest) => invoke(context, 'beuser-evaluator', { transcriptDigest }),
    cancel: async (context, invocationId) => {
      if (invocations.get(invocationId) !== JSON.stringify(context.binding)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
      assertBeuserAccess({ ...context, signal: new AbortController().signal }, context.binding, context.principal, { kind: 'attempt', id: context.binding.identity.attemptId }, 'evaluate');
      await ports.cancel(context, invocationId);
    },
  };
}
export type BeuserWalkerDecode = (result: ModelInvocationResult) => unknown;
