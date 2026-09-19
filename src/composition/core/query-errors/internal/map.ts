import { LocalRuntimeSocketError } from '#adapters/index.js';
import { TaskEvaluationError } from '#domain/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, ManagedFileError } from '#platform/index.js';
import { ReconciliationRecoveryError, ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvidenceError, ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError } from '#engine/index.js';
/** Preserve stable failure identities without exposing paths, database messages or query contents. */
export function queryFailure(error: unknown): DeckentError {
  if (error instanceof DeckentError) return error;
  if (error instanceof ZodError) return ErrorRegistry.createError('INVENTORY_QUERY_INVALID');
  if (error instanceof DispatchInventoryError) return ErrorRegistry.createError('DISPATCH_INVENTORY_LIMIT');
  if (error instanceof RunStoreError && error.code === 'RUN_CAPACITY_OR_ORDER' && error.diagnostic) {
    const diagnostic = error.diagnostic;
    return ErrorRegistry.createError(error.code, { params: {
      site: diagnostic.site, reason: diagnostic.reason, now: diagnostic.now,
      executionSlots: diagnostic.executionSlots, inFlightSlots: diagnostic.inFlightSlots,
      executionOccupied: diagnostic.executionOccupied, inFlightOccupied: diagnostic.inFlightOccupied,
      selectedCount: diagnostic.selectedCount, requestedCount: diagnostic.requestedCount,
      readyCount: diagnostic.readyCount, waitingCount: diagnostic.waitingCount, blockedCount: diagnostic.blockedCount,
      delayedCount: diagnostic.delayedCount, occupiedCount: diagnostic.occupiedCount,
      terminalCount: diagnostic.terminalCount, reconciliationCount: diagnostic.reconciliationCount,
    } });
  }
  if (error instanceof ReconciliationRecoveryError || error instanceof ReconciliationRuntimeLoopError || error instanceof CancellationRuntimeLoopError || error instanceof LocalRuntimeSocketError || error instanceof RuntimeServiceProtocolError || error instanceof RuntimeServiceLifecycleError || error instanceof RunWorkspaceCustodyError || error instanceof WorkspaceError || error instanceof CancellationDeliveryError || error instanceof TaskEvaluationError || error instanceof TaskEvidenceError || error instanceof EvaluationEvidenceError || error instanceof ExecutionRegistryError || error instanceof AuthenticationError || error instanceof AttemptStoreError || error instanceof DispatchError || error instanceof RunStoreError ||
    error instanceof ManagedFileError || error instanceof PolicyAuthorizationError) return ErrorRegistry.createError(ErrorRegistry.has(error.code) ? error.code : 'INVENTORY_UNAVAILABLE');
  return ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
}
