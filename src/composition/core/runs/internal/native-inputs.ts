import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { createNativeCliWorkerProfile, isNativeCliWorkerProfile, nativeCodingDependencyLayout, openSqliteInventoryReader, resolveNativeCliWorkerProfile } from '#adapters/index.js';
import { ErrorRegistry, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { DispatchPolicyAuthorization, RunPolicyAuthorization, runQuerySchema, type RunAdmissionContext } from '#engine/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { configuredPackageList, configuredPreparedInput, describePackageDecision, pinPackageAllowance, withPackageUse } from '#composition/core/workspace-patch/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const selected = (profile: Parameters<typeof isNativeCliWorkerProfile>[0]) => isNativeCliWorkerProfile(profile) ? resolveNativeCliWorkerProfile(profile) : null;
const refused = () => ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
export function nativeInputAdmission(root: string, context: Context, options: ConfigLoadOptions): NonNullable<RunAdmissionContext['inputs']> {
  const layout = nativeCodingDependencyLayout();
  return {
    async pin(create, principal, workspace) {
      const { execution, identity: { scopeId }, commandId } = create;
      const profiles = execution.tasks.map(task => selected(task.profile));
      if (!profiles.some(profile => profile?.dependencies)) return { execution };
      if (profiles.some(profile => profile?.dependencies?.state === 'sealed')) throw refused();
      const source = await configuredPreparedInput(root, { ...context, principal }, scopeId, layout, workspace?.baseRevision, options);
      const { digest: listDigest, manifest } = await source.review();
      const packageRows = manifest.entries.flatMap(row => row.digest ? row.rules.map(rule => ({ path: row.path, rule, digest: row.digest! })) : []);
      const { project, workTarget, lockfileDigest, platform } = source;
      const reference = { state: 'sealed' as const, layout: layout.id, project, workTarget, lockfileDigest, platform, listDigest, approval: { scopeId, commandId } };
      return { packageRows, execution: { ...execution, tasks: await Promise.all(execution.tasks.map(async (task, index) => {
        const profile = profiles[index];
        if (!profile?.dependencies) return task;
        const bound = createNativeCliWorkerProfile(profile.base, profile.binding, await pinPackageAllowance(root, context, options, { reference, profile: task.profile }));
        return { ...task, profile: { ...bound, id: task.profile.id, version: task.profile.version } };
      })) } };
    },
    async publish(create, principal, workspace) {
      const references = create.execution.tasks.flatMap(({ profile }) => {
        const input = selected(profile)?.dependencies;
        return input && (input.state !== 'sealed' || !input.allowance) ? [input] : [];
      });
      const [reference] = references;
      if (!reference) return;
      const { scopeId } = create.identity;
      if (reference.state !== 'sealed' || !create.authority?.approval || reference.approval.scopeId !== scopeId || reference.approval.commandId !== create.commandId
        || references.some(input => !isDeepStrictEqual(input, reference))) throw refused();
      const read = () => configuredPreparedInput(root, { ...context, principal }, scopeId, layout, workspace?.baseRevision, options);
      const source = await read();
      const sameTarget = (current: Awaited<ReturnType<typeof read>>) => current.project === reference.project && current.workTarget === reference.workTarget
        && current.platform === reference.platform && current.lockfileDigest === reference.lockfileDigest;
      if (!sameTarget(source)) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
      await source.seal(reference);
      if (!sameTarget(await read())) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
    },
    async commit(create, principal, workspace, work, recheckPolicy) {
      const selectedAllowances = new Map(create.execution.tasks.flatMap(({ profile }) => {
        const reference = selected(profile)?.dependencies;
        return reference?.state === 'sealed' && reference.allowance ? [[reference.allowance.partition, { reference, profile }] as const] : [];
      }));
      const [first, ...rest] = selectedAllowances.values();
      if (!first) return work();
      return withPackageUse(root, { ...context, principal }, options, [first, ...rest], 'admit', create.commandId,
        async () => { await recheckPolicy(); return work(); }, async (fresh, binding, known) => {
        const pinned = await configuredPreparedInput(root, fresh, create.identity.scopeId, layout, workspace?.baseRevision, options, known);
        if (pinned.project !== binding.reference.project || pinned.workTarget !== binding.reference.workTarget
          || pinned.lockfileDigest !== binding.reference.lockfileDigest || (await pinned.review()).digest !== binding.reference.listDigest) throw refused();
      });
    },
  };
}

export async function produceConfiguredNativeInputs(root: string, scopeId: string, options: ConfigLoadOptions, cachePath?: string) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  const layout = nativeCodingDependencyLayout();
  return { ...await configuredPackageList(root, context, scopeId, layout, options, cachePath), layout };
}

export async function inspectConfiguredNativeInputs(root: string, scopeId: string, options: ConfigLoadOptions = {}, runId?: string) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read'), layout = nativeCodingDependencyLayout();
  if (runId !== undefined) {
    const query = runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), policy = contextPolicySource(context);
    await new RunPolicyAuthorization(policy).authorize('inspect', query, context.principal);
    const store = await openSqliteInventoryReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
    try {
      const run = await store.loadRun(scopeId, runId), rows = [];
      if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND');
      for (const { taskId, profile } of run.execution.tasks) {
        const reference = selected(profile)?.dependencies;
        if (reference?.state !== 'sealed') continue;
        const attempt = run.bindings.find(row => row.identity.taskId === taskId)?.identity;
        const allowed = attempt ? await new DispatchPolicyAuthorization(policy).authorizeIdentity('read-output', attempt, context.principal).then(() => true, () => false) : false;
        const dispatch = allowed ? await store.loadBoundDispatch(attempt!) : null;
        const mount = dispatch ? join(dispatch.request.workspace, layout.mount) : null;
        const decision = reference.allowance ? await describePackageDecision(context, reference) : null;
        rows.push({ taskId, ...(decision ? { decision } : {}), listDigest: reference.listDigest, lockfileDigest: reference.lockfileDigest,
          checkoutMount: mount && getConfigKnownSecrets(context.config).spans(mount).length === 0 ? mount : null });
      }
      return { kind: 'run' as const, rows };
    } finally { store.close(); }
  }
  const source = await configuredPreparedInput(root, context, scopeId, layout, undefined, options);
  const { project, workTarget, lockfileDigest, platform } = source, { digest: listDigest, manifest } = await source.review();
  return { kind: 'prepared' as const, project, workTarget, lockfileDigest, platform, listDigest, layout, manifest };
}
