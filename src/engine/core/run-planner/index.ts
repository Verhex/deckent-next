import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { brainPlanCommandInputSchema, encodeCommandProjection, openAiChatUsageSchema, CORE_WORK_CLASSES, mergeWorkClassRegistries, getPolicyVocabulary, type ExecutionRegistry, type BrainPlanCommand, type ModelInvocationCommand,
  type RunProposal, type VerifiedPrincipal } from '#domain/index.js';
import { brainInputDigest, brainOutputDigest, parseBrainDraft, prepareBrainPrompt, brainPlannerConfigSchema, boundBrainContext,
  prepareBrainEvaluatorParameters, type BrainRegistryContext } from '#capabilities/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { modelInvocationRequestDigest, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import type { RunProposalQuery, RunProposalResult } from '#engine/core/runs/index.js';
export const brainRunId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-run:1', { scopeId: command.scopeId, commandId: command.commandId }));
export const brainInvocationCommandId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-invocation:1', { scopeId: command.scopeId, commandId: command.commandId }));
export function prepareBrainRegistryPrompt(command: BrainPlanCommand, registry: ExecutionRegistry,
  budget: { currency: string; limitMinorUnits: number } | null, config: unknown, known?: KnownSecretSnapshot,
  selections?: Readonly<{ kinds: BrainRegistryContext['kinds']; workerModels: BrainRegistryContext['workerModels'] }>) {
  const workClasses = mergeWorkClassRegistries(CORE_WORK_CLASSES, registry.workClasses ? [registry.workClasses] : []);
  const settings = brainPlannerConfigSchema.parse(config), limits = settings.context;
  const order = <T>(rows: readonly T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const context = boundBrainContext(command.scopeId, workClasses, { schemaVersion: 2, registryRevision: registry.revision,
    kinds: order(selections?.kinds ?? registry.kinds.map(row => ({ kind: row.kind, profile: row.profile, type: 'prepared' as const })), row => row.kind),
    workerModels: order(selections?.workerModels ?? [], row => JSON.stringify([row.profile.id, row.profile.version, row.channelId, row.modelId])),
    evaluators: order(registry.evaluators.map(row => ({ id: row.id, version: row.version, parameters: prepareBrainEvaluatorParameters(row) })), row => JSON.stringify([row.id, row.version])),
    // Only stable budget facts enter the prompt: the remaining money moves with every charge (this call's own included), and a retried
    // plan must resend the byte-identical request; the system caps the ceiling at the remaining money after the call instead.
    permissions: getPolicyVocabulary().resources, budget: budget && { currency: budget.currency, limitMinorUnits: budget.limitMinorUnits }, scopePaths: { state: 'not-inspected' } }, limits);
  const prompt = prepareBrainPrompt(command, workClasses, context, config, known);
  const bytes = new TextEncoder().encode(JSON.stringify(prompt.messages)).length;
  if (bytes > limits.requestMaxBytes) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: limits.requestMaxBytes, observed: bytes, unit: 'bytes' } });
  return { ...prompt, invocationSettings: { ...(settings.maxCompletionTokens === null ? {} : { maxCompletionTokens: settings.maxCompletionTokens }),
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
export interface BrainPreparation { readonly invocation: ModelInvocationCommand; readonly prompt: ReturnType<typeof prepareBrainPrompt>; readonly kinds?: readonly string[] }
export interface BrainPlanPorts {
  readonly knownSecrets?: KnownSecretSnapshot | undefined;
  inspect(query: RunProposalQuery): Promise<RunProposalResult | null>;
  prepare(command: BrainPlanCommand, principal: VerifiedPrincipal): Promise<BrainPreparation>;
  invoke(command: ModelInvocationCommand, signal?: AbortSignal): Promise<ModelInvocationResult>;
  text(result: ModelInvocationResult): string | null;
  stoppedAtLength(result: ModelInvocationResult): boolean;
  propose(proposal: RunProposal): Promise<RunProposalResult>;
  /** The scope's remaining money after the planning call, when observable; null when no budget is readable. */
  remainingBudget?(scopeId: string): Promise<Readonly<{ currency: string; remainingMinorUnits: number }> | null>;
}
const assertActive = (signal?: AbortSignal) => { if (signal?.aborted) throw ErrorRegistry.createError('BRAIN_CANCELLED'); };
/** One model step; no tool loop, retry, Run writer or approval decision. */
export class BrainPlanApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly ports: BrainPlanPorts) {}
  async plan(input: unknown, credential?: unknown, signal?: AbortSignal): Promise<RunProposalResult> {
    const parsed = brainPlanCommandInputSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('BRAIN_INPUT_INVALID');
    const command = parsed.data, principal = await authenticate(this.verifier, credential, command.scopeId);
    const proposer = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    assertActive(signal);
    const runId = brainRunId(command), kept = await this.ports.inspect({ schemaVersion: 1, scopeId: command.scopeId, runId, commandId: command.commandId });
    if (kept) {
      const source = kept.proposal.proposal.source;
      if (source.kind !== 'model' || source.contribution?.inputDigest !== brainInputDigest(command, this.ports.knownSecrets)
        || encodeCommandProjection('actor', kept.proposal.proposal.proposer) !== encodeCommandProjection('actor', proposer)) throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT');
      assertActive(signal);
      return this.ports.propose(kept.proposal.proposal);
    }
    const prepared = await this.ports.prepare(command, principal);
    assertActive(signal);
    const invocation = { ...prepared.invocation, commandId: brainInvocationCommandId(command) };
    let result: ModelInvocationResult;
    try { result = await this.ports.invoke(invocation, signal); }
    catch (error) { assertActive(signal); throw error; }
    assertActive(signal);
    const receipt = result.receipt;
    if (receipt.request.requestDigest !== modelInvocationRequestDigest(invocation) || receipt.request.commandId !== invocation.commandId
      || encodeCommandProjection('model-ref', receipt.request.reference) !== encodeCommandProjection('model-ref', invocation.reference)
      || receipt.request.expectedBinding.digest !== invocation.expectedBinding.digest
      || receipt.request.scopeId !== command.scopeId || encodeCommandProjection('actor', proposer)
        !== encodeCommandProjection('actor', { id: receipt.actor.id, issuer: receipt.actor.issuer, subject: receipt.actor.subject })) throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID');
    if (receipt.outcome?.state === 'rejected') throw ErrorRegistry.createError('BRAIN_PROVIDER_REJECTED', {
      params: { reason: receipt.outcome.evidence.reason, status: receipt.outcome.evidence.httpStatus ?? 'unknown' } });
    if (receipt.outcome?.state !== 'responded') throw ErrorRegistry.createError('BRAIN_OUTCOME_UNKNOWN');
    const text = this.ports.text(result);
    const outputCap = invocation.nativeRequest['max_completion_tokens'];
    if (!text) throw this.ports.stoppedAtLength(result)
      ? ErrorRegistry.createError('BRAIN_OUTPUT_TRUNCATED', { params: { maxCompletionTokens: typeof outputCap === 'number' ? outputCap : 'unknown' } })
      : ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'content' } });
    const draft = parseBrainDraft(text, this.ports.knownSecrets, { requireCurrentGraph: true }), usage = openAiChatUsageSchema.safeParse(result.response?.usage);
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
    return this.ports.propose(proposal);
  }
}
