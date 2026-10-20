import type { ConfigLoadOptions } from '#platform/index.js';
import { attemptIdentitySchema } from '#domain/index.js';
import { dispatchInventoryInputSchema } from '#engine/core/dispatch/index.js';
import { cancellationRecoveryCommandSchema, runAdmissionSchema, runCommandSchema, runQuerySchema, runReservationCommandSchema } from '#engine/core/runs/index.js';
import { parseRunProposal, runProposalQuerySchema } from '#engine/core/run-proposal/index.js';
import { taskEvaluationCommandSchema } from '#engine/core/task-evaluation/index.js';
import type { RuntimeServiceOperation, RuntimeServiceRequest } from './service-protocol.js';
import type { z } from 'zod';
const schemas = { proposeRun: runAdmissionSchema, inspectRunProposal: runProposalQuerySchema, createRun: runAdmissionSchema,
  reserveRunTasks: runReservationCommandSchema, executeTask: attemptIdentitySchema, evaluateTask: taskEvaluationCommandSchema,
  inspectRun: runQuerySchema, inspectInventory: dispatchInventoryInputSchema, requestRunCancellation: runCommandSchema, deliverRunCancellation: runCommandSchema,
  reconcileAttempt: attemptIdentitySchema, recoverCancellations: cancellationRecoveryCommandSchema };
// Proposal parsing has its own bounded schema and strict payload implementation.
import type { RunProposal } from '#domain/index.js';
type RuntimeRunApplications = { [K in keyof typeof schemas]: (input: K extends 'proposeRun' ? RunProposal : z.infer<typeof schemas[K]>) => Promise<unknown> };
type RuntimeOperationHandler = (input: unknown) => Promise<unknown>;
export async function executeRuntimeApplicationOperation(operations: RuntimeRunApplications, request: RuntimeServiceRequest): Promise<unknown> {
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
  } satisfies Record<Exclude<RuntimeServiceOperation, 'clearSessionStanding' | 'renewApproval' | 'listApprovals' | 'inspectApproval' | 'decideApproval' | 'describeService' | 'shutdownService' | 'invokeModel' | 'invokeModelStream' | 'inspectModelInvocation'
    | 'purgeModelInvocationContent' | 'cancelModelInvocation' | 'inspectProviderSpendAccount' | 'auditProviderSpendAccount' | 'manageProviderSpend' | 'chatTurn' | 'cancelChatTurn'
    | 'findWorkspaceFiles' | 'attachWorkspaceFile' | 'executeOperation' | 'compensateOperation' | 'inspectOperation' | 'inspectPermissionMode' | 'setPermissionMode'
    | 'inspectScratch' | 'clearScratch' | 'setSecret' | 'deleteSecret' | 'switchSecretStore' | 'enqueueTargetQueueRollback' | 'enqueueTargetQueue' | 'inspectTargetQueue' | 'listTargetQueue' | 'challengeTargetQueue' | 'answerTargetQueue' | 'executeTargetQueue'>, RuntimeOperationHandler>;
  if (!(request.operation in handlers)) throw new Error('RUNTIME_SERVICE_HOST_OPERATION');
  return handlers[request.operation as keyof typeof handlers](request.input);
}

/** Bind trusted host context to typed application producers once; commands cannot select root/configuration. */
export function bindRuntimeApplicationMethods<Ports extends Record<string, (root: string, input: never, options: ConfigLoadOptions) => unknown>>(root: string, options: ConfigLoadOptions, ports: Ports) {
  return Object.fromEntries(Object.entries(ports).map(([key, port]) => [key, (input: never) => port(root, input, options)])) as {
    [K in keyof Ports]: (input: Parameters<Ports[K]>[1]) => ReturnType<Ports[K]>;
  };
}
