import { brainPlanCommandInputSchema, encodeCommandProjection, openAiChatUsageSchema, CORE_WORK_CLASSES, mergeWorkClassRegistries, getPolicyVocabulary, type ExecutionRegistry, type BrainPlanCommand, type ModelInvocationCommand,
  type RunProposal, type VerifiedPrincipal } from '#domain/index.js';
import { brainInputDigest, brainOutputDigest, parseBrainDraft, prepareBrainPrompt } from '#capabilities/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { modelInvocationRequestDigest, type ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import type { RunProposalQuery, RunProposalResult } from '#engine/core/runs/index.js';
export const brainRunId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-run:1', { scopeId: command.scopeId, commandId: command.commandId }));
export const brainInvocationCommandId = (command: BrainPlanCommand) => sha256(encodeCommandProjection('brain-invocation:1', { scopeId: command.scopeId, commandId: command.commandId }));
export function prepareBrainRegistryPrompt(command: BrainPlanCommand, registry: ExecutionRegistry,
  budget: { currency: string; limitMinorUnits: number }, config: unknown, known?: KnownSecretSnapshot) {
  const workClasses = mergeWorkClassRegistries(CORE_WORK_CLASSES, registry.workClasses ? [registry.workClasses] : []);
  return prepareBrainPrompt(command, workClasses, { registry, permissions: getPolicyVocabulary().resources, budget }, config, known);
}
export interface BrainPreparation { readonly invocation: ModelInvocationCommand; readonly prompt: ReturnType<typeof prepareBrainPrompt> }
export interface BrainPlanPorts {
  readonly knownSecrets?: KnownSecretSnapshot | undefined;
  inspect(query: RunProposalQuery): Promise<RunProposalResult | null>;
  prepare(command: BrainPlanCommand, principal: VerifiedPrincipal): Promise<BrainPreparation>;
  invoke(command: ModelInvocationCommand, signal?: AbortSignal): Promise<ModelInvocationResult>;
  text(result: ModelInvocationResult): string | null;
  propose(proposal: RunProposal): Promise<RunProposalResult>;
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
    if (receipt.outcome?.state !== 'responded') throw ErrorRegistry.createError('BRAIN_OUTCOME_UNKNOWN');
    const text = this.ports.text(result);
    if (!text) throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'content' } });
    const draft = parseBrainDraft(text, this.ports.knownSecrets), usage = openAiChatUsageSchema.safeParse(result.response?.usage);
    const prompt = prepared.prompt, limit = prompt.summaryChars;
    const proposal: RunProposal = { schemaVersion: 1, commandId: command.commandId, proposalId: runId, scopeId: command.scopeId, runId,
      proposer, ...draft, source: { kind: 'model', receipt: { commandId: invocation.commandId, invocationId: receipt.claim.invocationId,
        reference: receipt.request.reference, responseDigest: receipt.outcome.content.digest }, contribution: { schemaVersion: 1,
        template: prompt.template, inputDigest: prompt.inputDigest, contextDigest: prompt.contextDigest, outputDigest: brainOutputDigest(draft),
        requestDigest: receipt.request.requestDigest, activationRevision: receipt.activationRevision, bindingDigest: receipt.request.expectedBinding.digest,
        inputSummary: prompt.intent.slice(0, limit), outputSummary: redactForRecord(JSON.stringify(draft), this.ports.knownSecrets).slice(0, limit),
        usage: usage.success ? { inputTokens: usage.data.prompt_tokens, outputTokens: usage.data.completion_tokens, totalTokens: usage.data.total_tokens } : null } } };
    assertActive(signal);
    return this.ports.propose(proposal);
  }
}
