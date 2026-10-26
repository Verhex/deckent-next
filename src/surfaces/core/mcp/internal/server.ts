import { hubToolDefinitions } from './hub-tools.js';
import type { HubOperationHandler } from '#engine/index.js';
import { queueQuerySchema, queueListSchema, type QueueQuery, type QueueList } from '#engine/index.js';
import { auditVerifyQuerySchema, type AuditVerifyQuery, type AuditVerification } from '#domain/index.js';
import { runProposalSchema, type RunProposal } from '#domain/index.js';
import { brainPlanCommandSchema, type BrainPlanCommand } from '#domain/index.js';
import { runProposalQuerySchema, type RunProposalQuery } from '#engine/index.js';
import { AuditError, providerSpendManagementCommandSchema, parseProviderSpendManagementCommand, type ProviderSpendManagementCommand } from '#domain/index.js';
import type { ProviderSpendManagementResult } from '#engine/index.js';
import type { MonitorQuery, MonitorSnapshot } from '#engine/index.js';
import { approvalListSchema, approvalQuerySchema, approvalRenewalSchema, checkModelIngressArguments, projectModelIngressSchema, type ModelIngressProjection } from '#engine/index.js';
import { boundedToolDelivery, completeToolResult, jsonToolResult, modelToolDelivery, toolResultFits } from './delivery.js';
import { operationToolDefinitions } from './operation-tools.js';
import { rootObjectSchema } from './input-schema.js';
import { mcpMonitorQuerySchema, monitorCollectionQuery, projectMonitorForMcp } from './monitor-page.js';
import { isMcpWithheldTool } from './tool-inventory.js';
import { modelActivationQuerySchema, modelActivationCommandSchema, modelCatalogCommandSchema, modelCatalogQuerySchema, modelInvocationCancellationCommandSchema, modelInvocationCommandSchema, modelInvocationPurgeCommandSchema, modelInvocationQuerySchema, providerSpendExactAccountQuerySchema, providerSpendAuditCommandInputSchema, providerSpendAuditCommandSchema,
  type ModelActivationQuery, type ModelActivationCommand, type ModelCatalogCommand, type ModelCatalogQuery, type ModelInvocationCancellationCommand, type ModelInvocationCommand, type ModelInvocationPurgeCommand, type ModelInvocationQuery, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import type { ModelActivationInspection, ModelActivationResult, ModelCatalogInspection, ModelCatalogResult, ModelInvocationCancellationResult, ModelInvocationInspection, ModelInvocationPurgeResult, ModelInvocationResult, ModelInvocationDelivery, ProviderSpendAccountInspection, ProviderSpendAuditResult, RuntimeServiceDelivery } from '#engine/index.js';
import { attemptIdentitySchema, modelConnectCommandSchema, modelReferenceSchema, type ModelConnectCommand, type ModelConnectResult, type AttemptIdentity, type ModelReference, type EffectCommand, type OperationDescriptor } from '#domain/index.js';
import { Server, type Tool, type CallToolResult, type RequestId } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PACKAGE_NAME, PACKAGE_VERSION, DeckentError, ErrorRegistry, queryErrorClientParams, redactSensitive, DeckentJsonSchemaValidator, t, type Locale } from '#platform/index.js';
import { runControlCommandSchema, type RunLifecycleCommand, runCommandSchema, runQuerySchema, dispatchInventoryInputSchema, getPolicyVocabulary, taskEvaluationCommandSchema,
  runAdmissionSchema, runReservationCommandSchema, runtimeServiceDescriptorSchema, shutdownCommandSchema, type RuntimeOperationQuery,
  type RunCommand, type RunQuery, type DispatchInventoryInput, type RuntimeServiceDescriptor, type ServiceShutdownAdmissionResult,
  type ShutdownCommand, type TaskEvaluationCommand, type RunAdmission, type RunReservationCommand } from '#engine/index.js';
import type { DeclaredModelsInspection, ModelBindingInspection, ToolchainCurrencyReport } from '#engine/index.js';
import { quotaReleaseCommandSchema, type QuotaReleaseCommand, type QuotaReleaseReceipt, poolCapacityCommandSchema, type PoolCapacityCommand, type PoolCapacityReceipt, type PoolCapacityView, poolHoldCommandSchema, poolHoldQuerySchema, type PoolHoldCommand, type PoolHoldQuery, type PoolHoldReceipt, type PoolHoldView } from '#engine/index.js';
import { decisionQuerySchema, type DecisionQuery, type DecisionInspection } from '#engine/index.js';
import { memoryListQuerySchema, memorySearchQuerySchema, memoryInspectQuerySchema, type MemoryListQuery, type MemoryListing, type MemorySearchQuery, type MemorySearchResult, type MemoryInspectQuery, type MemoryInspection } from '#engine/index.js';
import { agentListQuerySchema, agentInspectQuerySchema, skillListQuerySchema, skillInspectQuerySchema, type AgentListQuery, type AgentListing, type AgentInspectQuery,
  type AgentInspection, type SkillListQuery, type SkillListing, type SkillInspectQuery, type SkillInspection, agentStatsQuerySchema, type AgentStatsQuery, type AgentStatsView,
  suggestionListQuerySchema, suggestionInspectQuerySchema, agentDefineCommandSchema, skillDefineCommandSchema, skillImportCommandSchema, standingChangeCommandSchema, suggestionDismissCommandSchema,
  type CatalogSuggestionListing, type CatalogSuggestionInspection } from '#engine/index.js';
import { policyAdministrationQuerySchema, type PolicyAdministrationQuery, type PolicyAdministrationStatus } from '#engine/index.js';
import { modelRoleQuerySchema, type ModelRoleInspection, type ModelRoleQuery } from '#engine/index.js';
export interface McpApplications {
  executeHub?: HubOperationHandler;
  inspectTargetQueue?(query: QueueQuery): Promise<unknown>;
  listTargetQueue?(query: QueueList): Promise<unknown>;
  verifyAudit?(query: AuditVerifyQuery): Promise<AuditVerification>;
  inspectPolicyAdministration?(query: PolicyAdministrationQuery): Promise<PolicyAdministrationStatus>;
  planRun?(command: BrainPlanCommand): Promise<unknown>;
  /** Composition records only sealed digests under the authenticated MCP principal, never decoded text. */
  recordModelIngress?(notice: ModelIngressProjection, input: unknown): Promise<void>;
  inspectMonitor?(query: MonitorQuery): Promise<MonitorSnapshot>;
  inspectDecision?(query: DecisionQuery): Promise<DecisionInspection>;
  /** S4 memory journal v1: read-only; a failed read answers `held`, never an empty memory. */
  listMemory?(query: MemoryListQuery): Promise<MemoryListing>; searchMemory?(query: MemorySearchQuery): Promise<MemorySearchResult>; inspectMemory?(query: MemoryInspectQuery): Promise<MemoryInspection>;
  /** S7 agent/skill catalog: read-only; creating, revising and importing stay a person's terminal card. */
  listAgents?(query: AgentListQuery): Promise<AgentListing>; inspectAgent?(query: AgentInspectQuery): Promise<AgentInspection>;
  /** S8-2 agent statistics: the same `agent-catalog`/`inspect` read; numbers are associations and acceptance rates (labels on the view). */
  inspectAgentStats?(query: AgentStatsQuery): Promise<AgentStatsView>;
  listSkills?(query: SkillListQuery): Promise<SkillListing>; inspectSkill?(query: SkillInspectQuery): Promise<SkillInspection>;
  /** S8-3/S8-4: the catalog's sealed suggestions (refs, digests, counts; never draft or lesson text; lesson refs only where the MCP actor may read them). */
  listAgentSuggestions?(query: unknown): Promise<CatalogSuggestionListing>; inspectAgentSuggestion?(query: unknown): Promise<CatalogSuggestionInspection>;
  /** S8-4 the signed AI command path: define, import, standing and dismiss only with the MCP actor's own active key and a policy grant (a standing action:
   * a grant naming that WorkClass); verified again at commit. AI grants are empty by default. */
  signedDefineAgent?(command: unknown): Promise<unknown>; signedDefineSkill?(command: unknown): Promise<unknown>; signedImportSkill?(command: unknown): Promise<unknown>;
  signedChangeStanding?(command: unknown): Promise<unknown>; signedDismissSuggestion?(command: unknown): Promise<unknown>;
  renewApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  listApprovals?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectApproval?(input: unknown, delivery?: RuntimeServiceDelivery): Promise<unknown>;
  inspectModelActivation?(query: ModelActivationQuery): Promise<ModelActivationInspection>;
  admitModelActivation?(command: ModelActivationCommand): Promise<ModelActivationResult>;
  inspectModelCatalog?(query: ModelCatalogQuery): Promise<ModelCatalogInspection>;
  applyModelCatalog?(command: ModelCatalogCommand): Promise<ModelCatalogResult>;
  /** M2: which exact catalog model serves which role (pending = no row, every role refuses it). Read-only: assigning stays a person's terminal card. */
  inspectModelRoles?(query: ModelRoleQuery): Promise<ModelRoleInspection>;
  /** T4-B `models.connect`: the same application as CLI `models connect`, SDK `connectModel` and the terminal (secret names only, never a value). */
  connectModel?(command: ModelConnectCommand): Promise<ModelConnectResult>;
  releaseQuota?(command: QuotaReleaseCommand): Promise<QuotaReleaseReceipt>;
  inspectPoolCapacity?(query: PoolHoldQuery): Promise<PoolCapacityView>;
  applyPoolCapacity?(command: PoolCapacityCommand): Promise<PoolCapacityReceipt>;
  inspectPoolHold?(query: PoolHoldQuery): Promise<PoolHoldView>;
  applyPoolHold?(command: PoolHoldCommand): Promise<PoolHoldReceipt>;
  inspectModelInvocation?(query: ModelInvocationQuery, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection>;
  invokeModel?(command: ModelInvocationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationResult>;
  purgeModelInvocationContent?(command: ModelInvocationPurgeCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult>;
  cancelModelInvocation?(command: ModelInvocationCancellationCommand, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult>;
  inspectProviderSpendAccount?(query: ProviderSpendAccountQuery, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAccountInspection>;
  manageProviderSpend?(command: ProviderSpendManagementCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendManagementResult>;
  auditProviderSpendAccount?(command: ProviderSpendAuditCommand, delivery?: RuntimeServiceDelivery): Promise<ProviderSpendAuditResult>;
  inspectDeclaredModels?(): Promise<DeclaredModelsInspection>;
  inspectModelBinding?(reference: ModelReference): Promise<ModelBindingInspection>;
  inspectToolchainCurrency?(): Promise<ToolchainCurrencyReport>;
  updateToolchains?(input: Readonly<{ apply?: boolean | undefined }>): Promise<unknown>;
  proposeRun?(command: RunProposal): Promise<unknown>;
  inspectRunProposal?(query: RunProposalQuery): Promise<unknown>;
  createRun?(command: RunAdmission): Promise<unknown>;
  applyRunControl?(command: Extract<RunLifecycleCommand, { action: 'hold' | 'close' | 'resume' }>): Promise<unknown>;
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
  const definitions: { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld?: boolean; name: string; description: string; schema: z.ZodTypeAny; modelDelivery?: boolean; boundedDelivery?: boolean; invoke(input: unknown, delivery?: ModelInvocationDelivery | RuntimeServiceDelivery, signal?: AbortSignal): Promise<unknown> }[] = [
    { readOnly: true, destructive: false, idempotent: true, name: 'inspect_run', description: t('mcp.tool.inspectRun', {}, locale), schema: runQuerySchema,
      invoke: (input: unknown) => applications.inspectRun(runQuerySchema.parse(input)) },
    { readOnly: true, destructive: false, idempotent: true, name: 'inspect_inventory', description: t('mcp.tool.inspectInventory', {}, locale), schema: dispatchInventoryInputSchema,
      invoke: (input: unknown) => applications.inspectInventory(dispatchInventoryInputSchema.parse(input)) },
    { readOnly: true, destructive: false, idempotent: true, name: 'policy_vocabulary', description: t('mcp.tool.policyVocabulary', {}, locale), schema: z.object({}).strict(),
      invoke: async (input: unknown) => { z.object({}).strict().parse(input); return getPolicyVocabulary(); } },
  ];
  definitions.push(...hubToolDefinitions(applications.executeHub, locale));
  if (applications.inspectTargetQueue) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_delivery_queue', description: t('mcp.tool.inspectTargetQueue', {}, locale), schema: queueQuerySchema,
    invoke: input => applications.inspectTargetQueue!(queueQuerySchema.parse(input)) });
  if (applications.listTargetQueue) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'list_delivery_queue', description: t('mcp.tool.listTargetQueue', {}, locale), schema: queueListSchema,
    invoke: input => applications.listTargetQueue!(queueListSchema.parse(input)) });
  const verifyAudit = applications.verifyAudit;
  if (verifyAudit) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'verify_audit',
    description: t('mcp.tool.verifyAudit', {}, locale), schema: auditVerifyQuerySchema,
    invoke: input => verifyAudit(auditVerifyQuerySchema.parse(input)) });
  const renewApproval = applications.renewApproval;
  const inspectMonitor = applications.inspectMonitor;
  if (inspectMonitor) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_monitor',
    description: t('mcp.tool.inspectMonitor', {}, locale), schema: mcpMonitorQuerySchema,
    invoke: async input => { const query = mcpMonitorQuerySchema.parse(input); return projectMonitorForMcp(await inspectMonitor.call(applications, monitorCollectionQuery(query)), query); } });
  const inspectDecision = applications.inspectDecision;
  if (inspectDecision) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_decision',
    description: t('mcp.tool.inspectDecision', {}, locale), schema: decisionQuerySchema,
    invoke: input => inspectDecision.call(applications, decisionQuerySchema.parse(input)) });
  const { listMemory, searchMemory, inspectMemory } = applications;
  if (listMemory) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'list_memory', description: t('mcp.tool.listMemory', {}, locale),
    schema: memoryListQuerySchema, invoke: input => listMemory.call(applications, memoryListQuerySchema.parse(input)) });
  if (searchMemory) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'search_memory', description: t('mcp.tool.searchMemory', {}, locale),
    schema: memorySearchQuerySchema, invoke: input => searchMemory.call(applications, memorySearchQuerySchema.parse(input)) });
  if (inspectMemory) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_memory', description: t('mcp.tool.inspectMemory', {}, locale),
    schema: memoryInspectQuerySchema, invoke: input => inspectMemory.call(applications, memoryInspectQuerySchema.parse(input)) });
  for (const [name, description, schema, invoke] of [['list_agents', t('mcp.tool.listAgents', {}, locale), agentListQuerySchema, applications.listAgents],
    ['inspect_agent', t('mcp.tool.inspectAgent', {}, locale), agentInspectQuerySchema, applications.inspectAgent], ['list_skills', t('mcp.tool.listSkills', {}, locale), skillListQuerySchema, applications.listSkills],
    ['inspect_skill', t('mcp.tool.inspectSkill', {}, locale), skillInspectQuerySchema, applications.inspectSkill],
    ['inspect_agent_stats', t('mcp.tool.inspectAgentStats', {}, locale), agentStatsQuerySchema, applications.inspectAgentStats],
    ['list_agent_suggestions', t('mcp.tool.listAgentSuggestions', {}, locale), suggestionListQuerySchema, applications.listAgentSuggestions],
    ['inspect_agent_suggestion', t('mcp.tool.inspectAgentSuggestion', {}, locale), suggestionInspectQuerySchema, applications.inspectAgentSuggestion]] as const) {
    if (invoke) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name, description, schema,
      invoke: input => (invoke as (query: unknown) => Promise<unknown>).call(applications, schema.parse(input)) });
  }
  // S8-4: the signed catalog writes (one typed command each, the same schemas as the person's cards; the signature is made by the host signer for the MCP actor's
  // own enrolled key, or carried in `signed` from its external key).
  for (const [name, description, schema, invoke] of [['define_agent', t('mcp.tool.signedDefineAgent', {}, locale), agentDefineCommandSchema, applications.signedDefineAgent],
    ['define_skill', t('mcp.tool.signedDefineSkill', {}, locale), skillDefineCommandSchema, applications.signedDefineSkill],
    ['import_skill', t('mcp.tool.signedImportSkill', {}, locale), skillImportCommandSchema, applications.signedImportSkill],
    ['change_agent_standing', t('mcp.tool.signedChangeStanding', {}, locale), standingChangeCommandSchema, applications.signedChangeStanding],
    ['dismiss_agent_suggestion', t('mcp.tool.signedDismissSuggestion', {}, locale), suggestionDismissCommandSchema, applications.signedDismissSuggestion]] as const) {
    if (invoke) definitions.push({ readOnly: false, destructive: false, idempotent: true, openWorld: false, name, description, schema,
      invoke: input => (invoke as (command: unknown) => Promise<unknown>).call(applications, schema.parse(input)) });
  }
  if (applications.inspectPolicyAdministration) definitions.push({ readOnly: true, destructive: false, idempotent: true, openWorld: false, name: 'inspect_policy_administration',
    description: t('mcp.tool.policyAdministration', {}, locale), schema: policyAdministrationQuerySchema,
    invoke: input => applications.inspectPolicyAdministration!(policyAdministrationQuerySchema.parse(input)) });
  if (renewApproval) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: false, name: 'renew_approval',
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
  if (updateToolchains) definitions.push({ readOnly: false, destructive: true, idempotent: false, openWorld: true, name: 'update_toolchains',
    description: t('mcp.tool.updateToolchains', {}, locale), schema: updateToolchainsSchema,
    invoke: (input: unknown) => updateToolchains.call(applications, updateToolchainsSchema.parse(input)) });
  const proposeRun = applications.proposeRun, inspectProposal = applications.inspectRunProposal;
  const planRun = applications.planRun;
  if (planRun) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'plan_run', description: t('mcp.tool.planRun', {}, locale),
    schema: brainPlanCommandSchema, invoke: input => planRun.call(applications, brainPlanCommandSchema.parse(input)) });
  // D2b: MCP is an AI actor and never grants a delivery intent, so it is not advertised; a `delivery` key is MCP_INPUT_INVALID (the engine refuses it too).
  const mcpProposal = runProposalSchema.unwrap().omit({ delivery: true }).strict().readonly();
  if (proposeRun) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'propose_run', description: t('mcp.tool.proposeRun', {}, locale),
    schema: mcpProposal, invoke: input => proposeRun.call(applications, mcpProposal.parse(input)) });
  if (inspectProposal) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_run_proposal', description: t('mcp.tool.inspectRunProposal', {}, locale),
    schema: runProposalQuerySchema, invoke: input => inspectProposal.call(applications, runProposalQuerySchema.parse(input)) });
  const createRun = applications.createRun;
  if (createRun) definitions.push({ readOnly: false, destructive: false, idempotent: true, name: 'create_run', description: t('mcp.tool.createRun', {}, locale),
    schema: runAdmissionSchema, invoke: (input: unknown) => createRun.call(applications, runAdmissionSchema.parse(input)) });
  const reserveRunTasks = applications.reserveRunTasks;
  const runControl = applications.applyRunControl;
  if (runControl) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: false, name: 'control_run',
    description: t('mcp.tool.controlRun', {}, locale), schema: runControlCommandSchema,
    invoke: input => runControl.call(applications, runControlCommandSchema.parse(input)) });
  if (reserveRunTasks) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'reserve_run_tasks', description: t('mcp.tool.reserveRunTasks', {}, locale),
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
  if (reconcile) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'reconcile_attempt', description: t('mcp.tool.reconcileAttempt', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => reconcile.call(applications, attemptIdentitySchema.parse(input)) });
  const executeTask = applications.executeTask;
  // Destructive but idempotent: composition/core/execution/internal/task.ts:24-27 returns the existing bound dispatch for the identity instead of relaunching a second container/process.
  if (executeTask) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: true, name: 'execute_task', description: t('mcp.tool.executeTask', {}, locale),
    schema: attemptIdentitySchema, invoke: (input: unknown) => executeTask.call(applications, attemptIdentitySchema.parse(input)) });
  const evaluateTask = applications.evaluateTask;
  if (evaluateTask) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'evaluate_task', description: t('mcp.tool.evaluateTask', {}, locale),
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
  // M2 parity: the same read view as CLI `models roles` and doctor; there is no MCP write (a tier/role change needs the person's terminal).
  const inspectRoles = applications.inspectModelRoles;
  if (inspectRoles) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_model_roles',
    description: t('mcp.tool.inspectModelRoles', {}, locale), schema: modelRoleQuerySchema,
    invoke: input => inspectRoles.call(applications, modelRoleQuerySchema.parse(input)) });
  const applyCatalog = applications.applyModelCatalog;
  // Destructive but idempotent: adapters/core/sqlite-model-activation/internal/catalog.ts SqliteModelCatalogStore.apply returns the (scope, commandId) receipt before any row is written again.
  if (applyCatalog) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'apply_model_catalog',
    description: t('mcp.tool.applyModelCatalog', {}, locale), schema: modelCatalogCommandSchema,
    invoke: input => applyCatalog.call(applications, modelCatalogCommandSchema.parse(input)) });
  const connectModel = applications.connectModel;
  // Destructive but idempotent: every step of `models.connect` first checks what is in place, and each sub-write is keyed by the command id.
  if (connectModel) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'connect_model',
    description: t('mcp.tool.connectModel', {}, locale), schema: modelConnectCommandSchema,
    invoke: input => connectModel.call(applications, modelConnectCommandSchema.parse(input)) });
  const applyPoolCapacity = applications.applyPoolCapacity, inspectPoolCapacity = applications.inspectPoolCapacity;
  if (applyPoolCapacity) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'apply_pool_capacity', description: t('mcp.tool.applyPoolCapacity', {}, locale),
    schema: poolCapacityCommandSchema, invoke: input => applyPoolCapacity.call(applications, poolCapacityCommandSchema.parse(input)) });
  if (inspectPoolCapacity) definitions.push({ readOnly: true, destructive: false, idempotent: true, name: 'inspect_pool_capacity', description: t('mcp.tool.inspectPoolCapacity', {}, locale),
    schema: poolHoldQuerySchema, invoke: input => inspectPoolCapacity.call(applications, poolHoldQuerySchema.parse(input)) });
  const releaseQuota = applications.releaseQuota;
  if (releaseQuota) definitions.push({ readOnly: false, destructive: true, idempotent: true, name: 'release_quota', description: t('mcp.tool.releaseQuota', {}, locale),
    schema: quotaReleaseCommandSchema, invoke: input => releaseQuota.call(applications, quotaReleaseCommandSchema.parse(input)) });
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
    // The exact account revision (the stage 1 `current` form serves the terminal and CLI budget windows, not this tool's published schema).
    description: t('mcp.tool.inspectProviderSpending', {}, locale), schema: providerSpendExactAccountQuerySchema, boundedDelivery: true,
    invoke: (input, delivery) => inspectProviderSpendAccount.call(applications, providerSpendExactAccountQuerySchema.parse(input), delivery) });
  const manageProviderSpend = applications.manageProviderSpend;
  if (manageProviderSpend) definitions.push({ readOnly: false, destructive: true, idempotent: true, openWorld: false, name: 'manage_provider_spending',
    description: t('mcp.tool.manageProviderSpending', {}, locale), schema: providerSpendManagementCommandSchema, boundedDelivery: true,
    invoke: (input, delivery) => manageProviderSpend.call(applications, parseProviderSpendManagementCommand(input), delivery) });
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
  // hide_until_slice (owner 2026-10-18): a withheld tool is neither listed nor callable, even when composition supplies its application.
  definitions.splice(0, definitions.length, ...definitions.filter(tool => !isMcpWithheldTool(tool.name)));
  // The SDK's Node default validator is its bundled ajv + fast-uri, which the published package replaces with a throwing stub (FASTURI-OUT);
  // Deckent's own validator is the only JSON Schema validator it ships (MCP-SCHEMA-VALIDATOR; no server path validates today, form elicitation would).
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} }, jsonSchemaValidator: new DeckentJsonSchemaValidator() }); let active = 0;
  const coded = (body: Record<string, unknown>): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, ...body }) }] });
  // Ek A: the localized catalog message rides with the code, like the CLI (installation language; DeckentError text through its own localizer,
  // redacted; a zod or unexpected failure gets catalog text only, never its own message). An answer that would not fit drops back to the code.
  const failure = (id: RequestId, code: string, extra: { note?: string; error?: DeckentError; message?: string } = {}): CallToolResult => {
    const message = extra.message ?? (extra.error ? extra.error.localize?.(locale).message ?? extra.error.message : ErrorRegistry.get(code, locale)?.message);
    const full = coded({ code, ...(extra.note ? { note: extra.note } : {}), ...(message ? { message: redactSensitive(message) } : {}) });
    return toolResultFits(id, full, limits.responseMaxBytes) ? full : coded({ code });
  };
  const invocationLimit = (code: string): CallToolResult => completeToolResult({ isError: true, content: [{ type: 'text',
    text: JSON.stringify({ schemaVersion: 1, code, message: t('mcp.error.modelInvocationResultLimit', {}, locale) }) }] });
  server.setRequestHandler('tools/list', async () => ({ tools: await Promise.all(definitions.map(async tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}),
    // MCP requires an object root even when a native command is an object-only discriminated union.
    inputSchema: await projectModelIngressSchema(rootObjectSchema({ ...zodToJsonSchema(tool.schema, { $refStrategy: 'none' }), type: 'object' }),
      notice => applications.recordModelIngress ? applications.recordModelIngress(notice, {}) : Promise.reject(new AuditError('AUDIT_UNAVAILABLE'))) as Tool['inputSchema'],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, idempotentHint: tool.idempotent, openWorldHint: tool.openWorld ?? false },
  }))) }));
  server.setRequestHandler('tools/call', async (request, context) => {
    const tool = definitions.find(value => value.name === request.params.name), id = context.mcpReq.id;
    // The same answer for every unknown name (an unadvertised tool such as decide_approval is indistinguishable); the name is never echoed.
    if (!tool) return failure(id, 'MCP_TOOL_UNKNOWN', { message: t('mcp.error.toolUnknown', {}, locale) });
    if (active >= limits.maxConcurrentCalls) return failure(id, 'MCP_BUSY');
    active++;
    try {
      const args = request.params.arguments ?? {};
      const ingress = await checkModelIngressArguments(args, notice => applications.recordModelIngress
        ? applications.recordModelIngress(notice, args) : Promise.reject(new AuditError('AUDIT_UNAVAILABLE')));
      if (!ingress.ok) return failure(id, 'MCP_INPUT_INVALID', { note: ingress.text });
      let delivery: ModelInvocationDelivery | RuntimeServiceDelivery | undefined;
      if (tool.modelDelivery) delivery = modelToolDelivery(context.mcpReq.id, limits.responseMaxBytes);
      else if (tool.boundedDelivery) {
        const bounded = boundedToolDelivery(context.mcpReq.id, limits.responseMaxBytes);
        if (!bounded) return failure(id, 'MCP_RESPONSE_LIMIT');
        delivery = bounded;
      }
      const result = jsonToolResult(await tool.invoke(args, delivery, context.mcpReq.signal));
      if (!toolResultFits(context.mcpReq.id, result, limits.responseMaxBytes)) return tool.name === 'invoke_model' || tool.name === 'inspect_model_invocation'
        ? invocationLimit('MCP_RESPONSE_LIMIT') : failure(id, 'MCP_RESPONSE_LIMIT');
      return result;
    } catch (error) {
      if (error instanceof DeckentError && error.code === 'MODEL_INVOCATION_RESULT_LIMIT') return invocationLimit(error.code);
      if (tool.boundedDelivery && error instanceof DeckentError && error.code === 'RUNTIME_SERVICE_RESPONSE_LIMIT') return failure(id, 'MCP_RESPONSE_LIMIT');
      if (tool.name === 'audit_provider_spending' && error instanceof DeckentError && error.code === 'PROVIDER_SPEND_RESULT_LIMIT') return failure(id, error.code, { error });
      if (error instanceof DeckentError && error.code === 'QUERY_UNEXPECTED_FAILURE') {
        const params = queryErrorClientParams(error), message = redactSensitive(error.localize?.(locale).message ?? error.message);
        const result = coded({ code: error.code, ...(params ? { params } : {}), message });
        return toolResultFits(id, result, limits.responseMaxBytes) ? result : failure(id, 'MCP_RESPONSE_LIMIT');
      }
      return error instanceof DeckentError ? failure(id, error.code, { error }) : failure(id, error instanceof z.ZodError ? 'MCP_INPUT_INVALID' : 'MCP_TOOL_FAILED');
    }
    finally { active--; }
  });
  return server;
}
