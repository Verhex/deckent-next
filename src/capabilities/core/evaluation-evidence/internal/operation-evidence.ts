import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, criterionDefinitionSchema, evaluatorDefinitionSchema, identitySchema,
  type AttemptIdentity, type CriterionDefinition, type EvaluatorDefinition } from '#domain/index.js';
import { PROCESS_EXIT_EVALUATOR, processExitTerminalEvaluator, validateInstalledProcessExitEvaluator, validateProcessExitCriterion } from './process-exit.js';

export const OPERATION_EVIDENCE_EVALUATOR = Object.freeze({ id: 'operation-evidence', version: 1,
  implementation: Object.freeze({ id: 'operation-evidence', version: 1 }) });
const parametersSchema = z.object({ commandId: identitySchema }).strict().readonly();
/** Structurally compatible with the existing effect store's read method. The reader owns canonical record validation;
 * this capability checks only its consumed projection, never replaces the effect contract or writes a settlement. */
export interface OperationEvidenceReader { loadEffect(scopeId: string, commandId: string): Promise<unknown> }
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const projectionSchema = z.object({ sequence: counterSchema.positive(), state: z.enum(['settled', 'claimed', 'unknown', 'held', 'refused', 'compensated']),
  intent: z.object({ command: z.object({ scopeId: identitySchema, commandId: identitySchema }), inputDigest: digest }),
  evidence: z.object({ kind: z.enum(['idempotency-record', 'fence']), version: z.string().min(1).max(256).nullable(), observedAt: counterSchema }).strict().nullable(),
  refusal: z.enum(['EFFECT_PRECONDITION_CHANGED', 'EFFECT_REJECTED']).nullable(),
}).refine(record => (record.state === 'settled') === (record.evidence !== null) && (record.state === 'refused') === (record.refusal !== null));
export type OperationSettlementReference = Readonly<{ kind: 'operation-settlement'; scopeId: string; commandId: string;
  sequence: number; inputDigest: string; digest: string }>;
export type OperationEvidenceResult = Readonly<{ verdict: 'pass'; evidence: OperationSettlementReference }>
  | Readonly<{ verdict: 'unknown' | 'fail'; reason: string }>;

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
 * A reference hashes the complete reader-validated record; D1 must retain and verify it before canonical acceptance. */
export async function evaluateOperationEvidence(reader: OperationEvidenceReader, evaluator: EvaluatorDefinition,
  criterion: CriterionDefinition, identity: AttemptIdentity): Promise<OperationEvidenceResult> {
  validateInstalledCriterion(evaluator, criterion);
  if (evaluator.implementation.id !== OPERATION_EVIDENCE_EVALUATOR.implementation.id) throw new Error('TASK_EVALUATOR_INVALID');
  const context = attemptIdentitySchema.parse(identity), { commandId } = parametersSchema.parse(criterion.parameters);
  let input: unknown;
  try { input = await reader.loadEffect(context.scopeId, commandId); }
  catch { return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_UNAVAILABLE' }); }
  if (input === null) return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_MISSING' });
  const parsed = projectionSchema.safeParse(input);
  if (!parsed.success) return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' });
  const record = parsed.data;
  if (record.intent.command.scopeId !== context.scopeId || record.intent.command.commandId !== commandId) {
    return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_BINDING' });
  }
  if (record.state === 'refused') return Object.freeze({ verdict: 'fail', reason: record.refusal! });
  if (record.state === 'compensated') return Object.freeze({ verdict: 'fail', reason: 'OPERATION_EVIDENCE_COMPENSATED' });
  if (record.state !== 'settled') return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_UNSETTLED' });
  let recordDigest: string;
  try { recordDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
  catch { return Object.freeze({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' }); }
  return Object.freeze({ verdict: 'pass', evidence: Object.freeze({ kind: 'operation-settlement', scopeId: context.scopeId, commandId,
    sequence: record.sequence, inputDigest: record.intent.inputDigest, digest: recordDigest }) });
}
/** Compatibility boundary until D1 binds authenticated Attempt context and structured evidence to its single evaluation owner.
 * The current terminal-only port can never pass an operation criterion from exit 0. */
export function createInstalledTerminalEvaluator(reader: OperationEvidenceReader) {
  return Object.freeze({
    async evaluate(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, terminal: Readonly<{ exitCode: number | null; signal?: string | undefined }>): Promise<'pass' | 'fail' | 'unknown'> {
      validateInstalledCriterion(evaluator, criterion);
      return evaluator.implementation.id === PROCESS_EXIT_EVALUATOR.implementation.id
        ? processExitTerminalEvaluator.evaluate(evaluator, criterion, terminal) : 'unknown';
    },
    evaluateOperation(evaluator: EvaluatorDefinition, criterion: CriterionDefinition, identity: AttemptIdentity) {
      return evaluateOperationEvidence(reader, evaluator, criterion, identity);
    },
  });
}
