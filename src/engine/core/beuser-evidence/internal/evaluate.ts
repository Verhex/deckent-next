import { sameAttemptIdentity } from '#domain/index.js';
import { assertBeuserAccess, BeuserContractError, type BeuserContext, type EvaluationPort } from '#engine/core/beuser-contract/index.js';
import type { TaskEvaluationApplication, TaskEvaluationCommand } from '#engine/core/task-evaluation/index.js';
/** Composition supplies the credential; the caller cannot submit a verdict or select another Attempt. */
export function createBeuserEvaluationPort(admitted: BeuserContext, application: TaskEvaluationApplication, credential: unknown): EvaluationPort {
  return Object.freeze({
    async evaluate(context: BeuserContext, command: TaskEvaluationCommand) {
      assertBeuserAccess(admitted, context.binding, context.principal, { kind: 'attempt', id: admitted.binding.identity.attemptId }, 'evaluate');
      context.signal.throwIfAborted();
      if (!sameAttemptIdentity(command.identity, admitted.binding.identity)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
      return application.execute(command, credential);
    },
  });
}
