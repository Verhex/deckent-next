import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { brainPlanCommandInputSchema, encodeCommandProjection, openAiChatUsageSchema, CORE_WORK_CLASSES, mergeWorkClassRegistries, getPolicyVocabulary, type ExecutionRegistry, type BrainPlanCommand, type ModelInvocationCommand,
  type RunProposal, type VerifiedPrincipal, encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition, readHeadlessRejection,
  type ModelInvocationResponseEvidence, type BrainPlanObserver, type BrainQuotaWaitStore } from '#domain/index.js';
import { brainInputDigest, brainOutputDigest, parseBrainDraft, prepareBrainPrompt, brainPlannerConfigSchema, boundBrainContext, assertBrainLeavesAssignment,
  prepareBrainEvaluatorParameters, selectedBrainTemplate, brainWorkClassView, type BrainMemoryContext, type BrainRegistryContext } from '#capabilities/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { modelInvocationRequestDigest, refuseInactiveModel, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import { composeModelRolePolicy, decideRoleModelInScope, roleModelPorts, type RoleModelSources } from '#engine/core/model-activation/index.js';
import { isRunIntentResult, type RunPlanningResult, type PlanningMemoryNote, type RunProposalQuery, type RunProposalResult } from '#engine/core/run-proposal/index.js';
import { brainQuotaAttemptCommandId, brainQuotaWaitUntil, waitUntil, type BrainQuotaWaitPolicy } from './internal/quota-wait.js';
export { brainQuotaAttemptCommandId, brainQuotaWaitUntil, type BrainQuotaWaitPolicy } from './internal/quota-wait.js';
/** f3: the configured `brain_planner.quotaWait` bounds (registry defaults when unset). */
export const brainQuotaWaitPolicy = (config: unknown): BrainQuotaWaitPolicy => brainPlannerConfigSchema.parse(config).quotaWait;
export const brainRunId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-run:1', { scopeId: command.scopeId, commandId: command.commandId }));
export const brainInvocationCommandId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-invocation:1', { scopeId: command.scopeId, commandId: command.commandId }));
export function prepareBrainRegistryPrompt(command: BrainPlanCommand, registry: ExecutionRegistry,
  budget: { currency: string; limitMinorUnits: number } | null, config: unknown, known?: KnownSecretSnapshot,
  selections?: Readonly<{ kinds: BrainRegistryContext['kinds']; workerModels: BrainRegistryContext['workerModels']; memory?: BrainMemoryContext | null }>) {
  // The context bound measures the same WorkClass view the prompt carries (brainWorkClassView: no scoring, admission or worker lists).
  const workClasses = mergeWorkClassRegistries(CORE_WORK_CLASSES, registry.workClasses ? [registry.workClasses] : []);
  const settings = brainPlannerConfigSchema.parse(config), limits = settings.context;
  // ATAMA-1: a system-assignment template offers the model no worker models at all; the system assigns them at admission.
  const template = selectedBrainTemplate(settings), offerModels = template.modelAssignment !== 'system';
  const order = <T>(rows: readonly T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  // S4B-6: a template written for context v3 gets the memory block (null: none supplied); an earlier one keeps the v2 shape byte for byte.
  const version = template.contextVersion === 3 ? { schemaVersion: 3 as const, memory: selections?.memory ?? null } : { schemaVersion: 2 as const };
  const context = boundBrainContext(command.scopeId, brainWorkClassView(workClasses), { ...version, registryRevision: registry.revision,
    kinds: order(selections?.kinds ?? registry.kinds.map(row => ({ kind: row.kind, profile: row.profile, type: 'prepared' as const })), row => row.kind),
    workerModels: order(offerModels ? selections?.workerModels ?? [] : [], row => JSON.stringify([row.profile.id, row.profile.version, row.channelId, row.modelId])),
    evaluators: order(registry.evaluators.map(row => ({ id: row.id, version: row.version, parameters: prepareBrainEvaluatorParameters(row) })), row => JSON.stringify([row.id, row.version])),
    // Only stable budget facts enter the prompt: the remaining money moves with every charge (this call's own included), and a retried
    // plan must resend the byte-identical request; the system caps the ceiling at the remaining money after the call instead.
    permissions: getPolicyVocabulary().resources, budget: budget && { currency: budget.currency, limitMinorUnits: budget.limitMinorUnits }, scopePaths: { state: 'not-inspected' } }, limits);
  const prompt = prepareBrainPrompt(command, workClasses, context, config, known);
  const bytes = new TextEncoder().encode(JSON.stringify(prompt.messages)).length;
  if (bytes > limits.requestMaxBytes) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: limits.requestMaxBytes, observed: bytes, unit: 'bytes' } });
  // The memory that actually went into the prompt (after the planning byte bound), for the seal and the card; null: no memory block.
  const memory = 'memory' in context && context.memory && version.schemaVersion === 3 && version.memory
    ? { entries: context.memory.entries, omitted: context.memory.omitted, truncated: context.truncation.omittedMemory ?? 0 } : null;
  return { ...prompt, memory, invocationSettings: { ...(settings.maxCompletionTokens === null ? {} : { maxCompletionTokens: settings.maxCompletionTokens }),
    ...(settings.reasoning === 'off' ? { reasoning: settings.reasoning } : {}) } };
}
/** Provider count when available; UTF-8 bytes plus configured framing is a conservative tagged estimate otherwise. */
export function assertBrainContextFits(command: ModelInvocationCommand, config: unknown, profileWindow: number | null,
  measurement: Readonly<{ promptTokens: number; windowTokens: number | null }> | null) {
  const limits = brainPlannerConfigSchema.parse(config).context;
  const bytes = new TextEncoder().encode(JSON.stringify(command.nativeRequest)).length;
  if (bytes > limits.requestMaxBytes) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: limits.requestMaxBytes, observed: bytes, unit: 'bytes' } });
  const windows = [profileWindow, measurement?.windowTokens ?? null].filter((value): value is number => value !== null);
  const window = windows.length ? Math.min(...windows) : null;
  const input = measurement?.promptTokens ?? bytes + limits.tokenFramingAllowance;
  const output = command.nativeRequest['max_completion_tokens'];
  if (window !== null && typeof output === 'number' && input + output > window) {
    throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: window, observed: input + output,
      unit: measurement ? 'tokens' : 'estimated-tokens' } });
  }
}
export interface BrainPreparation { readonly invocation: ModelInvocationCommand; readonly prompt: ReturnType<typeof prepareBrainPrompt>; readonly kinds?: readonly string[];
  /** S4B-6: the planning call's memory note for the card (response-only). */ readonly planningMemory?: PlanningMemoryNote;
  /** f3 (owner Q-H4): the configured quota wait bounds; absent: a quota refusal is the typed refusal at once. */ readonly quotaWait?: BrainQuotaWaitPolicy }
export interface BrainPlanPorts {
  readonly knownSecrets?: KnownSecretSnapshot | undefined;
  inspect(query: RunProposalQuery): Promise<RunPlanningResult | null>;
  prepare(command: BrainPlanCommand, principal: VerifiedPrincipal): Promise<BrainPreparation>;
  invoke(command: ModelInvocationCommand, signal?: AbortSignal): Promise<ModelInvocationResult>;
  text(result: ModelInvocationResult): string | null;
  stoppedAtLength(result: ModelInvocationResult): boolean;
  propose(proposal: RunProposal): Promise<RunProposalResult>;
  /** S3-4: a rejected call's retained adapter body (base64) read under the caller's content right; null when not retained or not readable. */
  rejectionBody?(result: ModelInvocationResult): Promise<string | null>;
  /** The scope's remaining money after the planning call, when observable; null when no budget is readable. */
  remainingBudget?(scopeId: string): Promise<Readonly<{ currency: string; remainingMinorUnits: number }> | null>;
  /** Wall clock of the quota wait (tests pin it); absent: Date.now. */
  now?(): number;
  /** f4: keeps an active quota wait visible to surfaces that did not start it (monitor, MCP). Best effort: a store failure never changes planning. */
  readonly quotaWaits?: BrainQuotaWaitStore;
}
const assertActive = (signal?: AbortSignal) => { if (signal?.aborted) throw ErrorRegistry.createError('BRAIN_CANCELLED'); };
/** The tier/role registry role a Brain model must hold (owner BRAIN1: frontier only). */
export const BRAIN_MODEL_ROLE = 'brain';
/** S2 Brain gate (owner A2, A3): the exact model the planner is about to call — its bound definition re-resolved from the same declared catalog
 * and digest-checked against the prepared command — must be eligible for the Brain role (tier, or a current dated exception) AND active in
 * the scope. An inactive eligible model keeps the existing inactive-model refusal; anything else is one typed BRAIN_TIER_REFUSED naming the
 * model and the reason. Never another model in its place. */
export async function assertBrainModelRole(sources: RoleModelSources, command: ModelInvocationCommand, nowMs: number) {
  const definition = sources.providerCatalog === undefined ? null : resolveModelBindingDefinition(parseProviderCatalog(sources.providerCatalog), command.reference);
  if (!definition || sha256(encodeModelBindingDefinition(definition)) !== command.expectedBinding.digest) throw ErrorRegistry.createError('MODEL_INVOCATION_BINDING_CONFLICT');
  const target = { channelId: definition.provider.id, modelId: definition.model.nativeId }, ports = roleModelPorts(sources);
  const record = await ports.activation(command.scopeId, command.reference);
  const decision = await decideRoleModelInScope(composeModelRolePolicy(sources.modelRoles), BRAIN_MODEL_ROLE, command.scopeId, target, ports, nowMs, record?.state === 'active');
  if (decision.state === 'eligible') return decision;
  if (decision.reason === 'not-active') refuseInactiveModel(command, record);
  throw ErrorRegistry.createError('BRAIN_TIER_REFUSED', { params: { ...target, reason: decision.reason } });
}
/** S4B-6: whether the configured Brain template is written for context v3 (memory); an earlier one never reads memory. */
export const brainTakesMemory = (config: unknown) => selectedBrainTemplate(config).contextVersion === 3;
/** Whether the configured Brain template leaves worker assignment to the system (callers then skip the worker-model catalog read). */
export const brainAssignsWorkers = (config: unknown) => selectedBrainTemplate(config).modelAssignment !== 'system';
/**
 * S3-4: the typed cause of a rejected planning call. The subscription CLI step's own adapter body names it (quota with its reset, credits, login,
 * a stopped guard, an output the CLI itself refused); any other adapter, or another cause, keeps BRAIN_PROVIDER_REJECTED. Nothing is retried (a quota wait
 * starts a new derived attempt instead, see `plan`).
 */
function brainRejection(evidence: Readonly<{ adapter: ModelInvocationResponseEvidence['adapter']; reason: string; httpStatus: number | null }>, data: string | null) {
  const body = data === null ? null : readHeadlessRejection({ adapter: evidence.adapter, body: { data } }), create = (code: string, options?: Parameters<typeof ErrorRegistry.createError>[1]) => ErrorRegistry.createError(code, options);
  switch (body?.refusal) {
    case 'quota': return create('HEADLESS_QUOTA_EXHAUSTED', { params: typeof body.resetsAtMs === 'number' ? { resetsAtMs: body.resetsAtMs } : {} });
    case 'credits-required': return create('HEADLESS_CREDITS_REQUIRED');
    case 'login-required': return create('HEADLESS_LOGIN_REQUIRED');
    case 'guard': case 'model-mismatch': return create('HEADLESS_GUARD_FAILED', { params: { field: body.field ?? body.refusal } });
    case 'invalid-output': return create('BRAIN_OUTPUT_INVALID', { params: { stage: body.subtype ?? 'result' } });
    case 'resource-limit': return create('HEADLESS_LIMIT_REACHED', { params: { limit: body.field ?? 'unknown' } });
    default: return create('BRAIN_PROVIDER_REJECTED', { params: { reason: body?.refusal ?? evidence.reason, status: evidence.httpStatus ?? 'unknown' } });
  }
}
/** One model step; no tool loop, retry, Run writer or approval decision. */
export class BrainPlanApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly ports: BrainPlanPorts) {}
  /** `observe`: the surface that shows progress. Only a caller that shows the wait gets one (owner Q-H4: a short VISIBLE wait); without it a
   * quota refusal is the typed refusal at once. */
  async plan(input: unknown, credential?: unknown, signal?: AbortSignal, observe?: BrainPlanObserver): Promise<RunProposalResult> {
    const parsed = brainPlanCommandInputSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('BRAIN_INPUT_INVALID');
    const command = parsed.data, principal = await authenticate(this.verifier, credential, command.scopeId);
    const proposer = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    assertActive(signal);
    const runId = brainRunId(command), kept = await this.ports.inspect({ schemaVersion: 1, scopeId: command.scopeId, runId, commandId: command.commandId });
    if (kept && isRunIntentResult(kept)) {
      if (kept.intent.status !== 'starting' || encodeCommandProjection('intent-command', kept.intent.command) !== encodeCommandProjection('intent-command', command)
        || encodeCommandProjection('actor', kept.intent.proposer) !== encodeCommandProjection('actor', proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
    } else if (kept) {
      const source = kept.proposal.proposal.source;
      if (source.kind !== 'model' || source.contribution?.inputDigest !== brainInputDigest(command, this.ports.knownSecrets)
        || encodeCommandProjection('actor', kept.proposal.proposal.proposer) !== encodeCommandProjection('actor', proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
      assertActive(signal);
      return this.ports.propose(kept.proposal.proposal);
    }
    const prepared = await this.ports.prepare(command, principal);
    assertActive(signal);
    let invocation = { ...prepared.invocation, commandId: brainInvocationCommandId(command) }, result: ModelInvocationResult;
    const now = () => this.ports.now?.() ?? Date.now();
    // f3 (owner Q-H4): a quota refusal whose reset is within the registry bound waits visibly, then the SAME prepared request goes out under a
    // new derived command id (lineage: the refused call's ids); never the refused call again, never more than `maxAttempts` calls.
    for (let attempt = 1; ; attempt++) {
      try { result = await this.ports.invoke(invocation, signal); }
      catch (error) { assertActive(signal); throw error; }
      assertActive(signal);
      const receipt = result.receipt;
      if (receipt.request.requestDigest !== modelInvocationRequestDigest(invocation) || receipt.request.commandId !== invocation.commandId
        || encodeCommandProjection('model-ref', receipt.request.reference) !== encodeCommandProjection('model-ref', invocation.reference)
        || receipt.request.expectedBinding.digest !== invocation.expectedBinding.digest
        || receipt.request.scopeId !== command.scopeId || encodeCommandProjection('actor', proposer)
          !== encodeCommandProjection('actor', { id: receipt.actor.id, issuer: receipt.actor.issuer, subject: receipt.actor.subject })) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
      if (receipt.outcome?.state !== 'rejected') break;
      const data = await this.ports.rejectionBody?.(result).catch(() => null) ?? null;
      const body = data === null ? null : readHeadlessRejection({ adapter: receipt.outcome.evidence.adapter, body: { data } });
      const untilMs = observe && prepared.quotaWait ? brainQuotaWaitUntil(body, receipt.outcome.observedAtMs, now(), attempt, prepared.quotaWait) : null;
      if (untilMs === null || body?.refusal !== 'quota' || typeof body.resetsAtMs !== 'number') throw brainRejection(receipt.outcome.evidence, data);
      const after = { commandId: invocation.commandId, invocationId: receipt.claim.invocationId };
      const waits = this.ports.quotaWaits;
      await waits?.begin({ schemaVersion: 1, scopeId: command.scopeId, commandId: command.commandId, attempt: attempt + 1, maxAttempts: prepared.quotaWait!.maxAttempts,
        sinceMs: now(), resetsAtMs: body.resetsAtMs, untilMs, after }).catch(() => undefined);
      // f4: the record lives exactly as long as the wait: reset reached, cancelled or failed, it is removed.
      try {
        observe!({ kind: 'quota-wait', attempt: attempt + 1, maxAttempts: prepared.quotaWait!.maxAttempts, resetsAtMs: body.resetsAtMs, untilMs, after });
        await waitUntil(untilMs, now, signal);
      } finally { await waits?.end(command.scopeId, command.commandId).catch(() => undefined); }
      assertActive(signal);
      invocation = { ...prepared.invocation, commandId: brainQuotaAttemptCommandId(command, attempt + 1, after) };
      observe!({ kind: 'planning', attempt: attempt + 1 });
    }
    const receipt = result.receipt;
    if (receipt.outcome?.state !== 'responded') throw ErrorRegistry.createError('BRAIN_OUTCOME_UNKNOWN');
    const text = this.ports.text(result);
    const outputCap = invocation.nativeRequest['max_completion_tokens'];
    if (!text) throw this.ports.stoppedAtLength(result)
      ? ErrorRegistry.createError('BRAIN_OUTPUT_TRUNCATED', { params: { maxCompletionTokens: typeof outputCap === 'number' ? outputCap : 'unknown' } })
      : ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'content' } });
    let draft: ReturnType<typeof parseBrainDraft>;
    // A JSON answer cut at the output limit is truncated, not invalid (2026-10-14 finding): the person raises the limit, not the template.
    try { draft = parseBrainDraft(text, this.ports.knownSecrets, { requireCurrentGraph: true }); } catch (error) {
      const failure = error as { code?: unknown; params?: { stage?: unknown } };
      if (failure.code === 'BRAIN_OUTPUT_INVALID' && failure.params?.stage === 'json' && this.ports.stoppedAtLength(result)) throw ErrorRegistry.createError('BRAIN_OUTPUT_TRUNCATED',
        { params: { maxCompletionTokens: typeof outputCap === 'number' ? outputCap : 'unknown' } });
      throw error;
    }
    const usage = openAiChatUsageSchema.safeParse(result.response?.usage);
    if (prepared.prompt.modelAssignment === 'system') assertBrainLeavesAssignment(draft);
    if (prepared.kinds && draft.graph.tasks.some(task => !prepared.kinds!.includes(task.kind))) {
      throw ErrorRegistry.createError('BRAIN_GRAPH_INVALID', { params: { rule: 'TASK_KIND_NOT_REGISTERED' } });
    }
    const prompt = prepared.prompt, limit = prompt.summaryChars;
    // The system, not the model, bounds the declared ceiling: at most the money left after this planning call (live 2026-10-17: a copied
    // 100 USD limit refused every plan once 12.17 USD was spent). The model's number can only narrow it; the source check enforces that.
    const left = await this.ports.remainingBudget?.(command.scopeId), asked = draft.budgetCeiling;
    // Nothing left (zero or less) keeps the model's number, so admission refuses it naming the remaining money: never a zero ceiling.
    const budgetCeiling = left && left.currency === asked.currency && left.remainingMinorUnits > 0 && left.remainingMinorUnits < asked.limitMinorUnits
      ? { currency: asked.currency, limitMinorUnits: left.remainingMinorUnits } : asked;
    const proposal: RunProposal = { schemaVersion: 1, commandId: command.commandId, proposalId: runId, scopeId: command.scopeId, runId,
      proposer, ...draft, budgetCeiling, source: { kind: 'model', receipt: { commandId: invocation.commandId, invocationId: receipt.claim.invocationId,
        reference: receipt.request.reference, responseDigest: receipt.outcome.content.digest }, contribution: { schemaVersion: 2, billingAxis: modelInvocationBillingAxis(receipt.profile),
        template: prompt.template, inputDigest: prompt.inputDigest, contextDigest: prompt.contextDigest, outputDigest: brainOutputDigest(draft),
        requestDigest: receipt.request.requestDigest, activationRevision: receipt.activationRevision, bindingDigest: receipt.request.expectedBinding.digest,
        inputSummary: prompt.intent.slice(0, limit), outputSummary: redactForRecord(JSON.stringify(draft), this.ports.knownSecrets).slice(0, limit),
        usage: usage.success ? { inputTokens: usage.data.prompt_tokens, outputTokens: usage.data.completion_tokens, totalTokens: usage.data.total_tokens } : null } } };
    assertActive(signal);
    const recorded = await this.ports.propose(proposal);
    return prepared.planningMemory ? { ...recorded, planningMemory: prepared.planningMemory } : recorded;
  }
}
