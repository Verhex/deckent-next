import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, attemptIdentitySchema, criterionDefinitionSchema, evaluatorDefinitionSchema, identitySchema, operationEvidenceBindingReason,
  type OperationEvidenceBinding,
  type AttemptIdentity, type CriterionDefinition, type EvaluatorDefinition, type TaskEvaluation } from '#domain/index.js';
import { PROCESS_EXIT_EVALUATOR, processExitTerminalEvaluator, validateInstalledProcessExitEvaluator, validateProcessExitCriterion } from './process-exit.js';

export const OPERATION_EVIDENCE_EVALUATOR = Object.freeze({ id: 'operation-evidence', version: 1,
  implementation: Object.freeze({ id: 'operation-evidence', version: 1 }) });
const parametersSchema = z.object({ commandId: identitySchema }).strict().readonly();
/** Structurally compatible with the existing effect store's read method. The reader owns canonical record validation;
 * this capability checks only its consumed projection, never replaces the effect contract or writes a settlement. */
export interface OperationEvidenceReader {
  loadEffect(scopeId: string, commandId: string): Promise<unknown>;
  /** Returns a canonical settled or open compensation; refused compensations do not reverse the original. */
  loadEffectCompensation?(scopeId: string, commandId: string): Promise<unknown>;
}
const operation = z.object({ id: identitySchema, version: counterSchema.positive() });
const projectionSchema = z.object({ sequence: counterSchema.positive(), state: z.enum(['settled', 'claimed', 'unknown', 'refused']),
  intent: z.object({ command: z.object({ scopeId: identitySchema, commandId: identitySchema, operation,
    target: z.object({ kind: identitySchema, id: z.string().min(1).max(512) }), compensates: identitySchema.optional() }),
    descriptor: z.object({ compensation: operation.nullable() }), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict() }),
  evidence: z.object({ kind: z.enum(['idempotency-record', 'fence']), version: z.string().min(1).max(256).nullable(), observedAt: counterSchema }).strict().nullable(),
  refusal: z.enum(['EFFECT_PRECONDITION_CHANGED', 'EFFECT_REJECTED']).nullable(),
}).refine(record => (record.state === 'settled') === (record.evidence !== null) && (record.state === 'refused') === (record.refusal !== null));
export type OperationSettlementReference = Readonly<{ kind: 'operation-settlement'; scopeId: string; commandId: string;
  sequence: number; inputDigest: string; digest: string }>;
type CriterionResult = TaskEvaluation['criteria'][number];
export type OperationEvidenceResult = (Readonly<{ verdict: 'pass'; evidence: OperationSettlementReference }>
  | Readonly<{ verdict: 'unknown' | 'fail'; reason: NonNullable<CriterionResult['reason']> }>)
  & Readonly<{ effectEvidence?: NonNullable<CriterionResult['effectEvidence']> }>;

/** Implementation identity selects installed code; registry aliases remain data and do not grant authority. */
export function validateInstalledEvaluator(evaluator: EvaluatorDefinition): undefined {
  const installed = evaluatorDefinitionSchema.parse(evaluator);
  if (installed.implementation.id === PROCESS_EXIT_EVALUATOR.implementation.id) return validateInstalledProcessExitEvaluator(installed);
  if (installed.implementation.id !== OPERATION_EVIDENCE_EVALUATOR.implementation.id
    || installed.implementation.version !== OPERATION_EVIDENCE_EVALUATOR.implementation.version) throw new Error('TASK_EVALUATOR_INVALID');
  return undefined;
}
export function validateInstalledCriterion(evaluator: EvaluatorDefinition, criterion: CriterionDefinition): undefined {
  validateInstalledEvaluator(evaluator);
  if (evaluator.implementation.id === PROCESS_EXIT_EVALUATOR.implementation.id) return validateProcessExitCriterion(evaluator, criterion);
  const definition = criterionDefinitionSchema.parse(criterion);
  if (definition.evaluator.id !== evaluator.id || definition.evaluator.version !== evaluator.version) throw new Error('TASK_EVALUATOR_INVALID');
  parametersSchema.parse(definition.parameters);
  return undefined;
}
/** Identity comes from authenticated Task evaluation, never criterion parameters. Missing/unavailable settlement holds acceptance.
 * A reference hashes the complete reader-validated record and is retained by the canonical evaluation writer. */
export async function evaluateOperationEvidence(reader: OperationEvidenceReader, evaluator: EvaluatorDefinition,
  criterion: CriterionDefinition, identity: AttemptIdentity, binding?: OperationEvidenceBinding): Promise<OperationEvidenceResult> {
  validateInstalledCriterion(evaluator, criterion);
  if (evaluator.implementation.id !== OPERATION_EVIDENCE_EVALUATOR.implementation.id) throw new Error('TASK_EVALUATOR_INVALID');
  const context = attemptIdentitySchema.parse(identity), { commandId } = parametersSchema.parse(criterion.parameters);
  let input: unknown;
  try { input = await reader.loadEffect(context.scopeId, commandId); }
  catch { return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_UNAVAILABLE' }); }
  if (input === null) return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_MISSING',
    effectEvidence: Object.freeze({ commandId, digest: null, compensation: null }) });
  const parsed = projectionSchema.safeParse(input);
  if (!parsed.success) return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' });
  const record = parsed.data;
  if (record.intent.command.scopeId !== context.scopeId || record.intent.command.commandId !== commandId) {
    return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_BINDING' });
  }
  const recordDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const observed = { commandId, digest: recordDigest, compensation: null as NonNullable<CriterionResult['effectEvidence']>['compensation'] };
  const result = (verdict: 'unknown' | 'fail', reason: NonNullable<CriterionResult['reason']>): OperationEvidenceResult =>
    Object.freeze({ verdict, reason, effectEvidence: Object.freeze({ ...observed }) });
  // The acceptance transaction cites the compensation of every settled compensable record, so it is observed before any verdict.
  const compensationOutcome = async (): Promise<OperationEvidenceResult | undefined> => {
    if (record.state !== 'settled' || !record.intent.descriptor.compensation) return undefined;
    if (!reader.loadEffectCompensation) return result('unknown', 'OPERATION_COMPENSATION_UNAVAILABLE');
    let compensation: unknown;
    try { compensation = await reader.loadEffectCompensation(context.scopeId, commandId); }
    catch { return result('unknown', 'OPERATION_COMPENSATION_UNAVAILABLE'); }
    if (compensation === null) return undefined;
    const found = projectionSchema.safeParse(compensation);
    if (!found.success) return result('unknown', 'OPERATION_COMPENSATION_INVALID');
    const command = found.data.intent.command, original = record.intent.command;
    if (command.scopeId !== context.scopeId || command.compensates !== commandId
      || JSON.stringify(command.target) !== JSON.stringify(original.target)
      || JSON.stringify(command.operation) !== JSON.stringify(record.intent.descriptor.compensation)
      || found.data.sequence <= record.sequence) return result('unknown', 'OPERATION_COMPENSATION_BINDING');
    observed.compensation = Object.freeze({ commandId: command.commandId,
      digest: createHash('sha256').update(JSON.stringify(compensation)).digest('hex') });
    if (found.data.state === 'settled') return result('fail', 'OPERATION_EVIDENCE_COMPENSATED');
    return found.data.state !== 'refused' ? result('unknown', 'OPERATION_COMPENSATION_UNSETTLED') : undefined;
  };
  const bindingReason = operationEvidenceBindingReason(binding, record.intent.actor, record.evidence?.observedAt, { commandId, digest: recordDigest });
  if (bindingReason) {
    await compensationOutcome(); // Observation only: the binding verdict keeps precedence.
    return result(['OPERATION_EVIDENCE_CONTEXT', 'OPERATION_EVIDENCE_EARLIER'].includes(bindingReason) ? 'unknown' : 'fail', bindingReason);
  }
  if (record.state === 'refused') return result('fail', record.refusal!);
  if (record.state !== 'settled') return result('unknown', 'OPERATION_EVIDENCE_UNSETTLED');
  const compensated = await compensationOutcome();
  if (compensated) return compensated;
  return Object.freeze({ verdict: 'pass', effectEvidence: Object.freeze(observed), evidence: Object.freeze({ kind: 'operation-settlement', scopeId: context.scopeId, commandId,
    sequence: record.sequence, inputDigest: record.intent.inputDigest, digest: recordDigest }) });
}
/** Installed criteria consume authenticated Attempt context; the application remains the sole acceptance owner. */
export function createInstalledTerminalEvaluator(reader: OperationEvidenceReader) {
  return Object.freeze({
    async evaluate(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, terminal: Readonly<{ exitCode: number | null; signal?: string | undefined }>,
      context?: Readonly<{ identity: AttemptIdentity; binding?: OperationEvidenceBinding }>) {
      validateInstalledCriterion(evaluator, criterion);
      if (evaluator.implementation.id === PROCESS_EXIT_EVALUATOR.implementation.id) return processExitTerminalEvaluator.evaluate(evaluator, criterion, terminal);
      if (!context) return 'unknown' as const;
      const result = await evaluateOperationEvidence(reader, evaluator, criterion, context.identity, context.binding);
      return { verdict: result.verdict, evidenceTypes: result.verdict === 'pass' ? ['operation-settlement'] : [],
        evidenceReferences: result.verdict === 'pass' ? [{ id: result.evidence.commandId, digest: result.evidence.digest }] : [],
        ...(result.verdict === 'pass' ? {} : { reason: result.reason }), ...(result.effectEvidence ? { effectEvidence: result.effectEvidence } : {}) };
    },
    evaluateOperation(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, identity: AttemptIdentity, binding?: OperationEvidenceBinding) {
      return evaluateOperationEvidence(reader, evaluator, criterion, identity, binding);
    },
  });
}
