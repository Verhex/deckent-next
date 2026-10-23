import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { validateInstalledCriterion } from '#capabilities/index.js';
import { ErrorRegistry, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { nativeWorkerEffortCapability, bindNativeWorkerEffort, assertNativeWorkerBinding, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingRefusalCode, validateDockerTaskProfile, resolveDockerTaskProfile, dockerTaskSilenceDeadline, openSqliteInventoryReader, openSqliteAttemptStore, openSqliteModelCatalogReader, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, resolveGitWorkTarget, selectWorkTarget } from '#adapters/index.js';
import { runAdmissionStorePerCall, createRunAdmissionContext, RunAdmissionApplication, runAdmissionSchema, runDeliveryAdmissionSchema, executionResourceAuthorization, authorizeWorkTargetUse,
  assertDockerResourceCeiling, DispatchPolicyAuthorization, pinRunToDelivery, type WorkerAdmissionWarning, type RunAdmission, type RunDeliveryAdmission, type RunWorkspaceCustody } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { isToolchainRefreshInProgress } from '#composition/core/toolchains/index.js';
import { withRunCreationAuthority } from './authority.js';
import { readWorkerInstructions } from './worker-instructions.js';
import { prepareMemoryContext } from './memory-context.js';
type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
export async function withConfiguredRunAdmission<T>(projectRoot: string, context: ScopeContext, options: ConfigLoadOptions,
  work: (app: RunAdmissionApplication, authority: import('#engine/index.js').RunCreationAuthority, warnings: () => readonly WorkerAdmissionWarning[]) => Promise<T>) {
  let warnings: readonly WorkerAdmissionWarning[] = [], compiled = false;
  const { config, layout, document, principal, path } = context, instructions = await readWorkerInstructions(projectRoot, config, options);
  const store = runAdmissionStorePerCall({ reader: async () => openSqliteInventoryReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }),
    writer: async () => openSqliteAttemptStore(await path(), config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid') });
  return withRunCreationAuthority(context, async (authority, sealing) => {
  const memory = prepareMemoryContext(context, sealing); // S4B-5: verified memory into each task's prompt (off: nothing read)
  const app = new RunAdmissionApplication(store, { async verify() { return principal; } }, authority,
    executionResourceAuthorization({ async load() { return document; } }, selectWorkTarget(config.execution)?.id ?? null),
    memory.wrap(createRunAdmissionContext(config, layout.revision, { catalog: async () => openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }),
      refreshing: () => isToolchainRefreshInProgress(projectRoot, options), now: Date.now, warnings: value => { warnings = value; }, silenceDeadline: dockerTaskSilenceDeadline,
      validation: { profile(value) {
        try { assertNativeWorkerBinding(value); } catch { throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH'); }
        try { validateDockerTaskProfile(value); } catch { throw ErrorRegistry.createError('EXECUTION_PROFILE_INVALID'); }
        if (config.execution?.docker) assertDockerResourceCeiling(resolveDockerTaskProfile(value).options, config.execution.docker); return undefined;
      }, criterion(evaluator, criterion) { try { return validateInstalledCriterion(evaluator, criterion); } catch { throw ErrorRegistry.createError('TASK_EVALUATOR_INVALID'); } }, isTemplate: isNativeCodingTemplate },
      compiler: { capability(value) { try { return nativeWorkerEffortCapability(value); } catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); } },
        bind(value, selection, evidence) { try { return bindNativeWorkerEffort(value, selection, evidence); } catch { throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH'); } },
        compile(template, input, selection, evidence, task) { compiled = true; if (instructions.oversize) throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_TOO_LARGE');
          return memory.compile(task?.taskId, extra => { try { return compileNativeCodingWorkInput(template, input, selection, evidence, [...instructions.parts, ...extra]); }
            catch (error) { throw ErrorRegistry.createError(nativeCodingRefusalCode(error)); } }); } } })));
  // A withheld snapshot is reported only when this admission compiled a worker prompt; a replay or a template-free Run says nothing.
  return work(app, authority, () => [...(compiled && instructions.withheld ? [instructions.withheld] : []), ...warnings, ...memory.warnings()]);
  });
}
async function admitConfiguredRun(projectRoot: string, command: RunAdmission, options: ConfigLoadOptions,
  pin?: (context: ScopeContext, replay: boolean) => Promise<RunWorkspaceCustody>) {
  const context = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
  return withConfiguredRunAdmission(projectRoot, context, options, async (app, _authority, warnings) => {
    const admission = await app.create(command, undefined, pin ? replay => pin(context, replay) : undefined);
    return Object.freeze({ schemaVersion: 1 as const, layout: context.layout, admission, warnings: warnings() });
  });
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
