import { approvalListSchema, approvalQuerySchema, approvalRenewalSchema, approvalCommandSchema } from '#engine/index.js';
import { boundedToolDelivery, completeToolResult, modelToolDelivery, toolResultFits } from './delivery.js';
import { modelActivationQuerySchema, modelActivationCommandSchema, modelInvocationCancellationCommandSchema, modelInvocationCommandSchema, modelInvocationPurgeCommandSchema, modelInvocationQuerySchema, providerSpendAccountQuerySchema, providerSpendAuditCommandInputSchema, providerSpendAuditCommandSchema,
  type ModelActivationQuery, type ModelActivationCommand, type ModelInvocationCancellationCommand, type ModelInvocationCommand, type ModelInvocationPurgeCommand, type ModelInvocationQuery, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import type { ModelActivationInspection, ModelActivationResult, ModelInvocationCancellationResult, ModelInvocationInspection, ModelInvocationPurgeResult, ModelInvocationResult, ModelInvocationDelivery, ProviderSpendAccountInspection, ProviderSpendAuditResult, RuntimeServiceDelivery } from '#engine/index.js';
import { attemptIdentitySchema, modelReferenceSchema, type AttemptIdentity, type ModelReference } from '#domain/index.js';
import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PACKAGE_NAME, PACKAGE_VERSION, DeckentError, t, type Locale } from '#platform/index.js';
import { runCommandSchema, runQuerySchema, dispatchInventoryInputSchema, getPolicyVocabulary, taskEvaluationCommandSchema,
  runAdmissionSchema, runReservationCommandSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema,
  type RunCommand, type RunQuery, type DispatchInventoryInput, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult,
  type ShutdownCommand, type TaskEvaluationCommand, type RunAdmission, type RunReservationCommand } from '#engine/index.js';
import type { DeclaredModelsInspection, ModelBindingInspection } from '#engine/index.js';
export interface McpApplications {
  renewApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  listApprovals?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  decideApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectModelActivation?(query: ModelActivationQuery): Promise<ModelActivationInspection>;
  admitModelActivation?(command: ModelActivationCommand): Promise<ModelActivationResult>;
  inspectModelInvocation?(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
  invokeModel?(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationResult>;
  purgeModelInvocationContent?(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  cancelModelInvocation?(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  inspectProviderSpendAccount?(query: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAccountInspection>;
  auditProviderSpendAccount?(command: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAuditResult>;
  inspectDeclaredModels?(): Promise<DeclaredModelsInspection>;
  inspectModelBinding?(reference: ModelReference): Promise<ModelBindingInspection>;
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
}
export interface McpLimits { maxConcurrentCalls: number; responseMaxBytes: number }
/** Local protocol surface. Injected applications own identity, policy and data access.
 * Mutators are advertised only when composition explicitly supplies their application handler. */
export function createMcpServer(applications: McpApplications, limits: McpLimits, locale: Locale) {
  z.object({ maxConcurrentCalls: z.number().int().positive().safe(), responseMaxBytes: z.number().int().positive().safe() }).strict().parse(limits);
  const definitions: { readOnly: boolean; destructive: boolean; openWorld?: boolean; name: string; description: string; schema: z.ZodTypeAny; modelDelivery?: boolean; boundedDelivery?: boolean; invoke(input: unknown, delivery?: ModelInvocationDelivery | RuntimeServiceDelivery): Promise<unknown> }[] = [
    { readOnly: true, destructive: false, name: 'inspect_run', description: t('mcp.tool.inspectRun', {}, locale), schema: runQuerySchema,
      invoke: (input: unknown) => applications.inspectRun(runQuerySchema.parse(input)) },
    { readOnly: true, destructive: false, name: 'inspect_inventory', description: t('mcp.tool.inspectInventory', {}, locale), schema: dispatchInventoryInputSchema,
      invoke: (input: unknown) => applications.inspectInventory(dispatchInventoryInputSchema.parse(input)) },
    { readOnly: true, destructive: false, name: 'policy_vocabulary', description: t('mcp.tool.policyVocabulary', {}, locale), schema: z.object({}).strict(),
      invoke: async (input: unknown) => { z.object({}).strict().parse(input); return getPolicyVocabulary(); } },
  ];
  const renewApproval = applications.renewApproval;
  if (renewApproval) definitions.push({ readOnly: false, destructive: false, openWorld: false, name: 'renew_approval',
    description: t('mcp.tool.renewApproval', {}, locale), schema: approvalRenewalSchema, boundedDelivery: true,
    invoke: (input, delivery) => renewApproval.call(applications, approvalRenewalSchema.parse(input), delivery) });
  const listApprovals = applications.listApprovals;
  if (listApprovals) definitions.push({ readOnly: true, destructive: false, openWorld: false, name: 'list_approvals',
    description: t('mcp.tool.listApprovals', {}, locale), schema: approvalListSchema, boundedDelivery: true,
    invoke: (input, delivery) => listApprovals.call(applications, approvalListSchema.parse(input), delivery) });
  const inspectApproval = applications.inspectApproval;
  if (inspectApproval) definitions.push({ readOnly: true, destructive: false, openWorld: false, name: 'inspect_approval',
    description: t('mcp.tool.inspectApproval', {}, locale), schema: approvalQuerySchema, boundedDelivery: true,
    invoke: (input, delivery) => inspectApproval.call(applications, approvalQuerySchema.parse(input), delivery) });
  const decideApproval = applications.decideApproval;
  if (decideApproval) definitions.push({ readOnly: false, destructive: false, openWorld: false, name: 'decide_approval',
    description: t('mcp.tool.decideApproval', {}, locale), schema: approvalCommandSchema, boundedDelivery: true,
    invoke: (input, delivery) => decideApproval.call(applications, approvalCommandSchema.parse(input), delivery) });
  const inspectDeclaredModels = applications.inspectDeclaredModels;
  if (inspectDeclaredModels) definitions.push({ readOnly: true, destructive: false, name: 'list_declared_models',
    description: t('mcp.tool.listDeclaredModels', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return inspectDeclaredModels.call(applications); } });
  const inspectModelBinding = applications.inspectModelBinding;
  if (inspectModelBinding) definitions.push({ readOnly: true, destructive: false, name: 'inspect_model_binding',
    description: t('mcp.tool.inspectModelBinding', {}, locale), schema: modelReferenceSchema,
    invoke: (input: unknown) => inspectModelBinding.call(applications, modelReferenceSchema.parse(input)) });
  const createRun = applications.createRun;
  if (createRun) definitions.push({ readOnly: false, destructive: false, name: 'create_run', description: t('mcp.tool.createRun', {}, locale),
    schema: runAdmissionSchema, invoke: (input: unknown) => createRun.call(applications, runAdmissionSchema.parse(input)) });
  const reserveRunTasks = applications.reserveRunTasks;
  if (reserveRunTasks) definitions.push({ readOnly: false, destructive: false, name: 'reserve_run_tasks', description: t('mcp.tool.reserveRunTasks', {}, locale),
    schema: runReservationCommandSchema, invoke: (input: unknown) => reserveRunTasks.call(applications, runReservationCommandSchema.parse(input)) });
  const requestCancellation = applications.requestRunCancellation;
  if (requestCancellation) definitions.push({ readOnly: false, destructive: true, name: 'request_run_cancellation', description: t('mcp.tool.requestRunCancellation', {}, locale),
    schema: runCommandSchema, invoke: (input: unknown) => requestCancellation.call(applications, runCommandSchema.parse(input)) });
  const deliverCancellation = applications.deliverRunCancellation;
  if (deliverCancellation) definitions.push({ readOnly: false, destructive: true, name: 'deliver_run_cancellation', description: t('mcp.tool.deliverRunCancellation', {}, locale),
    schema: runCommandSchema, invoke: (input: unknown) => deliverCancellation.call(applications, runCommandSchema.parse(input)) });
  const reconcile = applications.reconcileAttempt;
  if (reconcile) definitions.push({ readOnly: false, destructive: false, name: 'reconcile_attempt', description: t('mcp.tool.reconcileAttempt', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => reconcile.call(applications, attemptIdentitySchema.parse(input)) });
  const executeTask = applications.executeTask;
  if (executeTask) definitions.push({ readOnly: false, destructive: true, openWorld: true, name: 'execute_task', description: t('mcp.tool.executeTask', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => executeTask.call(applications, attemptIdentitySchema.parse(input)) });
  const evaluateTask = applications.evaluateTask;
  if (evaluateTask) definitions.push({ readOnly: false, destructive: false, name: 'evaluate_task', description: t('mcp.tool.evaluateTask', {}, locale),
    schema: taskEvaluationCommandSchema, invoke: (input: unknown) => evaluateTask.call(applications, taskEvaluationCommandSchema.parse(input)) });
  const describeService = applications.describeService;
  if (describeService) definitions.push({ readOnly: true, destructive: false, name: 'runtime_service_descriptor',
    description: t('mcp.tool.runtimeServiceDescriptor', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return runtimeServiceDescriptorSchema.parse(await describeService.call(applications)); } });
  const shutdownService = applications.shutdownService;
  if (shutdownService) definitions.push({ readOnly: false, destructive: true, name: 'shutdown_runtime_service',
    description: t('mcp.tool.shutdownRuntimeService', {}, locale), schema: shutdownCommandSchema,
    invoke: (input: unknown) => shutdownService.call(applications, shutdownCommandSchema.parse(input)) });
  const inspectActivation = applications.inspectModelActivation;
  if (inspectActivation) definitions.push({ readOnly: true, destructive: false, name: 'inspect_model_activation',
    description: t('mcp.tool.inspectModelActivation', {}, locale), schema: modelActivationQuerySchema,
    invoke: input => inspectActivation.call(applications, modelActivationQuerySchema.parse(input)) });
  const admitActivation = applications.admitModelActivation;
  if (admitActivation) definitions.push({ readOnly: false, destructive: true, name: 'admit_model_activation',
    description: t('mcp.tool.admitModelActivation', {}, locale), schema: modelActivationCommandSchema,
    invoke: input => admitActivation.call(applications, modelActivationCommandSchema.parse(input)) });
  const inspectInvocation = applications.inspectModelInvocation;
  if (inspectInvocation) definitions.push({ readOnly: true, destructive: false, name: 'inspect_model_invocation',
    description: t('mcp.tool.inspectModelInvocation', {}, locale), schema: modelInvocationQuerySchema, modelDelivery: true,
    invoke: (input, delivery) => inspectInvocation.call(applications, modelInvocationQuerySchema.parse(input), delivery) });
  const inspectProviderSpendAccount = applications.inspectProviderSpendAccount;
  if (inspectProviderSpendAccount) definitions.push({ readOnly: true, destructive: false, openWorld: false, name: 'inspect_provider_spending',
    description: t('mcp.tool.inspectProviderSpending', {}, locale), schema: providerSpendAccountQuerySchema, boundedDelivery: true,
    invoke: (input, delivery) => inspectProviderSpendAccount.call(applications, providerSpendAccountQuerySchema.parse(input), delivery) });
  const auditProviderSpendAccount = applications.auditProviderSpendAccount;
  if (auditProviderSpendAccount) definitions.push({ readOnly: false, destructive: false, openWorld: false, name: 'audit_provider_spending',
    description: t('mcp.tool.auditProviderSpending', {}, locale), schema: providerSpendAuditCommandSchema, boundedDelivery: true,
    invoke: (input, delivery) => auditProviderSpendAccount.call(applications, providerSpendAuditCommandInputSchema.parse(input), delivery) });
  const invokeModel = applications.invokeModel;
  if (invokeModel) definitions.push({ readOnly: false, destructive: true, openWorld: true, name: 'invoke_model',
    description: t('mcp.tool.invokeModel', {}, locale), schema: modelInvocationCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => invokeModel.call(applications, modelInvocationCommandSchema.parse(input), delivery) });
  const purgeContent = applications.purgeModelInvocationContent;
  if (purgeContent) definitions.push({ readOnly: false, destructive: true, openWorld: false, name: 'purge_model_invocation_content',
    description: t('mcp.tool.purgeModelInvocationContent', {}, locale), schema: modelInvocationPurgeCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => purgeContent.call(applications, modelInvocationPurgeCommandSchema.parse(input), delivery) });
  const cancelInvocation = applications.cancelModelInvocation;
  if (cancelInvocation) definitions.push({ readOnly: false, destructive: true, openWorld: false, name: 'cancel_model_invocation',
    description: t('mcp.tool.cancelModelInvocation', {}, locale), schema: modelInvocationCancellationCommandSchema, modelDelivery: true,
    invoke: (input, delivery) => cancelInvocation.call(applications, modelInvocationCancellationCommandSchema.parse(input), delivery) });
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} } }); let active = 0;
  const failure = (code: string): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code }) }] });
  const invocationLimit = (code: string): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text',
    text: JSON.stringify({ schemaVersion: 1, code, message: t('mcp.error.modelInvocationResultLimit', {}, locale) }) }] });
  server.setRequestHandler('tools/list', async () => ({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description,
    // MCP requires an object root even when a native command is an object-only discriminated union.
    inputSchema: { ...zodToJsonSchema(tool.schema, { $refStrategy: 'none' }), type: 'object' } as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: true, openWorldHint: tool.openWorld ?? false },
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
      const value = await tool.invoke(request.params.arguments ?? {}, delivery); const encoded = JSON.stringify(value);
      const result = completeToolResult({ content: [{ type: 'text', text: encoded }], structuredContent: JSON.parse(encoded) as Record<string, unknown> });
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
