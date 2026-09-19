import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PACKAGE_NAME, PACKAGE_VERSION, DeckentError, t, type Locale } from '#platform/index.js';
import { runCommandSchema, runQuerySchema, dispatchInventoryInputSchema, getPolicyVocabulary, taskEvaluationCommandSchema,
  runAdmissionSchema, runReservationCommandSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema,
  type RunCommand, type RunQuery, type DispatchInventoryInput, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult,
  type ShutdownCommand, type TaskEvaluationCommand, type RunAdmission, type RunReservationCommand } from '#engine/index.js';
import type { DeclaredModelsInspection } from '#engine/index.js';
export interface McpApplications {
  inspectDeclaredModels?(): Promise<DeclaredModelsInspection>;
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
  const definitions: { readOnly: boolean; destructive: boolean; openWorld?: boolean; name: string; description: string; schema: z.ZodTypeAny; invoke(input: unknown): Promise<unknown> }[] = [
    { readOnly: true, destructive: false, name: 'inspect_run', description: t('mcp.tool.inspectRun', {}, locale), schema: runQuerySchema,
      invoke: (input: unknown) => applications.inspectRun(runQuerySchema.parse(input)) },
    { readOnly: true, destructive: false, name: 'inspect_inventory', description: t('mcp.tool.inspectInventory', {}, locale), schema: dispatchInventoryInputSchema,
      invoke: (input: unknown) => applications.inspectInventory(dispatchInventoryInputSchema.parse(input)) },
    { readOnly: true, destructive: false, name: 'policy_vocabulary', description: t('mcp.tool.policyVocabulary', {}, locale), schema: z.object({}).strict(),
      invoke: async (input: unknown) => { z.object({}).strict().parse(input); return getPolicyVocabulary(); } },
  ];
  const inspectDeclaredModels = applications.inspectDeclaredModels;
  if (inspectDeclaredModels) definitions.push({ readOnly: true, destructive: false, name: 'list_declared_models',
    description: t('mcp.tool.listDeclaredModels', {}, locale), schema: z.object({}).strict(),
    invoke: async (input: unknown) => { z.object({}).strict().parse(input); return inspectDeclaredModels.call(applications); } });
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
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} } }); let active = 0;
  const failure = (code: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, code }) }] });
  server.setRequestHandler('tools/list', async () => ({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema, { $refStrategy: 'none' }) as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: true, openWorldHint: tool.openWorld ?? false },
  })) }));
  server.setRequestHandler('tools/call', async request => {
    const tool = definitions.find(value => value.name === request.params.name);
    if (!tool) return failure('MCP_TOOL_UNKNOWN');
    if (active >= limits.maxConcurrentCalls) return failure('MCP_BUSY');
    active++;
    try {
      const value = await tool.invoke(request.params.arguments ?? {}); const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, 'utf8') > limits.responseMaxBytes) return failure('MCP_RESPONSE_LIMIT');
      return { content: [{ type: 'text', text: encoded }], structuredContent: JSON.parse(encoded) as Record<string, unknown> };
    } catch (error) { return failure(error instanceof DeckentError ? error.code : error instanceof z.ZodError ? 'MCP_INPUT_INVALID' : 'MCP_TOOL_FAILED'); }
    finally { active--; }
  });
  return server;
}
