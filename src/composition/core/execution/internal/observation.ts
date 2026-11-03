import { dirname } from 'node:path';
import type { TaskStallPolicy } from '#domain/index.js';
import { startWorkerObservation, type SqliteAttemptStore } from '#adapters/index.js';
import { dispatchNeedsObservation, inactivityWatch, type DispatchApplication, type ExecutionSupervisor, type SandboxRequest,
  type GatewayActivityCounters, type WorkerActivity } from '#engine/index.js';

/** One observer for both backends. Heartbeat writes never count as native model activity or certify process death. */
export async function startConfiguredWorkerObservation(input: {
  readonly store: Pick<SqliteAttemptStore, 'loadBoundDispatch'>; readonly app: DispatchApplication;
  readonly supervisor: ExecutionSupervisor & { inspectActivity(request: SandboxRequest): Promise<{ state: Parameters<typeof dispatchNeedsObservation>[0]; handle: string | null }> };
  readonly request: SandboxRequest; readonly backend: WorkerActivity['backend']; readonly provider: string;
  readonly heartbeatMs: number; readonly maxFileBytes: number; readonly stall: TaskStallPolicy | undefined;
  readonly gateway: { statistics(): GatewayActivityCounters } | undefined;
}): Promise<{ signal: AbortSignal; close(): Promise<void> }> {
  const { request, supervisor, store, gateway } = input, silence = new AbortController();
  const watch = input.stall && gateway ? inactivityWatch(input.stall, Date.now()) : undefined;
  const observation = await startWorkerObservation(dirname(request.workspace), input.heartbeatMs, input.maxFileBytes, async () => {
    if (watch?.(Date.now(), gateway!.statistics()) === 'stop') silence.abort('inactivity');
    let record = await store.loadBoundDispatch(request.identity); if (!record) return null;
    const activity = await supervisor.inspectActivity(request).catch(() => ({ handle: null, state: 'unknown' as const }));
    // Reconciliation uses the existing atomic custody owner; missing/unknown workers retain their slots and fence.
    if (dispatchNeedsObservation(activity.state, record)) {
      const reconciled = await input.app.reconcile(request).catch(() => null);
      if (reconciled) record = reconciled.record;
    }
    return { schemaVersion: 1, identity: request.identity, backend: input.backend, provider: input.provider, workspace: request.workspace,
      observedAt: Date.now(), process: activity.state, handle: activity.handle, terminal: record.terminal, outputRecorded: !!record.output };
  });
  return { signal: silence.signal, close: () => observation.close() };
}
