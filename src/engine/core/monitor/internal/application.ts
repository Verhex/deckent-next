import type { WorkerObservation } from '#engine/core/worker-observation/index.js';
import type { MonitorApproval, MonitorInstall, MonitorPool, MonitorService, MonitorSnapshot } from './contract.js';
import type { MonitorLedgerReading, MonitorPorts, MonitorTarget } from './evidence.js';
import { projectMonitorRun } from './derive.js';

const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
/** Service state from the runtime describe answer: a missing endpoint is `stopped`, any other failure `unknown` with a diagnostic. */
async function service(ports: MonitorPorts, target: MonitorTarget, diagnostics: string[]): Promise<MonitorService> {
  try {
    const value = await ports.describeService(target);
    return Object.freeze({ state: 'running', instanceId: value.instanceId, processId: value.processId ?? null,
      build: value.build ? Object.freeze({ sourceCommit: value.build.sourceCommit, sourceTreeSha256: value.build.sourceTreeSha256, builtAt: null }) : null });
  } catch (error) {
    const failure = code(error); if (failure !== 'LOCAL_RUNTIME_UNAVAILABLE') diagnostics.push('service-unavailable:' + failure);
    return Object.freeze({ state: failure === 'LOCAL_RUNTIME_UNAVAILABLE' ? 'stopped' : 'unknown', instanceId: null, processId: null, build: null });
  }
}
/**
 * MONITOR (owner 2026-10-02): builds the one observe-only `MonitorSnapshot`. Per target it reads the ledger (read-only), asks the target's
 * own scope policy for every scope the ledger names, and keeps only admitted scopes' Runs, approvals and workers; pools are
 * installation-wide and shown once any scope is admitted. Every failure becomes a typed diagnostic; nothing here writes or decides.
 */
export class MonitorApplication {
  constructor(private readonly ports: MonitorPorts) {}
  async inspect(targets: readonly MonitorTarget[]): Promise<MonitorSnapshot> {
    const observedAt = this.ports.now(); const installs: MonitorInstall[] = [];
    for (const target of targets) installs.push(await this.install(target, observedAt));
    return Object.freeze({ schemaVersion: 1, observedAt, installs: Object.freeze(installs), control: 'observe-only' });
  }
  private async install(target: MonitorTarget, observedAt: number): Promise<MonitorInstall> {
    const diagnostics: string[] = []; const serviceState = await service(this.ports, target, diagnostics);
    let reading: MonitorLedgerReading;
    try { reading = await this.ports.readLedger(target); } catch (error) {
      diagnostics.push('ledger-unavailable:' + code(error));
      return Object.freeze({ id: target.id, path: target.path, status: 'unavailable', scopeIds: [], service: serviceState, ledgerVersion: null, runs: [], workers: [],
        approvals: [], pools: [], diagnostics: Object.freeze(diagnostics) });
    }
    diagnostics.push(...reading.diagnostics);
    const admitted = new Set<string>(); const workers: WorkerObservation[] = []; let denied = false;
    for (const scopeId of reading.scopeIds) {
      try {
        const scope = await this.ports.observeScope(target, scopeId);
        if (scope.access !== 'admitted') { denied ||= scope.access === 'denied'; diagnostics.push(`scope-${scope.access}:${scopeId}`); continue; }
        admitted.add(scopeId); workers.push(...scope.workers);
        if (scope.workerStatus !== 'available') diagnostics.push(`workers-${scope.workerStatus}:${scopeId}`);
        if (scope.truncated) diagnostics.push('workers-truncated:' + scopeId);
      } catch (error) { diagnostics.push(`scope-unavailable:${scopeId}:${code(error)}`); }
    }
    const byAttempt = new Map(workers.filter(value => value.identity).map(value => [`${value.identity!.scopeId}/${value.identity!.attemptId}`, value]));
    const pools = new Map(reading.pools.map(pool => [pool.poolId, pool]));
    const runs = reading.runs.filter(run => admitted.has(run.snapshot.identity.scopeId)).map(run => {
      const scopeId = run.snapshot.identity.scopeId;
      const own = new Map(run.attempts.flatMap(attempt => { const worker = byAttempt.get(`${scopeId}/${attempt.attemptId}`); return worker ? [[attempt.attemptId, worker] as const] : []; }));
      return projectMonitorRun({ run, approvals: reading.approvals, pool: run.poolId ? pools.get(run.poolId) ?? null : null, workers: own, observedAt });
    });
    const approvals: MonitorApproval[] = reading.approvals.filter(value => admitted.has(value.scopeId)).map(value => Object.freeze({ scopeId: value.scopeId,
      approvalId: value.approvalId, subjectKind: value.subjectKind, summary: value.summary, requiredAssurance: null, createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs }));
    const poolViews: MonitorPool[] = admitted.size ? reading.pools.map(pool => Object.freeze({ poolId: pool.poolId, capacity: pool.inFlightSlots, inFlight: pool.inFlight,
      held: pool.hold?.state === 'held', heldBy: pool.hold?.state === 'held' ? pool.hold.changedBy : null, executionCapacity: pool.executionSlots, executing: pool.execution })) : [];
    const status = !reading.scopeIds.length || admitted.size ? 'available' : denied ? 'denied' : 'unavailable';
    return Object.freeze({ id: target.id, path: target.path, status, scopeIds: Object.freeze([...admitted]), service: serviceState, ledgerVersion: reading.ledgerVersion,
      runs: Object.freeze(runs), workers: Object.freeze(workers), approvals: Object.freeze(approvals), pools: Object.freeze(poolViews), diagnostics: Object.freeze(diagnostics) });
  }
}
