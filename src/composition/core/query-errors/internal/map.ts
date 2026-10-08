import { DecisionApplicationError, SessionAuthenticationError, WorkerObservationError, WorkspacePatchError, WorkspaceAdoptionError, patchLimitFields } from '#engine/index.js';
import { DecisionError, ApprovalError, AuditError, EffectError, ModelActivationError, ModelCatalogError, ModelInvocationError } from '#domain/index.js';
import { ProviderSpendError, ModelInvocationStoreError } from '#engine/index.js';
import { OpenAiChatHttpError, OpenRouterChatError, OpenRouterPricingError, NativeConnectionError } from '#adapters/index.js';
import { ModelActivationStoreError, AgentTurnStoreError, WorkerModelAdmissionError } from '#engine/index.js';
import { InstallationProfileError, InstallationEvidenceError, InstallationRecoveryError, InstallationPublicationError, InstallationIdentityError, ProjectIdentityError } from '#engine/index.js';
import { InstallationProfileFileError, InstallationArtifactError, DockerImageProbeError,
  InstallationJournalError, InstallationLedgerError, InstallationFileError } from '#adapters/index.js';
import { LocalRuntimeSocketError } from '#adapters/index.js';
import { RunError, TaskEvaluationError, TaskGraphError } from '#domain/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, ManagedFileError, BootstrapStateError } from '#platform/index.js';
import { HandoffError, RunLifecycleError, reservationDiagnosticParams, ServiceShutdownError, ReconciliationRecoveryError, ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvidenceError, ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError, ScopeRegistrationError, WorkTargetError } from '#engine/index.js';
const GRAPH_INPUT_CODES: ReadonlySet<string> = new Set(['TASK_GRAPH_INVALID', 'TASK_DUPLICATE', 'TASK_DEPENDENCY_DUPLICATE', 'TASK_DEPENDENCY_MISSING',
  'TASK_GRAPH_CYCLE', 'TASK_ACCEPTANCE_DUPLICATE', 'TASK_CRITERION_DEFINITION_MISSING', 'TASK_CRITERION_DEFINITION_UNUSED', 'TASK_CRITERION_DEFINITION_DUPLICATE']);
/** Preserve stable failure identities without exposing paths, database messages or query contents. */
export function queryFailure(error: unknown): DeckentError {
  if (error instanceof DecisionError || error instanceof DecisionApplicationError || error instanceof ApprovalError || error instanceof SessionAuthenticationError
    || error instanceof AuditError || error instanceof WorkerObservationError || error instanceof WorkspaceAdoptionError || error instanceof EffectError) return ErrorRegistry.createError(error.code);
  if (error instanceof WorkspacePatchError) return ErrorRegistry.createError(error.code, error.detail ? { params: { ...error.params, detail: error.detail, field: patchLimitFields[error.detail] } } : error.params ? { params: error.params } : {});
  if (error instanceof DeckentError) return error;
  if (error instanceof HandoffError) return ErrorRegistry.createError(error.code);
  if (error instanceof NativeConnectionError) return ErrorRegistry.createError(error.code);
  if (error instanceof ProviderSpendError) return ErrorRegistry.createError(error.code, error.nextAction ? { params: { nextAction: error.nextAction } } : {});
  if (error instanceof OpenRouterPricingError) return ErrorRegistry.createError(error.code === 'INVALID_REQUEST'
    ? 'MODEL_INVOCATION_INVALID' : 'PROVIDER_SPEND_UNAVAILABLE');
  if (error instanceof OpenRouterChatError) return ErrorRegistry.createError(error.code === 'INVALID_PROFILE'
    ? 'MODEL_INVOCATION_PROFILE_CONFLICT' : error.code === 'TARIFF_CONFLICT' ? 'PROVIDER_SPEND_CONFLICT' : 'MODEL_INVOCATION_INVALID');
  if (error instanceof ModelInvocationError || error instanceof ModelInvocationStoreError || error instanceof OpenAiChatHttpError) return ErrorRegistry.createError(error.code);
  if (error instanceof ModelActivationError || error instanceof ModelActivationStoreError || error instanceof ModelCatalogError) return ErrorRegistry.createError(error.code);
  if (error instanceof WorkerModelAdmissionError) { const d = error.detail; return ErrorRegistry.createError(error.code, { params: { taskId: d.taskId,
    channelId: d.channelId ?? '-', modelId: d.modelId ?? '-', minCliVersion: d.minCliVersion ?? '-', cliVersion: d.cliVersion ?? 'unparsed' } }); }
  if (error instanceof AgentTurnStoreError) return ErrorRegistry.createError(error.code);
  if (error instanceof InstallationProfileError || error instanceof InstallationProfileFileError || error instanceof InstallationEvidenceError
    || error instanceof InstallationArtifactError || error instanceof DockerImageProbeError || error instanceof InstallationRecoveryError
    || error instanceof InstallationPublicationError || error instanceof InstallationJournalError || error instanceof InstallationLedgerError
    || error instanceof InstallationFileError || error instanceof BootstrapStateError || error instanceof InstallationIdentityError || error instanceof ProjectIdentityError) return ErrorRegistry.createError(error.code);
  if (error instanceof RunWorkspaceCustodyError && error.reason === 'adapter-version-mismatch') {
    return ErrorRegistry.createError(error.code, { params: { reason: error.reason } });
  }
  if (error instanceof ManagedFileError && error.diagnostic) {
    const d = error.diagnostic;
    return ErrorRegistry.createError(error.code, { params: { resource: d.resource, companion: d.companion,
      stage: d.stage, reason: d.reason, mode: d.mode, links: d.links } });
  }
  if (error instanceof RuntimeServiceLifecycleError && error.retryAfterMs !== undefined) return ErrorRegistry.createError(error.code, { params: { retryAfterMs: error.retryAfterMs } });
  if (error instanceof ScopeRegistrationError) return ErrorRegistry.createError(error.code, { params: { scopeIds: error.scopeIds.join(',') } });
  // A structurally invalid submitted graph (cycle, missing/duplicate task or dependency, criterion mismatch) is the caller's input,
  // not an unavailable inventory; progress/revision codes stay internal (they describe stored state, never caller input).
  if (error instanceof TaskGraphError && GRAPH_INPUT_CODES.has(error.code)) return ErrorRegistry.createError('TASK_GRAPH_INVALID', {
    params: { reason: error.code, path: ['graph', ...(error.issues[0]?.path ?? [])].join('.') } });
  if (error instanceof ZodError) return ErrorRegistry.createError('INVENTORY_QUERY_INVALID');
  if (error instanceof DispatchInventoryError) return ErrorRegistry.createError('DISPATCH_INVENTORY_LIMIT');
  if (error instanceof RunStoreError && error.code === 'RUN_CAPACITY_OR_ORDER' && error.diagnostic) {
    return ErrorRegistry.createError(error.code, { params: reservationDiagnosticParams(error.diagnostic) });
  }
  if (error instanceof RunError || error instanceof RunLifecycleError || error instanceof ServiceShutdownError || error instanceof ReconciliationRecoveryError || error instanceof ReconciliationRuntimeLoopError || error instanceof CancellationRuntimeLoopError || error instanceof LocalRuntimeSocketError || error instanceof RuntimeServiceProtocolError || error instanceof RuntimeServiceLifecycleError || error instanceof RunWorkspaceCustodyError || error instanceof WorkspaceError || error instanceof CancellationDeliveryError || error instanceof TaskEvaluationError || error instanceof TaskEvidenceError || error instanceof EvaluationEvidenceError || error instanceof ExecutionRegistryError || error instanceof AuthenticationError || error instanceof AttemptStoreError || error instanceof DispatchError || error instanceof RunStoreError ||
    error instanceof ManagedFileError || error instanceof PolicyAuthorizationError || error instanceof WorkTargetError) return ErrorRegistry.createError(ErrorRegistry.has(error.code) ? error.code : 'INVENTORY_UNAVAILABLE');
  return ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
}
