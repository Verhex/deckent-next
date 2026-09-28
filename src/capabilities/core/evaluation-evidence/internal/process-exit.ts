import { z } from 'zod';
import { criterionDefinitionSchema, evaluatorDefinitionSchema, processExitCauseSchema, type CriterionDefinition, type EvaluatorDefinition } from '#domain/index.js';

export const PROCESS_EXIT_EVALUATOR = Object.freeze({ id: 'process-exit', version: 1,
  implementation: Object.freeze({ id: 'process-exit', version: 1 }) });
const parametersSchema = z.object({
  acceptedExitCodes: z.array(z.number().int().safe()).min(1).refine(values => new Set(values).size === values.length, 'PROCESS_EXIT_CODES_DUPLICATE'),
}).strict().readonly();
export type ProcessExitParameters = z.infer<typeof parametersSchema>;

/** Installation checks implementation availability without inventing a task criterion. */
export function validateInstalledProcessExitEvaluator(evaluator: EvaluatorDefinition): undefined {
  const installed = evaluatorDefinitionSchema.parse(evaluator);
  if (installed.implementation.id !== PROCESS_EXIT_EVALUATOR.implementation.id
    || installed.implementation.version !== PROCESS_EXIT_EVALUATOR.implementation.version) {
    throw new Error('PROCESS_EXIT_EVALUATOR_MISMATCH');
  }
  return undefined;
}

/** Validate the installed evaluator and its criterion parameters before admission.
 * The caller must verify dispatch, terminal and artifact authority separately. */
export function validateProcessExitCriterion(evaluator: EvaluatorDefinition, criterion: CriterionDefinition): undefined {
  validateInstalledProcessExitEvaluator(evaluator);
  const installed = evaluatorDefinitionSchema.parse(evaluator);
  const definition = criterionDefinitionSchema.parse(criterion);
  if (definition.evaluator.id !== installed.id || definition.evaluator.version !== installed.version) {
    throw new Error('PROCESS_EXIT_EVALUATOR_MISMATCH');
  }
  parametersSchema.parse(definition.parameters);
  return undefined;
}

/** Pure process-exit result. It consumes only already validated terminal evidence;
 * it does not read artifacts, infer intent or mutate Run/Task state. */
export function evaluateProcessExit(parameters: unknown, terminalEvidence: unknown): 'pass' | 'fail' {
  const { acceptedExitCodes } = parametersSchema.parse(parameters);
  const terminal = processExitCauseSchema.parse(terminalEvidence);
  return terminal.signal === undefined && terminal.exitCode !== null && acceptedExitCodes.includes(terminal.exitCode) ? 'pass' : 'fail';
}

/** "Not weaker" for process-exit: a criterion accepting only exit codes the required bar accepts never passes a process the bar fails. */
export function processExitWithin(required: unknown, actual: unknown): boolean {
  const bar = parametersSchema.safeParse(required), criterion = parametersSchema.safeParse(actual);
  return bar.success && criterion.success && criterion.data.acceptedExitCodes.every(code => bar.data.acceptedExitCodes.includes(code));
}
/** Per-implementation strictness rule used by the adoption verification bar (B06-2c). An implementation without a rule never
 * satisfies a bar (fail-closed); other evaluators add their own rule here under their implementation identity. */
export function criterionWithin(implementation: Readonly<{ id: string; version: number }>, required: unknown, actual: unknown): boolean {
  return implementation.id === PROCESS_EXIT_EVALUATOR.implementation.id && implementation.version === PROCESS_EXIT_EVALUATOR.implementation.version
    && processExitWithin(required, actual);
}
