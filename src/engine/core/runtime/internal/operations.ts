import { attemptIdentitySchema } from '#domain/index.js';
import { dispatchInventoryInputSchema } from '#engine/core/dispatch/index.js';
import { cancellationRecoveryCommandSchema, runAdmissionSchema, runCommandSchema, runQuerySchema, parseRunProposal, runProposalQuerySchema, runReservationCommandSchema } from '#engine/core/runs/index.js';
import { taskEvaluationCommandSchema } from '#engine/core/task-evaluation/index.js';
import type { RuntimeServiceOperation, RuntimeServiceRequest } from './service-protocol.js';
export interface RuntimeOperations {
  proposeRun(input: ReturnType<typeof parseRunProposal>): Promise<unknown>;
  inspectRunProposal(input: ReturnType<typeof runProposalQuerySchema.parse>): Promise<unknown>;
  createRun(input: ReturnType<typeof runAdmissionSchema.parse>): Promise<unknown>;
  reserveRunTasks(input: ReturnType<typeof runReservationCommandSchema.parse>): Promise<unknown>;
  executeTask(input: ReturnType<typeof attemptIdentitySchema.parse>): Promise<unknown>;
  evaluateTask(input: ReturnType<typeof taskEvaluationCommandSchema.parse>): Promise<unknown>;
  inspectRun(input: ReturnType<typeof runQuerySchema.parse>): Promise<unknown>;
  inspectInventory(input: ReturnType<typeof dispatchInventoryInputSchema.parse>): Promise<unknown>;
  requestRunCancellation(input: ReturnType<typeof runCommandSchema.parse>): Promise<unknown>;
  deliverRunCancellation(input: ReturnType<typeof runCommandSchema.parse>): Promise<unknown>;
  reconcileAttempt(input: ReturnType<typeof attemptIdentitySchema.parse>): Promise<unknown>;
  recoverCancellations(input: ReturnType<typeof cancellationRecoveryCommandSchema.parse>): Promise<unknown>;
}
type RuntimeOperationHandler = (input: unknown) => Promise<unknown>;
/** Closed protocol dispatch; configured handlers retain I/O and application authority. */
export async function executeRuntimeOperation(operations: RuntimeOperations, request: RuntimeServiceRequest): Promise<unknown> {
  const handlers = {
    proposeRun: input => operations.proposeRun(parseRunProposal(input)),
    inspectRunProposal: input => operations.inspectRunProposal(runProposalQuerySchema.parse(input)),
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
  } satisfies Record<Exclude<RuntimeServiceOperation, 'subscribeEvents' | 'clearSessionStanding' | 'renewApproval' | 'listApprovals' | 'inspectApproval' | 'decideApproval' | 'describeService' | 'shutdownService' | 'invokeModel' | 'invokeModelStream' | 'inspectModelInvocation'
    | 'purgeModelInvocationContent' | 'cancelModelInvocation' | 'inspectProviderSpendAccount' | 'auditProviderSpendAccount' | 'manageProviderSpend' | 'chatTurn' | 'cancelChatTurn'
    | 'findWorkspaceFiles' | 'attachWorkspaceFile' | 'executeOperation' | 'compensateOperation' | 'inspectOperation' | 'inspectPermissionMode' | 'setPermissionMode'
    | 'inspectScratch' | 'clearScratch' | 'setSecret' | 'deleteSecret' | 'switchSecretStore'>, RuntimeOperationHandler>;
  if (!(request.operation in handlers)) throw new Error('RUNTIME_SERVICE_HOST_OPERATION');
  return handlers[request.operation as keyof typeof handlers](request.input);
}
