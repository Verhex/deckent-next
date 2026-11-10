import { NativeCliWorkerError } from '#adapters/index.js';
import { BeuserContractError, BeuserTransferError, AuthorityChangeError, AgentCatalogStoreError, DecisionApplicationError, MemoryJournalError, SessionAuthenticationError, WorkerObservationError, WorkspacePatchError, WorkspaceAdoptionError, patchLimitFields } from '#engine/index.js';
import { TargetQueueError, CandidateBindingError, DecisionDelegationError, PolicyChangeError, PolicyLastAdminError, CommandIdError, DecisionError, MemoryError, AgentCatalogError, ApprovalError, AuditError, EffectError, ModelActivationError, ModelCatalogError, ModelInvocationError, ModelRoleError, CatalogEvolutionError } from '#domain/index.js';
import { ProviderSpendError, ModelInvocationStoreError, NervousError, type ProviderSpendAccount } from '#engine/index.js';
import { BeuserSurfaceError, OpenAiChatHttpError, OpenRouterChatError, OpenRouterPricingError, NativeConnectionError, LocalRuntimeSocketError } from '#adapters/index.js';
import { ModelActivationStoreError, AgentTurnStoreError, WorkerModelAdmissionError } from '#engine/index.js';
import { ProjectAttachmentError, UninstallError, InstallationProfileError, InstallationEvidenceError, InstallationRecoveryError, InstallationPublicationError, InstallationIdentityError, ProjectIdentityError } from '#engine/index.js';
import { InstallationProfileFileError, InstallationArtifactError, DockerImageProbeError,
  InstallationJournalError, InstallationLedgerError, InstallationFileError } from '#adapters/index.js';
import { RunError, TaskEvaluationError, TaskGraphError, WorkClassRegistryError, WorkerEffortError } from '#domain/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, unexpectedQueryFailure, sanitizeQueryFailure, ManagedFileError, BootstrapStateError, terminalSafeText, isCodedError } from '#platform/index.js';
import { HandoffError, SupervisorError, RunProgressionFailure, RunLifecycleError, reservationDiagnosticParams, ServiceShutdownError, ReconciliationRecoveryError, ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvidenceError, ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError, ScopeRegistrationError, WorkTargetError } from '#engine/index.js';
// A36: a coded-error brand does not grant client disclosure; only the existing mapper classes opt in.
const QUERY_FAILURE_TYPES = [
  NativeCliWorkerError, ProjectAttachmentError, BeuserContractError, BeuserTransferError, BeuserSurfaceError, HandoffError, NativeConnectionError,
  ModelInvocationError, OpenAiChatHttpError, ModelActivationError, ModelActivationStoreError, ModelRoleError, AgentTurnStoreError,
  UninstallError, InstallationProfileError, InstallationProfileFileError, InstallationEvidenceError, InstallationArtifactError, DockerImageProbeError,
  InstallationRecoveryError, InstallationPublicationError, InstallationJournalError, InstallationLedgerError, BootstrapStateError,
  InstallationIdentityError, ProjectIdentityError, SupervisorError, RunError, RunLifecycleError, ServiceShutdownError, ReconciliationRecoveryError,
  ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, LocalRuntimeSocketError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError,
  RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvaluationError, TaskEvidenceError, EvaluationEvidenceError,
  ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, RunStoreError, WorkClassRegistryError, WorkerEffortError,
  ManagedFileError, PolicyAuthorizationError, WorkTargetError, AuthorityChangeError, PolicyChangeError, DecisionDelegationError, PolicyLastAdminError,
  CommandIdError, DecisionError, DecisionApplicationError, MemoryJournalError, MemoryError, AgentCatalogStoreError, AgentCatalogError, ApprovalError,
  SessionAuthenticationError, CandidateBindingError, AuditError, WorkerObservationError, WorkspaceAdoptionError, EffectError,
  NervousError, CatalogEvolutionError
] as const;
const isQueryFailure = (error: unknown): error is InstanceType<(typeof QUERY_FAILURE_TYPES)[number]> => QUERY_FAILURE_TYPES.some(Type => error instanceof Type);
const GRAPH_INPUT_CODES: ReadonlySet<string> = new Set(['TASK_GRAPH_INVALID', 'TASK_DUPLICATE', 'TASK_DEPENDENCY_DUPLICATE', 'TASK_DEPENDENCY_MISSING',
  'TASK_GRAPH_CYCLE', 'TASK_ACCEPTANCE_DUPLICATE', 'TASK_CRITERION_DEFINITION_MISSING', 'TASK_CRITERION_DEFINITION_UNUSED', 'TASK_CRITERION_DEFINITION_DUPLICATE']);
const registeredFailure = (code: string, options?: Parameters<typeof ErrorRegistry.createError>[1]) => ErrorRegistry.has(code)
  ? ErrorRegistry.createError(code, options) : ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
const delegationRefusalParams = (facts: NonNullable<AuthorityChangeError['refusal']>) => ({ kind: facts.cell.kind, action: facts.cell.action, target: facts.cell.id,
  scope: facts.cell.scope, reason: facts.reason, hint: facts.reason === 'deny' ? 'deny' : facts.reason !== 'no-grant' ? 'approval' : facts.sole ? 'owner' : facts.people.length ? 'other' : 'unnamed',
  people: facts.people.map(person => terminalSafeText(`${person.issuer}/${person.subject}`)).join(', ') });
/** Preserve stable failures without private details; account totals require a freshly policy-authorized account from the caller. */
export function queryFailure(error: unknown, inspectedAccount?: ProviderSpendAccount): DeckentError {
  // alpha.56 U5-S1: the bound's refusal names the cell it stopped at and a hint chosen from display facts (never a decision input).
  if (error instanceof AuthorityChangeError && error.refusal) return registeredFailure(error.code, { params: delegationRefusalParams(error.refusal) });
  if (error instanceof WorkspacePatchError) return registeredFailure(error.code, error.detail ? { params: { ...error.params, detail: error.detail, field: patchLimitFields[error.detail] } } : error.params ? { params: error.params } : {});
  if (error instanceof RunLifecycleError && error.approvalId) return registeredFailure(error.code, { params: { approvalId: error.approvalId } });
  if (error instanceof RunProgressionFailure) return queryFailure(error.cause);
  if (error instanceof DeckentError) return error.code === 'QUERY_UNEXPECTED_FAILURE' ? sanitizeQueryFailure(error) : ErrorRegistry.has(error.code) ? error : registeredFailure(error.code);
  if (error instanceof ProviderSpendError) return registeredFailure(error.code === 'PROVIDER_SPEND_DATA_POLICY_REFUSED' ? 'OPENROUTER_PRIVACY_UNAVAILABLE' : error.code, { params: {
    ...(error.amounts ? { requested: error.amounts.requested, currency: error.amounts.currency } : {}),
    ...(error.amounts && inspectedAccount?.budget.currency === error.amounts.currency ? { settled: inspectedAccount.settledExactMinorUnits,
      held: inspectedAccount.reservedMinorUnits, requested: error.amounts.requested, limit: inspectedAccount.budget.limitMinorUnits, currency: inspectedAccount.budget.currency } : {}),
    ...(error.nextAction ? { nextAction: error.nextAction } : {}) } });
  if (error instanceof OpenRouterPricingError) return registeredFailure(error.code === 'INVALID_REQUEST'
    ? 'MODEL_INVOCATION_INVALID' : error.code === 'PRIVACY_UNAVAILABLE' ? 'OPENROUTER_PRIVACY_UNAVAILABLE' : 'PROVIDER_SPEND_UNAVAILABLE');
  if (error instanceof OpenRouterChatError) return registeredFailure(error.code === 'INVALID_PROFILE'
    ? 'MODEL_INVOCATION_PROFILE_CONFLICT' : error.code === 'TARIFF_CONFLICT' ? 'PROVIDER_SPEND_CONFLICT' : 'MODEL_INVOCATION_INVALID');
  if (error instanceof TargetQueueError || error instanceof InstallationFileError || error instanceof ModelCatalogError || error instanceof ModelInvocationStoreError) {
    const params = error instanceof ModelInvocationStoreError && error.code !== 'MODEL_NOT_ACTIVATED' ? undefined : error.params;
    return registeredFailure(error.code, params ? { params } : undefined);
  }
  if (error instanceof ModelActivationStoreError && error.deliveryFinding) return registeredFailure(error.code, { params: {
    profile: error.deliveryFinding.profileId, surface: error.deliveryFinding.surface,
    required: error.deliveryFinding.requiredBytes, available: error.deliveryFinding.availableBytes } });
  if (error instanceof WorkerModelAdmissionError) { const d = error.detail; return registeredFailure(error.code, { params: { taskId: d.taskId,
    channelId: d.channelId ?? '-', modelId: d.modelId ?? '-', minCliVersion: d.minCliVersion ?? '-', cliVersion: d.cliVersion ?? 'unparsed',
    ...(d.workClass !== undefined ? { workClass: d.workClass, skipped: d.skipped ?? '-', ...(d.skippedMore ? { skippedMore: d.skippedMore } : {}) } : {}) } }); }
  // E1: the bounded cause of an unavailable image probe (deadline|exit|signal|parse) travels as a param; Docker's text never does.
  if (error instanceof DockerImageProbeError && error.probeCause) return registeredFailure(error.code, { params: { cause: error.probeCause } });
  if (error instanceof RunWorkspaceCustodyError && error.reason === 'adapter-version-mismatch') return registeredFailure(error.code, { params: { reason: error.reason } });
  if (error instanceof ManagedFileError && error.diagnostic) {
    const d = error.diagnostic;
    return registeredFailure(error.code, { params: { resource: d.resource, companion: d.companion,
      stage: d.stage, reason: d.reason, mode: d.mode, links: d.links } });
  }
  if (error instanceof RuntimeServiceLifecycleError && error.retryAfterMs !== undefined) return registeredFailure(error.code, { params: { retryAfterMs: error.retryAfterMs } });
  if (error instanceof ScopeRegistrationError) return registeredFailure(error.code, { params: { scopeIds: error.scopeIds.join(',') } });
  if (error instanceof TaskGraphError && GRAPH_INPUT_CODES.has(error.code)) return registeredFailure('TASK_GRAPH_INVALID', {
    params: { reason: error.code, path: ['graph', ...(error.issues[0]?.path ?? [])].join('.') } });
  if (error instanceof LocalRuntimeSocketError && (error.path || error.reason)) return registeredFailure(error.code, { params: { ...(error.path ? { path: error.path } : {}), ...(error.reason ? { reason: error.reason } : {}) } });
  if (error instanceof ZodError) return registeredFailure('INVENTORY_QUERY_INVALID');
  if (error instanceof DispatchInventoryError) return registeredFailure('DISPATCH_INVENTORY_LIMIT');
  if (error instanceof RunStoreError && error.code === 'RUN_CAPACITY_OR_ORDER' && error.diagnostic) return registeredFailure(error.code, { params: reservationDiagnosticParams(error.diagnostic) });
  if (isQueryFailure(error) && isCodedError(error, error.code)) return registeredFailure(error.code);
  return unexpectedQueryFailure(error);
}
