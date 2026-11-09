import { CodedError as DomainCodedError, AgentCatalogError, ApprovalError, AttemptError, AuditError, CandidateBindingError, CatalogEvolutionError, CommandIdError, DecisionDelegationError,
  DecisionError, EffectError, HubError, IdentityProfileError, MemoryError, ModelActivationError, ModelCatalogError, ModelInvocationError, ModelRoleError,
  NativeCliRegistryError, OpenAiChatHttpError, OperationCatalogError, PolicyChangeError, PolicyError, PolicyLastAdminError, ProviderCatalogError, RecoveryError,
  RegistryError, RunError, TargetQueueError, TaskEvaluationError, TaskGraphError, WorkClassRegistryError, WorkerEffortError, parseProviderCatalog,
  resolveModelBindingDefinition } from '#domain/index.js';
import { CodedError, BootstrapStateError, ErrorRegistry, JsonSchemaRefusal, LayoutError, ManagedFileError, snapshotKnownSecrets, takeQueryErrorRecord } from '#platform/index.js';
import { AgentCatalogStoreError, AgentTurnStoreError, AttemptStoreError, AuthenticationError, AuthorityChangeError, BeuserContractError, BeuserTransferError,
  CancellationDeliveryError, CancellationRuntimeLoopError, DecisionApplicationError, DispatchError, DispatchInventoryError, EffectTargetError,
  ExecutionRegistryError, HandoffError, HubClientError, HubServerError, InferenceServingError, InstallationEvidenceError, InstallationIdentityError,
  InstallationProfileError, InstallationPublicationError, InstallationRecoveryError, MemoryJournalError, ModelActivationStoreError, ModelConnectError,
  ModelInvocationApplication, ModelInvocationStoreError, NervousError, OAuthConnectionError, PermissionModeError, PersonalCustodyError, PolicyAuthorizationError,
  ProjectAttachmentError, ProjectIdentityError, ProviderSpendError, ReconciliationRecoveryError, ReconciliationRuntimeLoopError, RunLifecycleError,
  RunProgressionFailure, RunStoreError, RunWorkspaceCustodyError, RuntimeServiceLifecycleError, RuntimeServiceProtocolError, SchedulingError,
  ScopeRegistrationError, ServiceShutdownError, SessionAuthenticationError, StandingApprovalError, SupervisorError, SystemPolicyRowsError, TaskEvidenceError,
  ToolchainCurrencyError, ToolchainUpdateError, UninstallError, WorkTargetError, WorkerModelAdmissionError, WorkerObservationError, WorkspaceAdoptionError,
  WorkspaceError, WorkspacePatchError } from '#engine/index.js';
import { ArtifactError, EvaluationEvidenceError, NativeCliWorkerError, NativeWorkerVerificationError } from '#capabilities/index.js';
import { BeuserSurfaceError, DockerCommandFailure, DecisionHttpError, DockerImageProbeError, DockerTaskProfileError, HubNetworkError, InferenceMetricsError, InstallationArtifactError,
  InstallationFileError, InstallationJournalError, InstallationLedgerError, InstallationProfileFileError, LocalRuntimeSocketError, MCP_CLIENT_DEFAULTS,
  McpClientPool, McpRedirectRefusedError, NativeCodingProfileError, NativeConnectionError, NpmRegistryError, OpenRouterChatError, OpenRouterPricingError,
  PolicyFileError, ProcessRunnerError, ProviderConnectError, ProviderModelListError, ProviderProbeError, RuntimeLauncherError, ScratchError, ServiceFrameError,
  WorkspaceWriteError, type McpClientServerSettings } from '#adapters/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NativeJsonHttpError } from '#adapters/core/provider-http-json/index.js';
import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { queryFailure } from '../../../src/composition/core/query-errors/index.js';
it('preserves registered errors and redacts unknown native/storage details through one shared mapper', () => {
  const known = ErrorRegistry.createError('POLICY_DENIED'); expect(queryFailure(known)).toBe(known);
  expect(queryFailure(new PolicyAuthorizationError('POLICY_DENIED')).code).toBe('POLICY_DENIED');
  const cause = new Error('retained cause');
  const effect = new EffectError('EFFECT_REJECTED', { cause });
  expect([effect.code, effect.message, effect.name, effect.cause]).toEqual(['EFFECT_REJECTED', 'EFFECT_REJECTED', 'EffectError', cause]);
  const socket = new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause });
  expect([socket.code, socket.message, socket.name, socket.cause]).toEqual(['LOCAL_RUNTIME_TRANSPORT', 'LOCAL_RUNTIME_TRANSPORT', 'LocalRuntimeSocketError', cause]);
  const catalog = new OperationCatalogError('OPERATION_CATALOG_CONFLICT', 'subject');
  expect([catalog.message, catalog.subject]).toEqual(['OPERATION_CATALOG_CONFLICT: subject', 'subject']);
  const scratch = new ScratchError('SCRATCH_UNSAFE', 'bounded detail');
  expect([scratch.message, scratch.code]).toEqual(['bounded detail', 'SCRATCH_UNSAFE']);
  expect(queryFailure(effect).code).toBe('EFFECT_REJECTED'); expect(queryFailure(socket).code).toBe('LOCAL_RUNTIME_TRANSPORT');
  for (const unmapped of [catalog, scratch]) expect(queryFailure(unmapped).code).toBe('QUERY_UNEXPECTED_FAILURE');
  const raw = new Error('SQL /private/customer/ledger secret=credential');
  const safe = queryFailure(raw); expect(safe.code).toBe('QUERY_UNEXPECTED_FAILURE'); expect(String(safe)).not.toContain('credential'); expect(String(safe)).not.toContain('/private');
  expect(queryFailure(new RunStoreError('RUN_STORE_CORRUPT')).code).toBe('RUN_STORE_CORRUPT');
  for (const code of ['AGENT_USE_PIN_MISMATCH', 'AGENT_USE_TASK_UNAVAILABLE', 'AGENT_USE_WORK_CLASS_REQUIRED', 'AGENT_USE_CATALOG_UNAVAILABLE'] as const) {
    const failure = queryFailure(new AgentCatalogStoreError(code));
    expect(failure.code).toBe(code); expect(failure.category).toBe('error');
    for (const locale of ['en', 'tr'] as const) expect(failure.localize?.(locale).message).toBe(ErrorRegistry.get(code, locale)?.message);
    expect(failure.localize?.('tr').message).not.toBe(failure.localize?.('en').message);
  }

});
it('preserves the registered unsupported execution-host failure with localized guidance', () => {
  const failure = ErrorRegistry.createError('EXECUTION_HOST_UNSUPPORTED');
  expect(queryFailure(failure)).toBe(failure);
  expect(failure.code).toBe('EXECUTION_HOST_UNSUPPORTED');
  expect(failure.localize?.('en').message).toContain('non-root host user');
  expect(failure.localize?.('tr').message).toContain('root olmayan');
});
it.each([
  new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT'),
  new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'),
  new WorkspaceError('WORKSPACE_CUSTODY_UNCONVERTIBLE'),
  new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT'),
  new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT'),
  new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'),
  new TaskEvaluationError('TASK_EVALUATION_STALE'),
  new TaskEvaluationError('TASK_EVALUATION_NOT_READY'),
  new TaskEvidenceError('TASK_EVIDENCE_UNLINKED'),
  new EvaluationEvidenceError('EVALUATION_EVIDENCE_CORRUPT'),
  new EvaluationEvidenceError('EVALUATION_EVIDENCE_LIMIT'),
])('preserves evaluation failure identity with localized text and no internal details: $code', error => {
  error.message += ' /private/evidence credential=secret';
  const safe = queryFailure(error);
  expect(safe.code).toBe(error.code);
  expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
  expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
});

it('exposes only the bounded adapter-version conflict reason', () => {
  const error = new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT', 'adapter-version-mismatch');
  Object.assign(error, { sourceFingerprint: 'private', path: '/private/repository', credential: 'secret' });
  const safe = queryFailure(error);
  expect(safe.params).toEqual({ reason: 'adapter-version-mismatch' });
  expect(JSON.stringify(safe)).not.toContain('/private');
  expect(JSON.stringify(safe)).not.toContain('secret');
});

it('exposes only bounded managed-file failure metadata, without path, UID or raw stat objects', () => {
  const metadata = { resource: 'ledger' as const, companion: '-shm', stage: 'path' as const, reason: 'link-count' as const,
    mode: 0o600, links: 0, path: '/private/customer/ledger.db-shm', uid: 1234, secret: 'private-key' };
  const safe = queryFailure(new ManagedFileError('MANAGED_FILE_UNSAFE', metadata));
  expect(safe.params).toEqual({ resource: 'ledger', companion: '-shm', stage: 'path', reason: 'link-count', mode: 0o600, links: 0 });
  expect(JSON.stringify(safe)).not.toContain('/private'); expect(JSON.stringify(safe)).not.toContain('private-key');
  expect(safe.params).not.toHaveProperty('uid');
});

it.each(['PROVIDER_SPEND_INVALID', 'PROVIDER_SPEND_CONFLICT', 'PROVIDER_SPEND_EXHAUSTED', 'PROVIDER_SPEND_FROZEN', 'PROVIDER_SPEND_UNAVAILABLE'] as const)(
  'preserves monetary failure identity without raw record details: %s', code => {
    const failure = new ProviderSpendError(code); failure.message += ' /private/ledger credential=secret';
    const safe = queryFailure(failure); expect(safe.code).toBe(code);
    expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
    expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
  });

it('maps native pricing and request failures to safe product errors without backend details', () => {
  for (const [error, code] of [
    [new OpenRouterPricingError('INCOMPLETE_PRICING'), 'PROVIDER_SPEND_UNAVAILABLE'],
    [new OpenRouterPricingError('INVALID_REQUEST'), 'MODEL_INVOCATION_INVALID'],
    [new OpenRouterChatError('INVALID_PROFILE'), 'MODEL_INVOCATION_PROFILE_CONFLICT'],
    [new OpenRouterChatError('TARIFF_CONFLICT'), 'PROVIDER_SPEND_CONFLICT'],
  ] as const) {
    error.message += ' https://private/credential=secret';
    const safe = queryFailure(error); expect(safe.code).toBe(code);
    expect(String(safe)).not.toContain('private'); expect(String(safe)).not.toContain('credential=secret');
  }
});
it('carries a reservation diagnostic as RUN_CAPACITY_OR_ORDER parameters in the fixed field order, an absent gap left out (COMPOSITION-RELIEF)', () => {
  const diagnostic = { reconciliationCount: 0, terminalCount: 1, occupiedCount: 2, delayedCount: 0, blockedCount: 0, waitingCount: 3, readyCount: 4,
    requestedCount: 5, selectedCount: 0, inFlightOccupied: 1, executionOccupied: 2, inFlightSlots: 3, executionSlots: 2, now: 1_000, reason: 'capacity-exhausted' as const,
    site: 'application-empty' as const };
  const order = ['site', 'reason', 'now', 'executionSlots', 'inFlightSlots', 'executionOccupied', 'inFlightOccupied', 'selectedCount', 'requestedCount', 'readyCount',
    'waitingCount', 'blockedCount', 'delayedCount', 'occupiedCount', 'terminalCount', 'reconciliationCount'];
  const plain = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', diagnostic));
  expect(plain.code).toBe('RUN_CAPACITY_OR_ORDER');
  expect(Object.keys(plain.params ?? {})).toEqual(order);
  expect(plain.params).toEqual(diagnostic);
  const delayed = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', { ...diagnostic, reason: 'delayed', eligibilityGapMs: 250 }));
  expect(Object.keys(delayed.params ?? {})).toEqual([...order.slice(0, 3), 'eligibilityGapMs', ...order.slice(3)]);
  expect(delayed.params?.['eligibilityGapMs']).toBe(250);
});

it.each(['DISPATCH_ARTIFACT_REQUIRED', 'DISPATCH_CONFLICT', 'DISPATCH_NOT_ADMITTED', 'DISPATCH_CORRUPT', 'DISPATCH_PROFILE_VALIDATION_REQUIRED'] as const)(
  'preserves the typed dispatch failure code with EN/TR text and no internal details: %s', code => {
    const error = new DispatchError(code); error.message += ' /private/ledger credential=secret';
    const safe = queryFailure(error);
    expect(safe.code).toBe(code);
    expect(safe.localize?.('en').message).not.toMatch(/^error\./); expect(safe.localize?.('tr').message).not.toMatch(/^error\./);
    expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
    expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
  });

it('keeps unrelated error classes as QUERY_UNEXPECTED_FAILURE (no over-generalisation of dispatch codes)', () => {
  const plain = new Error('DISPATCH_CONFLICT'); expect(queryFailure(plain).code).toBe('QUERY_UNEXPECTED_FAILURE');
  const spoof = Object.assign(new Error('x'), { code: 'DISPATCH_CONFLICT' }); expect(queryFailure(spoof).code).toBe('QUERY_UNEXPECTED_FAILURE');
});


it.each(['SUPERVISOR_OPTIONS_INVALID', 'SUPERVISOR_REQUEST_INVALID', 'SUPERVISOR_WORKSPACE_INVALID',
  'SUPERVISOR_CONTROL_FAILED', 'SUPERVISOR_IDENTITY_CONFLICT', 'SUPERVISOR_CANCELLED', 'SUPERVISOR_NOT_TERMINAL',
  'SUPERVISOR_PROFILE_INVALID', 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH', 'SUPERVISOR_RELEASE_UNCONFIRMED'] as const)(
  'preserves supervisor failure %s through the shared mapper', code => {
    const error = new SupervisorError(code); error.message += ' /private/customer token=credential';
    const safe = queryFailure(error); expect(safe.code).toBe(code);
    expect(safe.localize?.('en').message).not.toBe(safe.localize?.('tr').message);
    expect(JSON.stringify(safe)).not.toContain('credential'); expect(String(safe)).not.toContain('/private');
  });
it('keeps unknown messages and causes in a bounded server record, with only class and correlation on the client', () => {
  const error = new Error('adapter broke at /private/workspace secret=credential\n\x1b[31m', { cause: new Error('socket failed C:\\private\\worker') });
  const safe = queryFailure(error);
  expect(safe.code).toBe('QUERY_UNEXPECTED_FAILURE'); expect(safe.params).toEqual({ errorClass: 'Error', diagnosticId: expect.any(String) });
  const record = takeQueryErrorRecord(safe, snapshotKnownSecrets([{ name: 'QUERY_FIXTURE', value: 'credential' }]));
  expect(record).toContain('adapter broke'); expect(record).toContain('socket failed');
  expect(record).not.toContain('credential'); expect(record).not.toContain(String.fromCharCode(27)); expect(record!.length).toBeLessThanOrEqual(2048);
  expect(JSON.stringify(safe)).not.toMatch(/credential|private|\\u001b/);
  expect(safe).not.toHaveProperty('cause');
  expect(String(queryFailure(new Error('x'.repeat(10000)))).length).toBeLessThan(2200);
});

// A36: the brand alone cannot authorize disclosure, even when another class uses the same code.
it('keeps all 45 previously unmapped coded classes behind QUERY_UNEXPECTED_FAILURE', async () => {
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
    { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'fixture',
      protocols: [{ family: 'responses', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] },
  ] }), reference)!;
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'responses' as const, version: '1' }, allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 },
    adapter: { id: 'fixture', version: 1, definition: {} }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
  const application = new ModelInvocationApplication(
    { async verify() { return { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user', scopeIds: ['scope'] }; } },
    { async authorize() { return { revision: 'policy', ruleId: 'invoke' }; } },
    { async inspect() { return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'current', definition, binding, availability: 'not-observed' }; } },
    async () => ({ async loadRecord() { return { schemaVersion: 1, scopeId: 'scope', reference, revision: 1, state: 'active',
      catalogRevision: 'previous', definition, binding }; }, close() {} }),
    { async resolve() { return profile; } },
    { resolve() { return { async prepare() { throw new Error('must not prepare'); }, async send() { throw new Error('must not send'); } }; } },
    async () => { throw new Error('must not open store'); }, { invocationId: () => 'invocation', ownerId: () => 'owner', now: () => 0 });
  let invocabilityRefusal: unknown;
  try {
    await application.preview({ schemaVersion: 1, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'current',
      expectedBinding: binding, nativeRequest: {} }, undefined, undefined, { surfaces: [], credentialPresent: async () => true });
  } catch (error) { invocabilityRefusal = error; }
  expect(invocabilityRefusal).toBeInstanceOf(Error);
  expect((invocabilityRefusal as Error).name).toBe('InvocabilityRefusal');
  let mcpInputLimit: unknown;
  const start = vi.spyOn(StreamableHTTPClientTransport.prototype, 'start').mockImplementation(async function (this: StreamableHTTPClientTransport) {
    const onerror = this.onerror;
    this.onerror = error => { mcpInputLimit = error; onerror?.(error); };
    this.onmessage = () => undefined;
    this.onmessage?.({ jsonrpc: '2.0', method: 'notifications/message', params: { padding: 'x'.repeat(1024) } });
    throw mcpInputLimit;
  });
  const pool = new McpClientPool(new AbortController().signal);
  const server: McpClientServerSettings = { id: 'fixture', transport: 'http', url: 'http://127.0.0.1:1/mcp',
    command: '', args: [], env: {}, realm: 'host', tools: [] };
  try {
    await pool.open(server, { ...MCP_CLIENT_DEFAULTS, inputMaxBytes: 128, servers: [server] }, { cwd: process.cwd(), environment: {}, sandboxes: [] });
    expect(mcpInputLimit).toBeInstanceOf(Error);
    expect((mcpInputLimit as Error).name).toBe('McpInputLimitError');
  } finally { await pool.close(); start.mockRestore(); }
  const errors = [
    new ProviderCatalogError('PROVIDER_CATALOG_INVALID'),
    new NativeCliRegistryError(),
    new AttemptError('ATTEMPT_INVALID'),
    new PolicyError('POLICY_INVALID'),
    new RecoveryError('RECOVERY_INVALID'),
    new OperationCatalogError('OPERATION_TARGET_KIND_RESERVED', 'subject'),
    new RegistryError('REGISTRY_MANIFEST_INVALID'),
    new IdentityProfileError('IDENTITY_PROFILE_INVALID'),
    new HubError('HUB_PACKAGE_SCHEMA_UNSUPPORTED'),
    new LayoutError('LAYOUT_VERSION_UNSUPPORTED'),
    new JsonSchemaRefusal('invalid-schema', '#', 'private fixture'),
    new ArtifactError('ARTIFACT_INVALID'),
    new NativeWorkerVerificationError('NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED'),
    new ToolchainCurrencyError('TOOLCHAIN_CATALOG_INVALID'),
    new ToolchainUpdateError('TOOLCHAIN_RECIPE_INVALID'),
    new ModelConnectError('MODEL_CONNECT_INVALID'),
    new PermissionModeError('PERMISSION_MODE_CONFLICT'),
    new SchedulingError('SCHEDULING_INPUT_INVALID'),
    new EffectTargetError('EFFECT_TARGET_PRECONDITION'),
    new StandingApprovalError('STANDING_UNSUPPORTED'),
    new PersonalCustodyError('foreign-os-owner'),
    new SystemPolicyRowsError('SYSTEM_POLICY_ROWS_DIGEST'),
    new InferenceServingError('INFERENCE_PROFILE_UNKNOWN', 'profile'),
    new OAuthConnectionError('POLICY_APPROVAL_UNSUPPORTED'),
    new HubServerError('HUB_SERVER_DENIED'),
    new HubClientError('HUB_SOURCE_INVALID'),
    new WorkspaceWriteError('precondition', 'private fixture'),
    new ScratchError('SCRATCH_KEY_INVALID'),
    mcpInputLimit,
    new McpRedirectRefusedError('private fixture'),
    new PolicyFileError('POLICY_FILE_INVALID'),
    new DockerTaskProfileError('DOCKER_TASK_PROFILE_INVALID'),
    new ProcessRunnerError('PROCESS_RUNNER_INVALID'),
    new ServiceFrameError('SERVICE_FRAME_LIMIT'),
    new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID'),
    new NpmRegistryError('NPM_REGISTRY_ENDPOINT_INVALID'),
    new InferenceMetricsError('INFERENCE_METRICS_ENDPOINT_INVALID'),
    new RuntimeLauncherError('RUNTIME_LAUNCH_INVALID'),
    new NativeCodingProfileError('WORKER_EFFORT_UNSUPPORTED'),
    new DecisionHttpError('MODEL_INVOCATION_INVALID'),
    new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE'),
    new ProviderProbeError('PROVIDER_KIND_UNAVAILABLE'),
    new ProviderConnectError('MODEL_CONNECT_PRICE_REQUIRED'),
    new HubNetworkError('HUB_TLS_REQUIRED'),
    invocabilityRefusal,
  ];
  expect(errors).toHaveLength(45);
  for (const error of [new CodedError('POLICY_DENIED'), new DomainCodedError('POLICY_DENIED'),
    new DockerCommandFailure('', '', 125, false), new DockerCommandFailure('', '', null, true),
    Object.defineProperty(new Error('foreign'), 'code', { get() { throw new Error('must not inspect foreign codes'); } })]) {
    expect(queryFailure(error).code).toBe('QUERY_UNEXPECTED_FAILURE');
  }
  for (const error of errors) {
    const failure = queryFailure(error);
    expect(failure.code, (error as Error).constructor.name).toBe('QUERY_UNEXPECTED_FAILURE');
    expect(failure.params).toEqual({ errorClass: 'Error', diagnosticId: expect.any(String) });
  }
});

it('pins the exact client-visible code of every existing mapper class and arm shape', () => {
  const rows = [
    [new CommandIdError(), 'COMMAND_ID_RESERVED'],
    [new ModelRoleError('MODEL_ROLE_OVERRIDE_DENIED'), 'MODEL_ROLE_OVERRIDE_DENIED'],
    [new TaskGraphError('TASK_GRAPH_INVALID'), 'TASK_GRAPH_INVALID'],
    [new ModelActivationError('MODEL_ACTIVATION_INVALID'), 'MODEL_ACTIVATION_INVALID'],
    [new ModelCatalogError('MODEL_CATALOG_INVALID'), 'MODEL_CATALOG_INVALID'],
    [new ModelInvocationError('MODEL_INVOCATION_INVALID'), 'MODEL_INVOCATION_INVALID'],
    [new OpenAiChatHttpError('OPENAI_CHAT_DEFINITION_INVALID'), 'OPENAI_CHAT_DEFINITION_INVALID'],
    [new ApprovalError('APPROVAL_INVALID'), 'APPROVAL_INVALID'],
    [new PolicyChangeError('POLICY_CHANGE_INVALID'), 'POLICY_CHANGE_INVALID'],
    [new AuditError('AUDIT_INVALID'), 'AUDIT_INVALID'],
    [new EffectError('EFFECT_INVALID'), 'EFFECT_INVALID'],
    [new CandidateBindingError('CANDIDATE_MISMATCH'), 'CANDIDATE_MISMATCH'],
    [new TargetQueueError('QUEUE_CONFLICT'), 'QUEUE_CONFLICT'],
    [new PolicyLastAdminError(), 'POLICY_LAST_ADMIN'],
    [new DecisionDelegationError('AI_AUTHORITY_NON_DELEGABLE'), 'AI_AUTHORITY_NON_DELEGABLE'],
    [new WorkerEffortError('WORKER_EFFORT_UNSUPPORTED'), 'WORKER_EFFORT_UNSUPPORTED'],
    [new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED'), 'WORK_CLASS_OVERRIDE_DENIED'],
    [new AgentCatalogError('AGENT_DEFINITION_INVALID'), 'AGENT_DEFINITION_INVALID'],
    [new RunError('RUN_INVALID'), 'INVENTORY_UNAVAILABLE'],
    [new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH'), 'TASK_EVALUATION_PROFILE_MISMATCH'],
    [new DecisionError('DECISION_POLICY_INVALID'), 'DECISION_POLICY_INVALID'],
    [new MemoryError('MEMORY_ENTRY_INVALID'), 'MEMORY_ENTRY_INVALID'],
    [new CatalogEvolutionError('CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE'), 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE'],
    [new BootstrapStateError('BOOTSTRAP_STATE_INVALID'), 'BOOTSTRAP_STATE_INVALID'],
    [new ManagedFileError('MANAGED_FILE_UNSUPPORTED'), 'MANAGED_FILE_UNSUPPORTED'],
    [new AuthenticationError('AUTHENTICATION_REQUIRED'), 'AUTHENTICATION_REQUIRED'],
    [new SessionAuthenticationError('SESSION_REQUIRED'), 'SESSION_REQUIRED'],
    [new AttemptStoreError('ATTEMPT_STORE_CONFLICT'), 'INVENTORY_UNAVAILABLE'],
    [new SupervisorError('SUPERVISOR_REQUEST_INVALID'), 'SUPERVISOR_REQUEST_INVALID'],
    [new WorkspaceError('WORKSPACE_REQUEST_INVALID'), 'WORKSPACE_REQUEST_INVALID'],
    [new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT'), 'RUN_WORKSPACE_CUSTODY_CONFLICT'],
    [new WorkTargetError('WORK_TARGET_PATH_INVALID'), 'WORK_TARGET_PATH_INVALID'],
    [new EvaluationEvidenceError('EVALUATION_EVIDENCE_INVALID'), 'EVALUATION_EVIDENCE_INVALID'],
    [new NativeCliWorkerError('NATIVE_CLI_WORKER_PROFILE_INVALID'), 'NATIVE_CLI_WORKER_PROFILE_INVALID'],
    [new DispatchError('DISPATCH_FENCE_CONFLICT'), 'DISPATCH_FENCE_CONFLICT'],
    [new DispatchInventoryError(), 'DISPATCH_INVENTORY_LIMIT'],
    [new PolicyAuthorizationError('POLICY_DENIED'), 'POLICY_DENIED'],
    [new ScopeRegistrationError('RUNTIME_SERVICE_SCOPE_FOREIGN', ['scope']), 'RUNTIME_SERVICE_SCOPE_FOREIGN'],
    [new ModelActivationStoreError('MODEL_ACTIVATION_COMMAND_CONFLICT'), 'MODEL_ACTIVATION_COMMAND_CONFLICT'],
    [new WorkerModelAdmissionError('WORKER_EFFORT_UNSUPPORTED', { taskId: 'task', channelId: null, modelId: null }), 'WORKER_EFFORT_UNSUPPORTED'],
    [new ProviderSpendError('PROVIDER_SPEND_INVALID'), 'PROVIDER_SPEND_INVALID'],
    [new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT'), 'MODEL_INVOCATION_COMMAND_CONFLICT'],
    [new AuthorityChangeError('POLICY_CONFLICT'), 'INVENTORY_UNAVAILABLE'],
    [new RunStoreError('RUN_NOT_FOUND'), 'RUN_NOT_FOUND'],
    [new HandoffError('HANDOFF_SOURCE_NOT_ACCEPTED'), 'HANDOFF_SOURCE_NOT_ACCEPTED'],
    [new WorkerObservationError('WORKER_OBSERVATION_INVALID'), 'WORKER_OBSERVATION_INVALID'],
    [new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT'), 'CANCELLATION_DELIVERY_CONFLICT'],
    [new ExecutionRegistryError('TASK_KIND_NOT_REGISTERED'), 'TASK_KIND_NOT_REGISTERED'],
    [new RunLifecycleError('RUN_QUOTA_PERSON_REQUIRED'), 'RUN_QUOTA_PERSON_REQUIRED'],
    [new CancellationRuntimeLoopError('CANCELLATION_RUNTIME_LOOP_OPTIONS'), 'CANCELLATION_RUNTIME_LOOP_OPTIONS'],
    [new RuntimeServiceLifecycleError('RUNTIME_SERVICE_OPTIONS'), 'RUNTIME_SERVICE_OPTIONS'],
    [new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION'), 'RUNTIME_SERVICE_CORRELATION'],
    [new ReconciliationRecoveryError('RECONCILIATION_RECOVERY_INVALID'), 'RECONCILIATION_RECOVERY_INVALID'],
    [new ReconciliationRuntimeLoopError('RECONCILIATION_RUNTIME_LOOP_OPTIONS'), 'RECONCILIATION_RUNTIME_LOOP_OPTIONS'],
    [new ServiceShutdownError('SERVICE_SHUTDOWN_INVALID'), 'SERVICE_SHUTDOWN_INVALID'],
    [new AgentTurnStoreError('AGENT_TURN_IN_PROGRESS'), 'AGENT_TURN_IN_PROGRESS'],
    [new TaskEvidenceError('TASK_EVIDENCE_INVALID'), 'TASK_EVIDENCE_INVALID'],
    [new WorkspacePatchError('PATCH_INTEGRATION_PENDING'), 'PATCH_INTEGRATION_PENDING'],
    [new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED'), 'ADOPTION_TARGET_DENIED'],
    [new ProjectIdentityError('PROJECT_IDENTITY_INVALID'), 'PROJECT_IDENTITY_INVALID'],
    [new InstallationIdentityError('INSTALLATION_IDENTITY_INVALID'), 'INSTALLATION_IDENTITY_INVALID'],
    [new InstallationProfileError('INSTALLATION_PROFILE_INVALID'), 'INSTALLATION_PROFILE_INVALID'],
    [new InstallationEvidenceError('INSTALLATION_EVIDENCE_INVALID'), 'INSTALLATION_EVIDENCE_INVALID'],
    [new InstallationRecoveryError('INSTALLATION_RECOVERY_INVALID'), 'INSTALLATION_RECOVERY_INVALID'],
    [new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID'), 'INSTALLATION_PUBLICATION_INVALID'],
    [new UninstallError('UNINSTALL_INVALID'), 'UNINSTALL_INVALID'],
    [new NervousError('NERVOUS_RULES_UNREADABLE'), 'NERVOUS_RULES_UNREADABLE'],
    [new DecisionApplicationError('DECISION_INVALID'), 'DECISION_INVALID'],
    [new MemoryJournalError('MEMORY_EVALUATOR_REQUIRED'), 'MEMORY_EVALUATOR_REQUIRED'],
    [new AgentCatalogStoreError('AGENT_CATALOG_UNAVAILABLE'), 'AGENT_CATALOG_UNAVAILABLE'],
    [new BeuserTransferError(), 'BACKUP_REALM_SEALED'],
    [new BeuserContractError('BEUSER_SURFACE_UNAVAILABLE'), 'BEUSER_SURFACE_UNAVAILABLE'],
    [new ProjectAttachmentError('PROJECT_ATTACHMENT_INVALID'), 'PROJECT_ATTACHMENT_INVALID'],
    [new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE'), 'NATIVE_CREDENTIAL_UNAVAILABLE'],
    [new InstallationLedgerError('INSTALLATION_LEDGER_INVALID'), 'INSTALLATION_LEDGER_INVALID'],
    [new DockerImageProbeError('DOCKER_IMAGE_PROBE_INVALID'), 'DOCKER_IMAGE_PROBE_INVALID'],
    [new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED'), 'LOCAL_RUNTIME_UNSUPPORTED'],
    [new InstallationProfileFileError('INSTALL_PROFILE_SOURCE_UNAVAILABLE'), 'INSTALL_PROFILE_SOURCE_UNAVAILABLE'],
    [new InstallationArtifactError('INSTALLATION_ARTIFACT_INVALID'), 'INSTALLATION_ARTIFACT_INVALID'],
    [new InstallationJournalError('INSTALLATION_JOURNAL_INVALID'), 'INSTALLATION_JOURNAL_INVALID'],
    [new InstallationFileError('INSTALLATION_FILE_CONFLICT'), 'INSTALLATION_FILE_CONFLICT'],
    [new OpenRouterChatError('INVALID_PROFILE'), 'MODEL_INVOCATION_PROFILE_CONFLICT'],
    [new OpenRouterPricingError('INVALID_REQUEST'), 'MODEL_INVOCATION_INVALID'],
    [new BeuserSurfaceError('BEUSER_SURFACE_UNAVAILABLE'), 'BEUSER_SURFACE_UNAVAILABLE'],
    [new RunProgressionFailure(new PolicyAuthorizationError('POLICY_DENIED'), null), 'POLICY_DENIED'],
    [new RunProgressionFailure(new OperationCatalogError('OPERATION_CATALOG_CONFLICT', 'subject'), 1), 'QUERY_UNEXPECTED_FAILURE'],
    [new ZodError([]), 'INVENTORY_QUERY_INVALID'],
    [Object.assign(new SupervisorError('SUPERVISOR_CONTROL_FAILED'), { code: 0 }), 'INVENTORY_UNAVAILABLE'],
    [Object.assign(new SupervisorError('SUPERVISOR_CONTROL_FAILED'), { code: '' }), 'INVENTORY_UNAVAILABLE'],
    [ErrorRegistry.createError('POLICY_DENIED'), 'POLICY_DENIED'],
    [new OpenRouterPricingError('INCOMPLETE_PRICING'), 'PROVIDER_SPEND_UNAVAILABLE'],
    [new OpenRouterPricingError('PRIVACY_UNAVAILABLE'), 'OPENROUTER_PRIVACY_UNAVAILABLE'],
    [new OpenRouterChatError('TARIFF_CONFLICT'), 'PROVIDER_SPEND_CONFLICT'],
    [new OpenRouterChatError('INVALID_REQUEST'), 'MODEL_INVOCATION_INVALID'],
    [new ProviderSpendError('PROVIDER_SPEND_DATA_POLICY_REFUSED'), 'OPENROUTER_PRIVACY_UNAVAILABLE'],
    [new TaskGraphError('TASK_PROGRESS_INVALID'), 'QUERY_UNEXPECTED_FAILURE'],
  ] as const;
  for (const [error, code] of rows) expect(queryFailure(error).code, error.constructor.name).toBe(code);
  const parameterRows = [
    [new AuthorityChangeError('POLICY_DELEGATION_EXCEEDS', null, { cell: { kind: 'config', action: 'write', id: 'target', scope: 'scope' },
      reason: 'no-grant', sole: false, people: [] }), 'POLICY_DELEGATION_EXCEEDS',
      { kind: 'config', action: 'write', target: 'target', scope: 'scope', reason: 'no-grant', hint: 'unnamed', people: '' }],
    [new TargetQueueError('QUEUE_CAPACITY', { limit: '2' }), 'QUEUE_CAPACITY', { limit: '2' }],
    [new WorkspacePatchError('PATCH_LIMIT', 'bytes', { limit: 2 }), 'PATCH_LIMIT', { limit: 2, detail: 'bytes', field: 'artifacts.maxBytes' }],
    [new WorkspacePatchError('PATCH_SCOPE_VIOLATION', undefined, { count: 2 }), 'PATCH_SCOPE_VIOLATION', { count: 2 }],
    [new RunLifecycleError('TASK_DECISION_APPROVAL_REQUIRED', 'approval'), 'TASK_DECISION_APPROVAL_REQUIRED', { approvalId: 'approval' }],
    [new InstallationFileError('INSTALLATION_FILE_CONFLICT', { resource: 'fixture' }), 'INSTALLATION_FILE_CONFLICT', { resource: 'fixture' }],
    [new ProviderSpendError('PROVIDER_SPEND_EXHAUSTED', { settled: 'private', held: 3, requested: 2, limit: 10, currency: 'USD' }),
      'PROVIDER_SPEND_EXHAUSTED', { requested: 2, currency: 'USD', nextAction: 'models.revise-budget' }],
    [new ModelInvocationStoreError('MODEL_NOT_ACTIVATED', { scope: 'scope' }), 'MODEL_NOT_ACTIVATED', { scope: 'scope' }],
    [new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE', { private: 'withheld' }), 'MODEL_INVOCATION_UNAVAILABLE', {}],
    [new ModelActivationStoreError('MODEL_ACTIVATION_DELIVERY_UNFIT', { profileId: 'profile', surface: 'wire', requiredBytes: 2, availableBytes: 1 }),
      'MODEL_ACTIVATION_DELIVERY_UNFIT', { profile: 'profile', surface: 'wire', required: 2, available: 1 }],
    [new ModelCatalogError('MODEL_CATALOG_NOT_FOUND', { model: 'model' }), 'MODEL_CATALOG_NOT_FOUND', { model: 'model' }],
    [new WorkerModelAdmissionError('WORKER_MODEL_UNPINNED', { taskId: 'task', channelId: null, modelId: null, workClass: 'class', skippedMore: 2 }),
      'WORKER_MODEL_UNPINNED', { taskId: 'task', channelId: '-', modelId: '-', minCliVersion: '-', cliVersion: 'unparsed', workClass: 'class', skipped: '-', skippedMore: 2 }],
    [new DockerImageProbeError('DOCKER_IMAGE_PROBE_UNAVAILABLE', 'deadline'), 'DOCKER_IMAGE_PROBE_UNAVAILABLE', { cause: 'deadline' }],
    [new RuntimeServiceLifecycleError('RUNTIME_SERVICE_BUSY', 0), 'RUNTIME_SERVICE_BUSY', { retryAfterMs: 0 }],
    [new ScopeRegistrationError('RUNTIME_SERVICE_SCOPE_FOREIGN', ['scope-a', 'scope-b']), 'RUNTIME_SERVICE_SCOPE_FOREIGN', { scopeIds: 'scope-a,scope-b' }],
    [new TaskGraphError('TASK_DEPENDENCY_MISSING', [{ path: ['tasks', 0], code: 'fixture' }]), 'TASK_GRAPH_INVALID',
      { reason: 'TASK_DEPENDENCY_MISSING', path: 'graph.tasks.0' }],
    [new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', undefined, '/socket', 'socket-link'), 'LOCAL_RUNTIME_TRANSPORT', { path: '/socket', reason: 'socket-link' }],
  ] as const;
  for (const [error, code, params] of parameterRows) {
    const failure = queryFailure(error);
    expect([failure.code, failure.params], error.constructor.name).toEqual([code, params]);
  }
});
