import type { ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema } from '#domain/index.js';
import { cancellationRecoveryCommandSchema, dispatchInventoryInputSchema, runAdmissionSchema, runCommandSchema, runQuerySchema,
  runReservationCommandSchema, taskEvaluationCommandSchema } from '#engine/index.js';
import type { RuntimeServiceOperation, RuntimeServiceRequest } from '#engine/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { createConfiguredRun, deliverConfiguredRunCancellation, evaluateConfiguredTask, inspectConfiguredRun,
  reconcileConfiguredAttempt, recoverConfiguredCancellations, requestConfiguredRunCancellation,
  reserveConfiguredRunTasks } from '#composition/core/runs/index.js';

/** Closed local composition map. Each operation revalidates untrusted protocol input before any I/O. */
export function createConfiguredRuntimeOperations(projectRoot: string, options: ConfigLoadOptions = {}) {
  return Object.freeze({
    createRun(input: Parameters<typeof createConfiguredRun>[1]) { return createConfiguredRun(projectRoot, input, options); },
    reserveRunTasks(input: Parameters<typeof reserveConfiguredRunTasks>[1]) { return reserveConfiguredRunTasks(projectRoot, input, options); },
    executeTask(input: Parameters<typeof executeConfiguredTask>[1]) { return executeConfiguredTask(projectRoot, input, options); },
    evaluateTask(input: Parameters<typeof evaluateConfiguredTask>[1]) { return evaluateConfiguredTask(projectRoot, input, options); },
    inspectRun(input: Parameters<typeof inspectConfiguredRun>[1]) { return inspectConfiguredRun(projectRoot, input, options); },
    inspectInventory(input: Parameters<typeof inspectConfiguredInventory>[1]) { return inspectConfiguredInventory(projectRoot, input, options); },
    requestRunCancellation(input: Parameters<typeof requestConfiguredRunCancellation>[1]) { return requestConfiguredRunCancellation(projectRoot, input, options); },
    deliverRunCancellation(input: Parameters<typeof deliverConfiguredRunCancellation>[1]) { return deliverConfiguredRunCancellation(projectRoot, input, options); },
    reconcileAttempt(input: Parameters<typeof reconcileConfiguredAttempt>[1]) { return reconcileConfiguredAttempt(projectRoot, input, options); },
    recoverCancellations(input: Parameters<typeof recoverConfiguredCancellations>[1]) { return recoverConfiguredCancellations(projectRoot, input, options); },
  });
}
export type ConfiguredRuntimeOperations = ReturnType<typeof createConfiguredRuntimeOperations>;

type RuntimeOperationHandler = (input: unknown) => Promise<unknown>;

/** Protocol dispatch only: policy, domain decisions, and error serialization remain with their owners. */
export async function executeConfiguredRuntimeOperation(projectRoot: string, request: RuntimeServiceRequest,
  options: ConfigLoadOptions = {}): Promise<unknown> {
  const operations = createConfiguredRuntimeOperations(projectRoot, options);
  const handlers = {
    createRun: input => operations.createRun(runAdmissionSchema.parse(input)),
    reserveRunTasks: input => operations.reserveRunTasks(runReservationCommandSchema.parse(input)),
    executeTask: input => operations.executeTask(attemptIdentitySchema.parse(input)),
    evaluateTask: input => operations.evaluateTask(taskEvaluationCommandSchema.parse(input)),
    inspectRun: input => operations.inspectRun(runQuerySchema.parse(input)),
    inspectInventory: input => operations.inspectInventory(dispatchInventoryInputSchema.parse(input)),
    requestRunCancellation: input => operations.requestRunCancellation(runCommandSchema.parse(input)),
    deliverRunCancellation: input => operations.deliverRunCancellation(runCommandSchema.parse(input)),
    reconcileAttempt: input => operations.reconcileAttempt(attemptIdentitySchema.parse(input)),
    recoverCancellations: input => operations.recoverCancellations(cancellationRecoveryCommandSchema.parse(input)),
  } satisfies Record<Exclude<RuntimeServiceOperation, 'describeService' | 'shutdownService' | 'invokeModel' | 'inspectModelInvocation'>, RuntimeOperationHandler>;
  if (!(request.operation in handlers)) throw new Error('RUNTIME_SERVICE_HOST_OPERATION');
  return handlers[request.operation as keyof typeof handlers](request.input);
}
