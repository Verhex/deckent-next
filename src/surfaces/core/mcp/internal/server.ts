import { approvalListSchema, approvalQuerySchema, approvalRenewalSchema } from '#engine/index.js';
import { boundedToolDelivery, completeToolResult, jsonToolResult, modelToolDelivery, toolResultFits } from './delivery.js';
import { operationToolDefinitions } from './operation-tools.js';
import { modelActivationQuerySchema, modelActivationCommandSchema, modelCatalogCommandSchema, modelCatalogQuerySchema, modelInvocationCancellationCommandSchema, modelInvocationCommandSchema, modelInvocationPurgeCommandSchema, modelInvocationQuerySchema, providerSpendAccountQuerySchema, providerSpendAuditCommandInputSchema, providerSpendAuditCommandSchema,
  type ModelActivationQuery, type ModelActivationCommand, type ModelCatalogCommand, type ModelCatalogQuery, type ModelInvocationCancellationCommand, type ModelInvocationCommand, type ModelInvocationPurgeCommand, type ModelInvocationQuery, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import type { ModelActivationInspection, ModelActivationResult, ModelCatalogInspection, ModelCatalogResult, ModelInvocationCancellationResult, ModelInvocationInspection, ModelInvocationPurgeResult, ModelInvocationResult, ModelInvocationDelivery, ProviderSpendAccountInspection, ProviderSpendAuditResult, RuntimeServiceDelivery } from '#engine/index.js';
import { attemptIdentitySchema, modelReferenceSchema, type AttemptIdentity, type ModelReference, type EffectCommand, type OperationDescriptor } from '#domain/index.js';
import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PACKAGE_NAME, PACKAGE_VERSION, DeckentError, DeckentJsonSchemaValidator, t, type Locale } from '#platform/index.js';
import { runCommandSchema, runQuerySchema, dispatchInventoryInputSchema, getPolicyVocabulary, taskEvaluationCommandSchema,
  runAdmissionSchema, runReservationCommandSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, type RuntimeOperationQuery,
  type RunCommand, type RunQuery, type DispatchInventoryInput, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult,
  type ShutdownCommand, type TaskEvaluationCommand, type RunAdmission, type RunReservationCommand } from '#engine/index.js';
import type { DeclaredModelsInspection, ModelBindingInspection, ToolchainCurrencyReport } from '#engine/index.js';
import { poolCapacityCommandSchema, type PoolCapacityCommand, type PoolCapacityReceipt, type PoolCapacityView, poolHoldCommandSchema, poolHoldQuerySchema, type PoolHoldCommand, type PoolHoldQuery, type PoolHoldReceipt, type PoolHoldView } from '#engine/index.js';
import { decisionQuerySchema, type DecisionQuery, type DecisionInspection } from '#engine/index.js';
export interface McpApplications {
  inspectDecision?(query: DecisionQuery): Promise<DecisionInspection>;
  renewApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  listApprovals?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectModelActivation?(query: ModelActivationQuery): Promise<ModelActivationInspection>;
  admitModelActivation?(command: ModelActivationCommand): Promise<ModelActivationResult>;
  inspectModelCatalog?(query: ModelCatalogQuery): Promise<ModelCatalogInspection>;
  applyModelCatalog?(command: ModelCatalogCommand): Promise<ModelCatalogResult>;
  inspectPoolCapacity?(query: PoolHoldQuery): Promise<PoolCapacityView>;
  applyPoolCapacity?(command: PoolCapacityCommand): Promise<PoolCapacityReceipt>;
  inspectPoolHold?(query: PoolHoldQuery): Promise<PoolHoldView>;
  applyPoolHold?(command: PoolHoldCommand): Promise<PoolHoldReceipt>;
  inspectModelInvocation?(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
  invokeModel?(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationResult>;
  purgeModelInvocationContent?(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  cancelModelInvocation?(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  inspectProviderSpendAccount?(query: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAccountInspection>;
  auditProviderSpendAccount?(command: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAuditResult>;
  inspectDeclaredModels?(): Promise<DeclaredModelsInspection>;
  inspectModelBinding?(reference: ModelReference): Promise<ModelBindingInspection>;
  inspectToolchainCurrency?(): Promise<ToolchainCurrencyReport>;
  updateToolchains?(input: Readonly<{ apply?: boolean | undefined }>): Promise<unknown>;
  createRun?(command: RunAdmission): Promise<unknown>;
  reserveRunTasks?(command: RunReservationCommand): Promise<unknown>;
  executeTask?(identity: AttemptIdentity): Promise<unknown>;
  evaluateTask?(command: TaskEvaluationCommand): Promise<unknown>;
  reconcileAttempt?(identity: AttemptIdentity): Promise<unknown>;
  deliverRunCancellation?(command: RunCommand): Promise<unknown>;
  requestRunCancellation?(command: RunCommand): Promise<unknown>;
  inspectRun(query: RunQuery): Promise<unknown>;
  inspectInventory(query: DispatchInventoryInput): Promise<unknown>;
  describeService?(): Promise<RuntimeServiceDescriptor>;
  shutdownService?(command: ShutdownCommand): Promise<ServiceShutdownAdmissionResult>;
  inferencePlan?(input: { readonly profileId?: string }): Promise<unknown>;
  inferenceBudget?(input: { readonly profileId?: string }): Promise<unknown>;
  /** C12 G4 catalog operations (non-blocking: a required approval answers approval-pending; resubmit the same command after a decision). */
  executeOperation?(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  compensateOperation?(command: EffectCommand, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectOperation?(query: RuntimeOperationQuery, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  /** The installation's reachable catalog descriptors; the operation tool hints are derived from them (absent = empty catalog). */
  operationCatalog?: readonly OperationDescriptor[];
}
export interface McpLimits { maxConcurrentCalls: number; responseMaxBytes: number }
/** Local protocol surface. Injected applications own identity, policy and data access.
 * Mutators are advertised only when composition explicitly supplies their application handler. */
export function createMcpServer(applications: McpApplications, limits: McpLimits, locale: Locale) {
  z.object({ maxConcurrentCalls: z.number().int().positive().safe(), responseMaxBytes: z.number().int().positive().safe() }).strict().parse(limits);
  // idempotent: true only when engine/adapter code proves a commandId-keyed (or identity-keyed) durable
  // replay returns the prior result without a second effect; evidence is file:line-cited per tool in
  // proof/D03-MCP-IDEMPOTENT-2026-09-27/review.md. No default — every entry states it explicitly.
  const definitions: { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld?: boolean; name: string; description: string; schema: z.ZodTypeAny; modelDelivery?: boolean; boundedDelivery?: boolean; invoke(input: unknown, delivery?: ModelInvocationDelivery | RuntimeServiceDelivery): Promise<unknown> }[] = [
    { readOnly: true, destructive: false, idempotent: true, name: 'inspect_run', description: t('mcp.tool.inspectRun', {}, locale), schema: runQuerySchema,
      invoke: (input: unknown) => applications.inspectRun(runQuerySchema.parse(input)) },
    { readOnly: true, destructive: false, idempotent: true, name: 'inspect_inventory', description: t('mcp.tool.inspectInventory', {}, locale), schema: dispatchInventoryInputSchema,
      invoke: (input: unknown) => applications.inspectInventory(dispatchInventoryInputSchema.parse(input)) },
    { readOnly: true, destructive: false, idempotent: true, name: 'policy_vocabulary', description: t('mcp.tool.policyVocabulary', {}, locale), schema: z.object({}).strict(),
      invoke: async (input: unknown) => { z.object({}).strict().parse(input); return getPolicyVocabulary(); } },
  ];
  const renewApproval = applications.renewApproval;
  const inspectDecision = applications.inspectDecision;
  if (inspectDecision) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_decision',
    description: t('mcp.tool.inspectDecision', {}, locale), schema: decisionQuerySchema,
    invoke: input => inspectDecision.call(applications, decisionQuerySchema.parse(input)) });
  if (renewApproval) definitions.push({ readOnly: false, destructive: false, idempotent: true, openWorld: false, name: 'renew_approval',
    description: t('mcp.tool.renewApproval', {}, locale), schema: approvalRenewalSchema, boundedDelivery: true,
    invoke: (input, delivery) => renewApproval.call(applications, approvalRenewalSchema.parse(input), delivery) });
  const listApprovals = applications.listApprovals;
  if (listApprovals) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'list_approvals',
    description: t('mcp.tool.listApprovals', {}, locale), schema: approvalListSchema, boundedDelivery: true,
    invoke: (input, delivery) => listApprovals.call(applications, approvalListSchema.parse(input), delivery) });
  const inspectApproval = applications.inspectApproval;
  if (inspectApproval) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_approval',
    description: t('mcp.tool.inspectApproval', {}, locale), schema: approvalQuerySchema, boundedDelivery: true,
    invoke: (input, delivery) => inspectApproval.call(applications, approvalQuerySchema.parse(input), delivery) });
  const inspectDeclaredModels = applications.inspectDeclaredModels;
  if (inspectDeclaredModels) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'list_declared_models',
    description: t('mcp.tool.listDeclaredModels', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return inspectDeclaredModels.call(applications); } });
  const inspectModelBinding = applications.inspectModelBinding;
  if (inspectModelBinding) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_model_binding',
    description: t('mcp.tool.inspectModelBinding', {}, locale), schema: modelReferenceSchema,
    invoke: (input: unknown) => inspectModelBinding.call(applications, modelReferenceSchema.parse(input)) });
  const inspectToolchainCurrency = applications.inspectToolchainCurrency;
  if (inspectToolchainCurrency) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: true, name: 'inspect_toolchain_currency',
    description: t('mcp.tool.inspectToolchainCurrency', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return inspectToolchainCurrency.call(applications); } });
  const updateToolchains = applications.updateToolchains;
  const updateToolchainsSchema = z.object({ apply: z.boolean().optional() }).strict();
  // No commandId; a repeat apply plans/builds again and the receipt write uses O_EXCL (composition/core/toolchains/internal/update.ts:32), so a same-input replay is not a persisted no-op.
  if (updateToolchains) definitions.push({ readOnly: false, destructive: false, idempotent: false, openWorld: true, name: 'update_toolchains',
    description: t('mcp.tool.updateToolchains', {}, locale), schema: updateToolchainsSchema,
    invoke: (input: unknown) => updateToolchains.call(applications, updateToolchainsSchema.parse(input)) });
  const createRun = applications.createRun;
  if (createRun) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'create_run', description: t('mcp.tool.createRun', {}, locale),
    schema: runAdmissionSchema, invoke: (input: unknown) => createRun.call(applications, runAdmissionSchema.parse(input)) });
  const reserveRunTasks = applications.reserveRunTasks;
  if (reserveRunTasks) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'reserve_run_tasks', description: t('mcp.tool.reserveRunTasks', {}, locale),
    schema: runReservationCommandSchema, invoke: (input: unknown) => reserveRunTasks.call(applications, runReservationCommandSchema.parse(input)) });
  const requestCancellation = applications.requestRunCancellation;
  // Destructive but idempotent: adapters/core/attempt-store/internal/runs.ts:123 returns the commandId-keyed receipt on replay before any new mutation.
  if (requestCancellation) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'request_run_cancellation', description: t('mcp.tool.requestRunCancellation', {}, locale),
    schema: runCommandSchema, invoke: (input: unknown) => requestCancellation.call(applications, runCommandSchema.parse(input)) });
  const deliverCancellation = applications.deliverRunCancellation;
  // Per-attempt delivery re-dispatches while queued and nextEligibleAt<=now (engine/core/runs/internal/delivery-transition.ts:14-19): an identical call can still reach dispatch.cancel again.
  if (deliverCancellation) definitions.push({ readOnly: false, destructive: true, idempotent: false, name: 'deliver_run_cancellation', description: t('mcp.tool.deliverRunCancellation', {}, locale),
    schema: runCommandSchema, invoke: (input: unknown) => deliverCancellation.call(applications, runCommandSchema.parse(input)) });
  const reconcile = applications.reconcileAttempt;
  if (reconcile) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'reconcile_attempt', description: t('mcp.tool.reconcileAttempt', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => reconcile.call(applications, attemptIdentitySchema.parse(input)) });
  const executeTask = applications.executeTask;
  // Destructive but idempotent: composition/core/execution/internal/task.ts:24-27 returns the existing bound dispatch for the identity instead of relaunching a second container/process.
  if (executeTask) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: true, name: 'execute_task', description: t('mcp.tool.executeTask', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => executeTask.call(applications, attemptIdentitySchema.parse(input)) });
  const evaluateTask = applications.evaluateTask;
  if (evaluateTask) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'evaluate_task', description: t('mcp.tool.evaluateTask', {}, locale),
    schema: taskEvaluationCommandSchema, invoke: (input: unknown) => evaluateTask.call(applications, taskEvaluationCommandSchema.parse(input)) });
  const describeService = applications.describeService;
  if (describeService) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'runtime_service_descriptor',
    description: t('mcp.tool.runtimeServiceDescriptor', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return runtimeServiceDescriptorSchema.parse(await describeService.call(applications)); } });
  const shutdownService = applications.shutdownService;
  // Intent recording alone is replay-guarded, but the effect this tool names (service shutdown) happens outside this call and cannot be re-verified as a no-op; destructive default applies.
  if (shutdownService) definitions.push({ readOnly: false, destructive: true, idempotent: false, name: 'shutdown_runtime_service',
    description: t('mcp.tool.shutdownRuntimeService', {}, locale), schema: shutdownCommandSchema,
    invoke: (input: unknown) => shutdownService.call(applications, shutdownCommandSchema.parse(input)) });
  const inspectActivation = applications.inspectModelActivation;
  if (inspectActivation) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_model_activation',
    description: t('mcp.tool.inspectModelActivation', {}, locale), schema: modelActivationQuerySchema,
    invoke: input => inspectActivation.call(applications, modelActivationQuerySchema.parse(input)) });
  const admitActivation = applications.admitModelActivation;
  // Destructive but idempotent: engine/core/model-activation/internal/application.ts:28-32 returns the commandId-keyed receipt before the catalog/binding admission effect runs again.
  if (admitActivation) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'admit_model_activation',
    description: t('mcp.tool.admitModelActivation', {}, locale), schema: modelActivationCommandSchema,
    invoke: input => admitActivation.call(applications, modelActivationCommandSchema.parse(input)) });
  // WORKER-CURRENCY-2 parity: the ledger model catalog, the same application contract as CLI `models catalog` and SDK.
  const inspectCatalog = applications.inspectModelCatalog;
  if (inspectCatalog) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_model_catalog',
    description: t('mcp.tool.inspectModelCatalog', {}, locale), schema: modelCatalogQuerySchema,
    invoke: input => inspectCatalog.call(applications, modelCatalogQuerySchema.parse(input)) });
  const applyCatalog = applications.applyModelCatalog;
  // Destructive but idempotent: adapters/core/sqlite-model-activation/internal/catalog.ts SqliteModelCatalogStore.apply returns the (scope, commandId) receipt before any row is written again.
  if (applyCatalog) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'apply_model_catalog',
    description: t('mcp.tool.applyModelCatalog', {}, locale), schema: modelCatalogCommandSchema,
    invoke: input => applyCatalog.call(applications, modelCatalogCommandSchema.parse(input)) });
  const applyPoolCapacity = applications.applyPoolCapacity, inspectPoolCapacity = applications.inspectPoolCapacity;
  if (applyPoolCapacity) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'apply_pool_capacity', description: t('mcp.tool.applyPoolCapacity', {}, locale),
    schema: poolCapacityCommandSchema, invoke: input => applyPoolCapacity.call(applications, poolCapacityCommandSchema.parse(input)) });
  if (inspectPoolCapacity) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_pool_capacity', description: t('mcp.tool.inspectPoolCapacity', {}, locale),
    schema: poolHoldQuerySchema, invoke: input => inspectPoolCapacity.call(applications, poolHoldQuerySchema.parse(input)) });
  const inspectPoolHold = applications.inspectPoolHold, applyPoolHold = applications.applyPoolHold; // K5: same application as CLI `pool` and SDK
  if (inspectPoolHold) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_pool_hold', description: t('mcp.tool.inspectPoolHold', {}, locale),
    schema: poolHoldQuerySchema, invoke: input => inspectPoolHold.call(applications, poolHoldQuerySchema.parse(input)) });
  // Destructive but idempotent: adapters/core/attempt-store/internal/pool-holds.ts applyPoolHold returns the (scope, commandId) receipt before any row is written again.
  if (applyPoolHold) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'apply_pool_hold', description: t('mcp.tool.applyPoolHold', {}, locale),
    schema: poolHoldCommandSchema, invoke: input => applyPoolHold.call(applications, poolHoldCommandSchema.parse(input)) });
  const inspectInvocation = applications.inspectModelInvocation;
  if (inspectInvocation) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_model_invocation',
    description: t('mcp.tool.inspectModelInvocation', {}, locale), schema: modelInvocationQuerySchema, modelDelivery: true,
    invoke: (input, delivery) => inspectInvocation.call(applications, modelInvocationQuerySchema.parse(input), delivery) });
  const inspectProviderSpendAccount = applications.inspectProviderSpendAccount;
  if (inspectProviderSpendAccount) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_provider_spending',
    description: t('mcp.tool.inspectProviderSpending', {}, locale), schema: providerSpendAccountQuerySchema, boundedDelivery: true,
    invoke: (input, delivery) => inspectProviderSpendAccount.call(applications, providerSpendAccountQuerySchema.parse(input), delivery) });
  const auditProviderSpendAccount = applications.auditProviderSpendAccount;
  if (auditProviderSpendAccount) definitions.push({ readOnly: false, destructive: false, idempotent: true, openWorld: false, name: 'audit_provider_spending',
    description: t('mcp.tool.auditProviderSpending', {}, locale), schema: providerSpendAuditCommandSchema, boundedDelivery: true,
    invoke: (input, delivery) => auditProviderSpendAccount.call(applications, providerSpendAuditCommandInputSchema.parse(input), delivery) });
  const invokeModel = applications.invokeModel;
  // Destructive but idempotent: engine/core/model-invocation/internal/application.ts (invoke) returns store.loadReceipt(scopeId, commandId) before any provider call — "a replayed command never reaches the provider again".
  if (invokeModel) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: true, name: 'invoke_model',
    description: t('mcp.tool.invokeModel', {}, locale), schema: modelInvocationCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => invokeModel.call(applications, modelInvocationCommandSchema.parse(input), delivery) });
  const purgeContent = applications.purgeModelInvocationContent;
  if (purgeContent) definitions.push({ readOnly: false, destructive: true, idempotent: false, openWorld: false, name: 'purge_model_invocation_content',
    description: t('mcp.tool.purgeModelInvocationContent', {}, locale), schema: modelInvocationPurgeCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => purgeContent.call(applications, modelInvocationPurgeCommandSchema.parse(input), delivery) });
  const cancelInvocation = applications.cancelModelInvocation;
  // engine/core/model-invocation/internal/cancellation.ts:54-60 calls controllers.requestAbort(control) even when result.replayed===true: an additional local effect fires on repeat.
  if (cancelInvocation) definitions.push({ readOnly: false, destructive: true, idempotent: false, openWorld: false, name: 'cancel_model_invocation',
    description: t('mcp.tool.cancelModelInvocation', {}, locale), schema: modelInvocationCancellationCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => cancelInvocation.call(applications, modelInvocationCancellationCommandSchema.parse(input), delivery) });
  const inferenceInput = z.object({ profileId: z.string().min(1).optional() }).strict();
  const inferencePlan = applications.inferencePlan;
  if (inferencePlan) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inference_plan',
    description: t('mcp.tool.inferencePlan', {}, locale), schema: inferenceInput,
    invoke: (input: unknown) => {
      const parsed = inferenceInput.parse(input);
      return inferencePlan.call(applications, parsed.profileId === undefined ? {} : { profileId: parsed.profileId });
    } });
  const inferenceBudget = applications.inferenceBudget;
  if (inferenceBudget) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inference_budget',
    description: t('mcp.tool.inferenceBudget', {}, locale), schema: inferenceInput,
    invoke: (input: unknown) => {
      const parsed = inferenceInput.parse(input);
      return inferenceBudget.call(applications, parsed.profileId === undefined ? {} : { profileId: parsed.profileId });
    } });
  definitions.push(...operationToolDefinitions(applications, locale));
  // The SDK's Node default validator is its bundled ajv + fast-uri, which the published package replaces with a throwing stub (FASTURI-OUT);
  // Deckent's own validator is the only JSON Schema validator it ships (MCP-SCHEMA-VALIDATOR; no server path validates today, form elicitation would).
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} }, jsonSchemaValidator: new DeckentJsonSchemaValidator() }); let active = 0;
  const failure = (code: string): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code }) }] });
  const invocationLimit = (code: string): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text',
    text: JSON.stringify({ schemaVersion: 1, code, message: t('mcp.error.modelInvocationResultLimit', {}, locale) }) }] });
  server.setRequestHandler('tools/list', async () => ({ tools: definitions.map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}),
    // MCP requires an object root even when a native command is an object-only discriminated union.
    inputSchema: { ...zodToJsonSchema(tool.schema, { $refStrategy: 'none' }), type: 'object' } as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: tool.idempotent, openWorldHint: tool.openWorld ?? false },
  })) }));
  server.setRequestHandler('tools/call', async (request, context) => {
    const tool = definitions.find(value => value.name === request.params.name);
    if (!tool) return failure('MCP_TOOL_UNKNOWN');
    if (active >= limits.maxConcurrentCalls) return failure('MCP_BUSY');
    active++;
    try {
      let delivery: ModelInvocationDelivery | RuntimeServiceDelivery | undefined;
      if (tool.modelDelivery) delivery = modelToolDelivery(context.mcpReq.id, limits.responseMaxBytes);
      else if (tool.boundedDelivery) {
        const bounded = boundedToolDelivery(context.mcpReq.id, limits.responseMaxBytes);
        if (!bounded) return failure('MCP_RESPONSE_LIMIT');
        delivery = bounded;
      }
      const result = jsonToolResult(await tool.invoke(request.params.arguments ?? {}, delivery));
      if (!toolResultFits(context.mcpReq.id, result, limits.responseMaxBytes)) return tool.name === 'invoke_model' || tool.name === 'inspect_model_invocation'
        ? invocationLimit('MCP_RESPONSE_LIMIT') : failure('MCP_RESPONSE_LIMIT');
      return result;
    } catch (error) {
      if (error instanceof DeckentError && error.code === 'MODEL_INVOCATION_RESULT_LIMIT') return invocationLimit(error.code);
      if (tool.boundedDelivery && error instanceof DeckentError && error.code === 'RUNTIME_SERVICE_RESPONSE_LIMIT') return failure('MCP_RESPONSE_LIMIT');
      if (tool.name === 'audit_provider_spending' && error instanceof DeckentError && error.code === 'PROVIDER_SPEND_RESULT_LIMIT') return failure(error.code);
      return failure(error instanceof DeckentError ? error.code : error instanceof z.ZodError ? 'MCP_INPUT_INVALID' : 'MCP_TOOL_FAILED');
    }
    finally { active--; }
  });
  return server;
}
