import { AuthorityChangeError, AgentCatalogStoreError, DecisionApplicationError, MemoryJournalError, SessionAuthenticationError, WorkerObservationError, WorkspacePatchError, WorkspaceAdoptionError, patchLimitFields } from '#engine/index.js';
import { TargetQueueError, CandidateBindingError, DecisionDelegationError, PolicyChangeError, PolicyLastAdminError, CommandIdError, DecisionError, MemoryError, AgentCatalogError, ApprovalError, AuditError, EffectError, ModelActivationError, ModelCatalogError, ModelInvocationError, ModelRoleError, CatalogEvolutionError } from '#domain/index.js';
import { ProviderSpendError, ModelInvocationStoreError, NervousError, type ProviderSpendAccount } from '#engine/index.js';
import { OpenAiChatHttpError, OpenRouterChatError, OpenRouterPricingError, NativeConnectionError } from '#adapters/index.js';
import { ModelActivationStoreError, AgentTurnStoreError, WorkerModelAdmissionError } from '#engine/index.js';
import { UninstallError, InstallationProfileError, InstallationEvidenceError, InstallationRecoveryError, InstallationPublicationError, InstallationIdentityError, ProjectIdentityError } from '#engine/index.js';
import { InstallationProfileFileError, InstallationArtifactError, DockerImageProbeError,
  InstallationJournalError, InstallationLedgerError, InstallationFileError } from '#adapters/index.js';
import { LocalRuntimeSocketError } from '#adapters/index.js';
import { RunError, TaskEvaluationError, TaskGraphError, WorkClassRegistryError, WorkerEffortError } from '#domain/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
import { ZodError } from 'zod';
import { DeckentError, ErrorRegistry, unexpectedQueryFailure, sanitizeQueryFailure, ManagedFileError, BootstrapStateError, terminalSafeText } from '#platform/index.js';
import { HandoffError, SupervisorError, RunProgressionFailure, RunLifecycleError, reservationDiagnosticParams, ServiceShutdownError, ReconciliationRecoveryError, ReconciliationRuntimeLoopError, CancellationRuntimeLoopError, RuntimeServiceProtocolError, RuntimeServiceLifecycleError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, TaskEvidenceError, ExecutionRegistryError, AuthenticationError, AttemptStoreError, DispatchError, DispatchInventoryError, PolicyAuthorizationError, RunStoreError, ScopeRegistrationError, WorkTargetError } from '#engine/index.js';
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
  if (error instanceof AuthorityChangeError || error instanceof PolicyChangeError || error instanceof DecisionDelegationError || error instanceof PolicyLastAdminError || error instanceof CommandIdError || error instanceof DecisionError || error instanceof DecisionApplicationError || error instanceof MemoryJournalError || error instanceof MemoryError || error instanceof AgentCatalogStoreError || error instanceof AgentCatalogError || error instanceof ApprovalError || error instanceof SessionAuthenticationError
    || error instanceof TargetQueueError || error instanceof CandidateBindingError || error instanceof AuditError || error instanceof WorkerObservationError || error instanceof WorkspaceAdoptionError || error instanceof EffectError || error instanceof NervousError || error instanceof CatalogEvolutionError) return registeredFailure(error.code);
  if (error instanceof WorkspacePatchError) return registeredFailure(error.code, error.detail ? { params: { ...error.params, detail: error.detail, field: patchLimitFields[error.detail] } } : error.params ? { params: error.params } : {});
  if (error instanceof RunLifecycleError && error.approvalId) return registeredFailure(error.code, { params: { approvalId: error.approvalId } });
  if (error instanceof RunProgressionFailure) return queryFailure(error.cause);
  if (error instanceof DeckentError) return error.code === 'QUERY_UNEXPECTED_FAILURE' ? sanitizeQueryFailure(error) : ErrorRegistry.has(error.code) ? error : registeredFailure(error.code);
  if (error instanceof InstallationFileError) return registeredFailure(error.code, { params: error.params });
  if (error instanceof HandoffError || error instanceof NativeConnectionError) return registeredFailure(error.code);
  if (error instanceof ProviderSpendError) return registeredFailure(error.code === 'PROVIDER_SPEND_DATA_POLICY_REFUSED' ? 'OPENROUTER_PRIVACY_UNAVAILABLE' : error.code, { params: {
    ...(error.amounts ? { requested: error.amounts.requested, currency: error.amounts.currency } : {}),
    ...(error.amounts && inspectedAccount?.budget.currency === error.amounts.currency ? { settled: inspectedAccount.settledExactMinorUnits,
      held: inspectedAccount.reservedMinorUnits, requested: error.amounts.requested, limit: inspectedAccount.budget.limitMinorUnits, currency: inspectedAccount.budget.currency } : {}),
    ...(error.nextAction ? { nextAction: error.nextAction } : {}) } });
  if (error instanceof OpenRouterPricingError) return registeredFailure(error.code === 'INVALID_REQUEST'
    ? 'MODEL_INVOCATION_INVALID' : error.code === 'PRIVACY_UNAVAILABLE' ? 'OPENROUTER_PRIVACY_UNAVAILABLE' : 'PROVIDER_SPEND_UNAVAILABLE');
  if (error instanceof OpenRouterChatError) return registeredFailure(error.code === 'INVALID_PROFILE'
    ? 'MODEL_INVOCATION_PROFILE_CONFLICT' : error.code === 'TARIFF_CONFLICT' ? 'PROVIDER_SPEND_CONFLICT' : 'MODEL_INVOCATION_INVALID');
  if (error instanceof ModelInvocationStoreError) return registeredFailure(error.code,
    error.code === 'MODEL_NOT_ACTIVATED' && error.params ? { params: error.params } : undefined);
  if (error instanceof ModelActivationStoreError && error.deliveryFinding) return registeredFailure(error.code, { params: {
    profile: error.deliveryFinding.profileId, surface: error.deliveryFinding.surface,
    required: error.deliveryFinding.requiredBytes, available: error.deliveryFinding.availableBytes } });
  if (error instanceof ModelCatalogError && error.params) return registeredFailure(error.code, { params: error.params });
  if (error instanceof ModelInvocationError || error instanceof OpenAiChatHttpError
    || error instanceof ModelActivationError || error instanceof ModelActivationStoreError || error instanceof ModelCatalogError || error instanceof ModelRoleError) return registeredFailure(error.code);
  if (error instanceof WorkerModelAdmissionError) { const d = error.detail; return registeredFailure(error.code, { params: { taskId: d.taskId,
    channelId: d.channelId ?? '-', modelId: d.modelId ?? '-', minCliVersion: d.minCliVersion ?? '-', cliVersion: d.cliVersion ?? 'unparsed',
    ...(d.workClass !== undefined ? { workClass: d.workClass, skipped: d.skipped ?? '-', ...(d.skippedMore ? { skippedMore: d.skippedMore } : {}) } : {}) } }); }
  if (error instanceof AgentTurnStoreError) return registeredFailure(error.code);
  // E1: the bounded cause of an unavailable image probe (deadline|exit|signal|parse) travels as a param; Docker's text never does.
  if (error instanceof DockerImageProbeError && error.probeCause) return registeredFailure(error.code, { params: { cause: error.probeCause } });
  if (error instanceof UninstallError) return registeredFailure(error.code);
  if (error instanceof InstallationProfileError || error instanceof InstallationProfileFileError || error instanceof InstallationEvidenceError
    || error instanceof InstallationArtifactError || error instanceof DockerImageProbeError || error instanceof InstallationRecoveryError
    || error instanceof InstallationPublicationError || error instanceof InstallationJournalError || error instanceof InstallationLedgerError
    || error instanceof BootstrapStateError || error instanceof InstallationIdentityError || error instanceof ProjectIdentityError) return registeredFailure(error.code);
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
  if (error instanceof SupervisorError || error instanceof RunError || error instanceof RunLifecycleError || error instanceof ServiceShutdownError || error instanceof ReconciliationRecoveryError || error instanceof ReconciliationRuntimeLoopError || error instanceof CancellationRuntimeLoopError || error instanceof LocalRuntimeSocketError || error instanceof RuntimeServiceProtocolError || error instanceof RuntimeServiceLifecycleError || error instanceof RunWorkspaceCustodyError || error instanceof WorkspaceError || error instanceof CancellationDeliveryError || error instanceof TaskEvaluationError || error instanceof TaskEvidenceError || error instanceof EvaluationEvidenceError || error instanceof ExecutionRegistryError || error instanceof AuthenticationError || error instanceof AttemptStoreError || error instanceof DispatchError || error instanceof RunStoreError ||
    error instanceof WorkClassRegistryError || error instanceof WorkerEffortError || error instanceof ManagedFileError || error instanceof PolicyAuthorizationError || error instanceof WorkTargetError) return registeredFailure(error.code);
  return unexpectedQueryFailure(error);
}
