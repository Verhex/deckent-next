import { z } from 'zod';
import { identitySchema, verifiedPrincipalSchema, isBeuserEvaluatorPrincipal, sameAttemptIdentity, encodeCommandProjection } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { acceptanceSubjectSchema, beuserBindingSchema, beuserSealedRubricSchema, type BeuserBinding } from '#domain/core/beuser/index.js';
import { BeuserContractError, pinBeuserLimits, pinBeuserWalkerSummary, assertBeuserAccess, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { runAdmissionSchema, runReservationCommandSchema, type RunAdmissionApplication, type RunReservationApplication } from '#engine/core/runs/index.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const cellSchema = z.object({ taskId: identitySchema, branchId: identitySchema, journeyDigest: digest, repeat: z.number().int().positive().safe(), summary: z.unknown() }).strict();
const campaignSchema = z.object({ run: runAdmissionSchema, candidate: acceptanceSubjectSchema, candidateDigest: digest, cells: z.array(cellSchema).min(1), limits: z.unknown(), rubric: beuserSealedRubricSchema }).strict();
export type BeuserCampaign = ReturnType<typeof pinBeuserCampaign>;
export interface BeuserExecutionProfile { readonly taskKind: string; readonly evaluator: { readonly id: string; readonly version: number } }
export function pinBeuserCampaign(input: unknown, profile: BeuserExecutionProfile) {
  const parsed = campaignSchema.parse(input), limits = pinBeuserLimits(parsed.limits);
  const cells = parsed.cells.map(cell => Object.freeze({ ...cell, summary: pinBeuserWalkerSummary(cell.summary) }));
  const tasks = parsed.run.graph.tasks, keys = cells.map(cell => JSON.stringify([cell.summary.personaId, cell.branchId, cell.repeat]));
  if (parsed.run.branch || tasks.length !== cells.length || new Set(keys).size !== keys.length || new Set(cells.map(cell => cell.taskId)).size !== cells.length
    || cells.some(cell => cell.summary.journeyId !== parsed.rubric.journeyId)
    || tasks.some(task => task.kind !== profile.taskKind || task.workClass !== undefined || task.workInput !== undefined || !cells.some(cell => cell.taskId === task.id)
      || !parsed.run.graph.criterionDefinitions.some(criterion => task.acceptanceCriteria.includes(criterion.id)
        && criterion.evaluator.id === profile.evaluator.id && criterion.evaluator.version === profile.evaluator.version))) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return Object.freeze({ ...parsed, cells: Object.freeze(cells), limits, inputDigest: sha256(encodeCommandProjection('beuser-campaign:1', { ...parsed, cells, limits })) });
}
/** Pure profile validation only. Composition seals this pin through the generic Run authority, never before its authorization. */
export async function admitBeuserCampaign(campaign: BeuserCampaign, runs: Pick<RunAdmissionApplication, 'create'>, credential: unknown,
  validateProfile: (campaign: BeuserCampaign) => Promise<{ readonly inputDigest: string }>): ReturnType<RunAdmissionApplication['create']> {
  if ((await validateProfile(campaign)).inputDigest !== campaign.inputDigest) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return runs.create(campaign.run, credential);
}
/** Trusted reservation supplies the real generation. A client can never deserialize its own workload assurance. */
export function admitBeuserAttempt(campaign: BeuserCampaign, input: { binding: unknown; principal: unknown; signal: AbortSignal }): BeuserContext {
  const binding = beuserBindingSchema.parse(input.binding), principal = verifiedPrincipalSchema.parse(input.principal);
  const cell = campaign.cells.find(cell => cell.taskId === binding.identity.taskId);
  if (!cell || binding.identity.scopeId !== campaign.run.scopeId || binding.identity.runId !== campaign.run.runId
    || JSON.stringify(binding.candidate) !== JSON.stringify(campaign.candidate) || binding.journeyDigest !== cell.journeyDigest
    || binding.candidateDigest !== campaign.candidateDigest || binding.rubricDigest !== campaign.rubric.digest
    || binding.personaDigest !== sha256(encodeCommandProjection('beuser-persona:1', cell.summary))
    || !isBeuserEvaluatorPrincipal(principal) || principal.assurance !== 'workload-verified') throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const context = Object.freeze({ binding, principal, signal: input.signal, limits: campaign.limits });
  assertBeuserAccess(context, binding, principal, { kind: 'run', id: binding.identity.runId }, 'inspect');
  return context;
}
export function assertBeuserRequestIdentity(context: BeuserContext, identity: BeuserBinding['identity']): void {
  if (!sameAttemptIdentity(context.binding.identity, identity)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
}
/** Generic reservation atomically creates real Attempts; never create a second Attempt or write the Run directly. */
export async function reserveBeuserAttempts(campaign: BeuserCampaign, commandInput: unknown, reservations: Pick<RunReservationApplication, 'reserve'>, credential: unknown) {
  const command = runReservationCommandSchema.parse(commandInput);
  if (command.scopeId !== campaign.run.scopeId || command.runId !== campaign.run.runId) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const result = await reservations.reserve(command, credential);
  if (result.identities.some(identity => identity.scopeId !== campaign.run.scopeId || identity.runId !== campaign.run.runId
    || !campaign.cells.some(cell => cell.taskId === identity.taskId))) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  return result;
}
