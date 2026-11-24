import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { NATIVE_NODE_DEPENDENCY_LAYOUT as layout } from '#domain/index.js';
import { ErrorRegistry, getConfigKnownSecrets } from '#platform/index.js';
import { DispatchPolicyAuthorization, RunPolicyAuthorization } from '#engine/core/policy/index.js';
import { runQuerySchema, type RunAdmissionContext } from '#engine/core/runs/index.js';
import { packageRefused } from './package-activity.js';
import { describePackageDecision, pinPackageAllowance, withPackageUse } from './package-use.js';
import type { NativePackageProfileSelector, PackageContext, PackageRunReader, WorkerPackagePorts } from './ports.js';

export function nativePackageAdmission<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, select: NativePackageProfileSelector): NonNullable<RunAdmissionContext['inputs']> {
  return {
    async pin(create, principal, workspace) {
      const { execution, identity: { scopeId }, commandId } = create;
      const profiles = execution.tasks.map(task => select(task.profile));
      if (!profiles.some(profile => profile?.dependencies)) return { execution };
      if (profiles.some(profile => profile?.dependencies?.state === 'sealed')) throw packageRefused();
      const source = await ports.prepare({ ...context, principal }, scopeId, workspace?.baseRevision);
      const { digest: listDigest, manifest } = await source.review();
      const packageRows = manifest.entries.flatMap(row => row.digest ? row.rules.map(rule => ({ path: row.path, rule, digest: row.digest! })) : []);
      const { project, workTarget, lockfileDigest, platform } = source;
      const reference = { state: 'sealed' as const, layout: layout.id, project, workTarget, lockfileDigest, platform, listDigest, approval: { scopeId, commandId } };
      return { packageRows, withCurrentInputs: source.withCurrentSecrets, execution: { ...execution, tasks: await Promise.all(execution.tasks.map(async (task, index) => {
        const profile = profiles[index];
        if (!profile?.dependencies) return task;
        const bound = profile.bind(await pinPackageAllowance(ports, context, { reference, profile: task.profile }));
        return { ...task, profile: { ...bound, id: task.profile.id, version: task.profile.version } };
      })) } };
    },
    async publish(create, principal, workspace) {
      const references = create.execution.tasks.flatMap(({ profile }) => {
        const input = select(profile)?.dependencies;
        return input && (input.state !== 'sealed' || !input.allowance) ? [input] : [];
      });
      const [reference] = references;
      if (!reference) return;
      const { scopeId } = create.identity;
      if (reference.state !== 'sealed' || !create.authority?.approval || reference.approval.scopeId !== scopeId || reference.approval.commandId !== create.commandId
        || references.some(input => !isDeepStrictEqual(input, reference))) throw packageRefused();
      const read = () => ports.prepare({ ...context, principal }, scopeId, workspace?.baseRevision);
      const source = await read();
      const sameTarget = (current: Awaited<ReturnType<typeof read>>) => current.project === reference.project && current.workTarget === reference.workTarget
        && current.platform === reference.platform && current.lockfileDigest === reference.lockfileDigest;
      if (!sameTarget(source)) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
      await source.seal(reference);
      if (!sameTarget(await read())) throw ErrorRegistry.createError('NATIVE_WORKER_LOCKFILE_CHANGED');
    },
    async commit(create, principal, workspace, work, recheckPolicy) {
      const selectedAllowances = new Map(create.execution.tasks.flatMap(({ profile }) => {
        const reference = select(profile)?.dependencies;
        return reference?.state === 'sealed' && reference.allowance ? [[reference.allowance.partition, { reference, profile }] as const] : [];
      }));
      const [first, ...rest] = selectedAllowances.values();
      if (!first) return work();
      return withPackageUse(ports, { ...context, principal }, [first, ...rest], 'admit', create.commandId,
        async () => { await recheckPolicy(); return work(); }, async (fresh, binding, known) => {
        const pinned = await ports.prepare(fresh, create.identity.scopeId, workspace?.baseRevision, known);
        if (pinned.project !== binding.reference.project || pinned.workTarget !== binding.reference.workTarget
          || pinned.lockfileDigest !== binding.reference.lockfileDigest || (await pinned.review()).digest !== binding.reference.listDigest) throw packageRefused();
      });
    },
  };
}

export async function inspectNativePackageInputs<C extends PackageContext>(ports: WorkerPackagePorts<C>, context: C, scopeId: string,
  select: NativePackageProfileSelector, openRunReader: () => Promise<PackageRunReader>, runId?: string) {
  if (runId !== undefined) {
    const query = runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), policy = ports.policySource(context);
    await new RunPolicyAuthorization(policy).authorize('inspect', query, context.principal);
    const store = await openRunReader();
    try {
      const run = await store.loadRun(scopeId, runId), rows = [];
      if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND');
      for (const { taskId, profile } of run.execution.tasks) {
        const reference = select(profile)?.dependencies;
        if (reference?.state !== 'sealed') continue;
        const attempt = run.bindings.find(row => row.identity.taskId === taskId)?.identity;
        const allowed = attempt ? await new DispatchPolicyAuthorization(policy).authorizeIdentity('read-output', attempt, context.principal).then(() => true, () => false) : false;
        const dispatch = allowed ? await store.loadBoundDispatch(attempt!) : null;
        const mount = dispatch ? join(dispatch.request.workspace, layout.mount) : null;
        const decision = reference.allowance ? await describePackageDecision(ports, context, reference) : null;
        rows.push({ taskId, ...(decision ? { decision } : {}), listDigest: reference.listDigest, lockfileDigest: reference.lockfileDigest,
          checkoutMount: mount && getConfigKnownSecrets(context.config).spans(mount).length === 0 ? mount : null });
      }
      return { kind: 'run' as const, rows };
    } finally { store.close(); }
  }
  const source = await ports.prepare(context, scopeId);
  const { project, workTarget, lockfileDigest, platform } = source, { digest: listDigest, manifest } = await source.review();
  return source.withCurrentSecrets(async () => ({ kind: 'prepared' as const, project, workTarget, lockfileDigest, platform, listDigest, layout, manifest }));
}
