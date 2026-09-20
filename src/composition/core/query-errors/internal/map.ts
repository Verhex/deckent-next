import { ModelActivationError } from '#domain/index.js';
import { ModelInvocationError } from '#domain/index.js';
import { ProviderSpendError, ModelInvocationStoreError } from '#engine/index.js';
import { OpenAiChatHttpError, OpenRouterChatError, OpenRouterPricingError } from '#adapters/index.js';
import { ModelActivationStoreError } from '#engine/index.js';
import { InstallationProfileError, InstallationEvidenceError, InstallationRecoveryError, InstallationPublicationError } from '#engine/index.js';
import { InstallationProfileFileError, InstallationArtifactError, DockerImageProbeError,
  InstallationJournalError, InstallationLedgerError, InstallationFileError } from '#adapters/index.js';
import { LocalRuntimeSocketError } from '#adapters/index.js';
import { TaskEvaluationError } from '#domain/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, ManagedFileError, BootstrapStateError } from '#platform/index.js';
import { ServiceShutdownError, ReconciliationRecoveryError, ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvidenceError, ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError } from '#engine/index.js';
/** Preserve stable failure identities without exposing paths, database messages or query contents. */
export function queryFailure(error: unknown): DeckentError {
  if (error instanceof DeckentError) return error;
  if (error instanceof ProviderSpendError) return ErrorRegistry.createError(error.code);
  if (error instanceof OpenRouterPricingError) return ErrorRegistry.createError(error.code === 'INVALID_REQUEST'
    ? 'MODEL_INVOCATION_INVALID' : 'PROVIDER_SPEND_UNAVAILABLE');
  if (error instanceof OpenRouterChatError) return ErrorRegistry.createError(error.code === 'INVALID_PROFILE'
    ? 'MODEL_INVOCATION_PROFILE_CONFLICT' : error.code === 'TARIFF_CONFLICT' ? 'PROVIDER_SPEND_CONFLICT' : 'MODEL_INVOCATION_INVALID');
  if (error instanceof ModelInvocationError || error instanceof ModelInvocationStoreError || error instanceof OpenAiChatHttpError) return ErrorRegistry.createError(error.code);
  if (error instanceof ModelActivationError || error instanceof ModelActivationStoreError) return ErrorRegistry.createError(error.code);
  if (error instanceof InstallationProfileError || error instanceof InstallationProfileFileError || error instanceof InstallationEvidenceError
    || error instanceof InstallationArtifactError || error instanceof DockerImageProbeError || error instanceof InstallationRecoveryError
    || error instanceof InstallationPublicationError || error instanceof InstallationJournalError || error instanceof InstallationLedgerError
    || error instanceof InstallationFileError || error instanceof BootstrapStateError) return ErrorRegistry.createError(error.code);
  if (error instanceof RunWorkspaceCustodyError && error.reason === 'adapter-version-mismatch') {
    return ErrorRegistry.createError(error.code, { params: { reason: error.reason } });
  }
  if (error instanceof ManagedFileError && error.diagnostic) {
    const d = error.diagnostic;
    return ErrorRegistry.createError(error.code, { params: { resource: d.resource, companion: d.companion,
      stage: d.stage, reason: d.reason, mode: d.mode, links: d.links } });
  }
  if (error instanceof ZodError) return ErrorRegistry.createError('INVENTORY_QUERY_INVALID');
  if (error instanceof DispatchInventoryError) return ErrorRegistry.createError('DISPATCH_INVENTORY_LIMIT');
  if (error instanceof RunStoreError && error.code === 'RUN_CAPACITY_OR_ORDER' && error.diagnostic) {
    const diagnostic = error.diagnostic;
    return ErrorRegistry.createError(error.code, { params: {
      site: diagnostic.site, reason: diagnostic.reason, now: diagnostic.now,
      ...(diagnostic.eligibilityGapMs === undefined ? {} : { eligibilityGapMs: diagnostic.eligibilityGapMs }),
      executionSlots: diagnostic.executionSlots, inFlightSlots: diagnostic.inFlightSlots,
      executionOccupied: diagnostic.executionOccupied, inFlightOccupied: diagnostic.inFlightOccupied,
      selectedCount: diagnostic.selectedCount, requestedCount: diagnostic.requestedCount,
      readyCount: diagnostic.readyCount, waitingCount: diagnostic.waitingCount, blockedCount: diagnostic.blockedCount,
      delayedCount: diagnostic.delayedCount, occupiedCount: diagnostic.occupiedCount,
      terminalCount: diagnostic.terminalCount, reconciliationCount: diagnostic.reconciliationCount,
    } });
  }
  if (error instanceof ServiceShutdownError || error instanceof ReconciliationRecoveryError || error instanceof ReconciliationRuntimeLoopError || error instanceof CancellationRuntimeLoopError || error instanceof LocalRuntimeSocketError || error instanceof RuntimeServiceProtocolError || error instanceof RuntimeServiceLifecycleError || error instanceof RunWorkspaceCustodyError || error instanceof WorkspaceError || error instanceof CancellationDeliveryError || error instanceof TaskEvaluationError || error instanceof TaskEvidenceError || error instanceof EvaluationEvidenceError || error instanceof ExecutionRegistryError || error instanceof AuthenticationError || error instanceof AttemptStoreError || error instanceof DispatchError || error instanceof RunStoreError ||
    error instanceof ManagedFileError || error instanceof PolicyAuthorizationError) return ErrorRegistry.createError(ErrorRegistry.has(error.code) ? error.code : 'INVENTORY_UNAVAILABLE');
  return ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
}
