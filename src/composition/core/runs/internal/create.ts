import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { validateProcessExitCriterion } from '#capabilities/index.js';
import { ErrorRegistry, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { assertNativeWorkerBinding, validateDockerTaskProfile, openSqliteInventoryReader, openSqliteAttemptStore, openSqliteModelCatalogReader, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, resolveGitWorkTarget, selectWorkTarget } from '#adapters/index.js';
import { admitWorkerModels, resolveExecutionRegistry, RunAdmissionApplication, runAdmissionSchema, runDeliveryAdmissionSchema, RunPolicyAuthorization, executionResourceAuthorization,
  DispatchPolicyAuthorization, pinRunToDelivery, type RunAdmission, type RunCreate, type RunDeliveryAdmission, type RunWorkspaceCustody } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;

async function admitConfiguredRun(projectRoot: string, command: RunAdmission, options: ConfigLoadOptions,
  pin?: (context: ScopeContext, replay: boolean) => Promise<RunWorkspaceCustody>) {
  const context = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
  const { config, layout, document, principal, path } = context;
  const store = {
    async loadRunReceipt(scopeId: string, commandId: string) {
      const reader = await openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      try { return await reader.loadRunReceipt(scopeId, commandId); } finally { reader.close(); }
    },
    async loadRunWorkspaceCustody(scopeId: string, runId: string) {
      const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
      try { return await writer.loadRunWorkspaceCustody(scopeId, runId); } finally { writer.close(); }
    },
    async createRun(request: RunCreate, workspace?: RunWorkspaceCustody) {
      const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
      try { return await writer.createRun(request, workspace); } finally { writer.close(); }
    },
  };
  const app = new RunAdmissionApplication(store, { async verify() { return principal; } },
    new RunPolicyAuthorization({ async load() { return document; } }), executionResourceAuthorization({ async load() { return document; } }, selectWorkTarget(config.execution)?.id ?? null), { async resolve(admitted) {
      const profile = config.admission;
      if (!profile) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
      const execution = resolveExecutionRegistry(admitted.graph, profile.registry, {
        profile(value) {
          // Astra 2197 WC-R2: the executed argv of a pinned native profile must carry exactly its pinned model (adapter-owned CLI shape).
          try { assertNativeWorkerBinding(value); } catch { throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH'); }
          try { return validateDockerTaskProfile(value); } catch { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }
        },
        criterion(evaluator, criterion) { try { return validateProcessExitCriterion(evaluator, criterion); } catch { throw ErrorRegistry.createError('TASK_EVALUATOR_INVALID'); } },
      });
      // WORKER-CURRENCY-1: native worker tasks need an exact, current, active catalog model of an active channel (read-only ledger view).
      if (execution.tasks.some(task => task.profile.parameters['nativeSubscription'] !== undefined)) {
        const catalog = await openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
        try { await admitWorkerModels(execution.tasks, admitted.scopeId, catalog, Date.now()); } finally { catalog.close(); }
      }
      return { execution, layoutRevision: layout.revision, now: Date.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
        capacity: { executionSlots: profile.executionSlots, inFlightSlots: profile.inFlightSlots }, ordering: admitted.graph.tasks.map(task => task.id) } };
    } });
  return Object.freeze({ schemaVersion: 1 as const, layout, admission: await app.create(command, undefined, pin ? replay => pin(context, replay) : undefined) });
}
/** Local OS ingress. Existing pool provisioning is required; no implicit pool creation or config-derived grants. */
export async function createConfiguredRun(projectRoot: string, input: RunAdmission, options: ConfigLoadOptions = {}) {
  try { return await admitConfiguredRun(projectRoot, runAdmissionSchema.parse(input), options); }
  catch (error) { throw queryFailure(error); }
}
/** Local SDK ingress (not a runtime-service operation): the same admission, with the Run's workspace custody pinned to the commit of a
 * completed delivery in the same scope, written in the admission transaction. The caller names the delivery command, never a commit;
 * the trusted project root is the Git source, and reading the delivered attempt's output must be allowed. */
export async function createConfiguredDeliveryRun(projectRoot: string, input: RunDeliveryAdmission, options: ConfigLoadOptions = {}) {
  try {
    const { deliveryCommandId, ...fields } = runDeliveryAdmissionSchema.parse(input);
    const command = runAdmissionSchema.parse(fields);
    return await admitConfiguredRun(projectRoot, command, options, async ({ config, layout, principal, path }, replay) => {
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      const git = { ...config.execution.git, ...(await resolveGitWorkTarget(resolve(projectRoot), config.execution, layout)).git, workspaceRoot: await prepareProductDirectory(layout, 'workspaces') };
      const authorization = new DispatchPolicyAuthorization(createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes));
      const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, 'forbid');
      try {
        return await pinRunToDelivery(store, new GitIntegrationDelivery(git), new GitRunWorkspaceProvider(new GitWorkspaceBroker(git)),
          identity => authorization.authorizeIdentity('read-output', identity, principal),
          { scopeId: command.scopeId, runId: command.runId, deliveryCommandId, replay });
      } finally { store.close(); }
    });
  } catch (error) { throw queryFailure(error); }
}
