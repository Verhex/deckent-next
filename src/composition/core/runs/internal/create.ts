import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { validateProcessExitCriterion } from '#capabilities/index.js';
import { ErrorRegistry, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { nativeWorkerEffortCapability, bindNativeWorkerEffort, assertNativeWorkerBinding, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingRefusalCode, validateDockerTaskProfile, resolveDockerTaskProfile, openSqliteInventoryReader, openSqliteAttemptStore, openSqliteModelCatalogReader, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, resolveGitWorkTarget, selectWorkTarget } from '#adapters/index.js';
import { resolveWorkerEffortExecution, admitWorkerModels, RunAdmissionApplication, runAdmissionSchema, runDeliveryAdmissionSchema, RunPolicyAuthorization, executionResourceAuthorization, authorizeWorkTargetUse,
  assertDockerResourceCeiling, DispatchPolicyAuthorization, pinRunToDelivery, type RunAdmission, type RunCreate, type RunDeliveryAdmission, type RunWorkspaceCustody } from '#engine/index.js';
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
      const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
      try { return await writer.loadRunWorkspaceCustody(scopeId, runId); } finally { writer.close(); }
    },
    async createRun(request: RunCreate, workspace?: RunWorkspaceCustody) {
      const writer = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
      try { return await writer.createRun(request, workspace); } finally { writer.close(); }
    },
  };
  const app = new RunAdmissionApplication(store, { async verify() { return principal; } },
    new RunPolicyAuthorization({ async load() { return document; } }), executionResourceAuthorization({ async load() { return document; } }, selectWorkTarget(config.execution)?.id ?? null), { async resolve(admitted) {
      const profile = config.admission;
      if (!profile) throw ErrorRegistry.createError('RUN_ADMISSION_NOT_CONFIGURED');
      const catalog = await openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
      let execution;
      try {
        execution = await resolveWorkerEffortExecution(admitted.graph, profile.registry, catalog, {
          profile(value) {
            try { assertNativeWorkerBinding(value); } catch { throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH'); }
            try { validateDockerTaskProfile(value); } catch { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }
            if (config.execution?.docker) assertDockerResourceCeiling(resolveDockerTaskProfile(value).options, config.execution.docker);
            return undefined;
          },
          criterion(evaluator, criterion) { try { return validateProcessExitCriterion(evaluator, criterion); } catch { throw ErrorRegistry.createError('TASK_EVALUATOR_INVALID'); } },
          isTemplate: isNativeCodingTemplate, // K3: template + typed work input compile once here, before any write
        }, { capability(value) { try { return nativeWorkerEffortCapability(value); } catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); } },
          bind(value, selection) { try { return bindNativeWorkerEffort(value, selection); } catch { throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH'); } },
          compile(template, input, selection) { try { return compileNativeCodingWorkInput(template, input, selection); } catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); } } });
        await admitWorkerModels(execution.tasks, admitted.scopeId, catalog, Date.now(), admitted.graph.tasks);
      } finally { catalog.close(); }
      return { execution, layoutRevision: layout.revision, now: Date.now(), policy: { schemaVersion: 2, poolId: profile.poolId,
        capacity: { executionSlots: Math.min(profile.executionSlots, config.max_workers === 'auto' ? Infinity : config.max_workers),
          inFlightSlots: Math.min(profile.inFlightSlots, config.max_workers === 'auto' ? Infinity : config.max_workers) }, ordering: admitted.graph.tasks.map(task => task.id) } };
    } });
  return Object.freeze({ schemaVersion: 1 as const, layout, admission: await app.create(command, undefined, pin ? replay => pin(context, replay) : undefined) });
}
export async function createConfiguredRun(projectRoot: string, input: RunAdmission, options: ConfigLoadOptions = {}) {
  try { return await admitConfiguredRun(projectRoot, runAdmissionSchema.parse(input), options); }
  catch (error) { throw queryFailure(error); }
}
export async function createConfiguredDeliveryRun(projectRoot: string, input: RunDeliveryAdmission, options: ConfigLoadOptions = {}) {
  try {
    const { deliveryCommandId, ...fields } = runDeliveryAdmissionSchema.parse(input);
    const command = runAdmissionSchema.parse(fields);
    return await admitConfiguredRun(projectRoot, command, options, async ({ config, layout, principal, path }, replay) => {
      if (!config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      const policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), authorization = new DispatchPolicyAuthorization(policy);
      await authorizeWorkTargetUse(policy, selectWorkTarget(config.execution)?.id ?? null, command.scopeId, principal); // pinning reads the target
      const git = { ...config.execution.git, ...(await resolveGitWorkTarget(resolve(projectRoot), config.execution, layout)).git, workspaceRoot: await prepareProductDirectory(layout, 'workspaces') };
      const store = await openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
      try {
        return await pinRunToDelivery(store, new GitIntegrationDelivery(git), new GitRunWorkspaceProvider(new GitWorkspaceBroker(git)),
          identity => authorization.authorizeIdentity('read-output', identity, principal),
          { scopeId: command.scopeId, runId: command.runId, deliveryCommandId, replay });
      } finally { store.close(); }
    });
  } catch (error) { throw queryFailure(error); }
}
