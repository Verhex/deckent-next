import { isDeepStrictEqual } from 'node:util';
import { immutableJsonObjectSchema, type RunExecutionSnapshot, type VerifiedPrincipal } from '#domain/index.js';
import { modelInvocationProfileDigest, modelUseProfiles, resolveModelUse, ModelBindingApplication, RunStoreError, RunReservationApplication } from '#engine/index.js';
import { isNativeCliWorkerProfile, resolveNativeCliWorkerProfile, createNativeCliWorkerProfile, withMcpPrincipal,
  headlessCapacityBinding, openSqliteInventoryReader, type SqliteAttemptStore, type NativeCliWorkerBinding } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { modelUseReadPorts } from '#composition/core/model-use/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

/** Workload identity is resolved by the existing AI channel, never promoted from the Run creator or a persona. */
export async function resolveNativeWorkerUse(root: string, scopeId: string, binding: NativeCliWorkerBinding, options: ConfigLoadOptions) {
  return withMcpPrincipal(async () => {
    const ports = modelUseReadPorts(options), context = await ports.context(root, scopeId);
    const profile = modelUseProfiles(context.config).find(value => value.scopeId === scopeId && value.protocol.family === binding.protocolFamily
      && modelInvocationProfileDigest(value) === binding.profileDigest);
    if (!profile || !isDeepStrictEqual(profile.adapter.definition, binding.definition)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
    const pin = await resolveModelUse(ports, root, profile, context.principal, { action: 'pin' });
    if (!pin) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_DENIED');
    const catalog = await new ModelBindingApplication({ read: async () => context.config.provider_catalog }).inspect(profile.reference);
    if (catalog.status !== 'declared' || catalog.binding.digest !== profile.bindingDigest) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
    return { context, profile, pin, nativeId: catalog.definition.model.nativeId };
  });
}
export async function nativeWorkerResource(root: string, scopeId: string, binding: NativeCliWorkerBinding, options: ConfigLoadOptions) {
  const current = await resolveNativeWorkerUse(root, scopeId, binding, options);
  const reader = await openSqliteInventoryReader(await current.context.path(), { busyTimeoutMs: current.context.config.storage.sqlite.busyTimeoutMs });
  try {
    const resource = await reader.findCapacityResource(headlessCapacityBinding(current.profile.adapter.definition));
    if (!resource || resource.resourceKey !== binding.resourceKey) throw ErrorRegistry.createError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
    return { ...current, resource };
  } finally { reader.close(); }
}
/** Admission and each spawn/tool compare the frozen K5 pin with a fresh, authorized snapshot. */
export async function recheckNativeWorkerUse(root: string, scopeId: string, binding: NativeCliWorkerBinding, options: ConfigLoadOptions) {
  const current = await nativeWorkerResource(root, scopeId, binding, options);
  if (!binding.modelUsePin || !isDeepStrictEqual(current.pin, binding.modelUsePin)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
  return current;
}
export function nativeWorkerAdmission(root: string, scopeId: string, options: ConfigLoadOptions) {
  const owner = async (principal: VerifiedPrincipal) => {
    const context = await loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, 'read');
    if (principal.id !== context.principal.id || principal.issuer !== context.principal.issuer || principal.subject !== context.principal.subject
      || principal.assurance !== context.principal.assurance) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
  };
  return {
    modelUse: {
      async pin(execution: RunExecutionSnapshot, principal: VerifiedPrincipal): Promise<RunExecutionSnapshot> {
        if (!execution.tasks.some(row => isNativeCliWorkerProfile(row.profile))) return execution;
        await owner(principal);
        const tasks = [];
        for (const task of execution.tasks) {
          if (!isNativeCliWorkerProfile(task.profile)) { tasks.push(task); continue; }
          const resolved = resolveNativeCliWorkerProfile(task.profile), current = await nativeWorkerResource(root, scopeId, resolved.binding, options);
          const model = resolved.nativeSubscription!.model!;
          if (current.profile.reference.providerId !== model.channelId || current.nativeId !== model.modelId)
            throw ErrorRegistry.createError('WORKER_MODEL_BINDING_MISMATCH');
          const profile = createNativeCliWorkerProfile(resolved.base, { ...resolved.binding, modelUsePin: immutableJsonObjectSchema.parse(current.pin) });
          tasks.push({ ...task, profile: { ...profile, id: task.profile.id, version: task.profile.version } });
        }
        return { ...execution, tasks };
      },
      async recheck(execution: RunExecutionSnapshot, principal: VerifiedPrincipal) {
        if (!execution.tasks.some(row => isNativeCliWorkerProfile(row.profile))) return;
        await owner(principal);
        for (const task of execution.tasks) if (isNativeCliWorkerProfile(task.profile)) await recheckNativeWorkerUse(root, scopeId, resolveNativeCliWorkerProfile(task.profile).binding, options);
      },
    },
    async resources(execution: RunExecutionSnapshot) {
      const result = [];
      for (const task of execution.tasks) if (isNativeCliWorkerProfile(task.profile)) {
        const { binding } = resolveNativeCliWorkerProfile(task.profile);
        await recheckNativeWorkerUse(root, scopeId, binding, options);
        result.push({ taskId: task.taskId, resourceKey: binding.resourceKey });
      }
      return result;
    },
  };
}

/** A reserved Run already owns this process's slot. This check never opens a ModelInvocation or a second counter. */
export function assertNativeWorkerReservation(run: import('#domain/index.js').RunSnapshot | null, request: import('#engine/index.js').SandboxRequest,
  binding: NativeCliWorkerBinding, resources: Awaited<ReturnType<SqliteAttemptStore['loadRunResourceCapacity']>>) {
  if (!run) throw new RunStoreError('RUN_STORE_CONFLICT');
  const task = run.execution.tasks.find(row => row.taskId === request.identity.taskId);
  if (!task || !isNativeCliWorkerProfile(task.profile) || !isDeepStrictEqual(resolveNativeCliWorkerProfile(task.profile).binding, binding)) throw new RunStoreError('RUN_STORE_CONFLICT');
  return RunReservationApplication.ownsResourceReservation(run, request.identity, binding.resourceKey, resources);
}
