import { projectTaskBrief, projectResultBrief } from '#engine/core/runs/index.js';
import { resolveWorkerUsage, type WorkerObservation } from '#engine/core/worker-observation/index.js';
import type { MonitorApproval, MonitorInstall, MonitorPool, MonitorService, MonitorSnapshot, MonitorWorker } from './contract.js';
import type { MonitorLedgerReading, MonitorPorts, MonitorTarget } from './evidence.js';
import { redactSensitive, terminalSafeText } from '#platform/index.js';
import { projectMonitorRun } from './derive.js';

/** Finished workers (ledger terminal) shown per install, most recent first by sealed log, else launch grant; open ones are never capped. */
export const MONITOR_FINISHED_WORKERS = 20;
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
/** Service state from the runtime describe answer: a missing endpoint is `stopped`, any other failure `unknown` with a diagnostic. */
async function service(ports: MonitorPorts, target: MonitorTarget, diagnostics: string[]): Promise<MonitorService> {
  try {
    const value = await ports.describeService(target);
    // Typed diagnostic `config-restart-required`: a restart-apply section changed since this service started (a failed read adds nothing).
    if (await ports.readConfigFreshness?.(target, value).catch(() => 'unknown') === 'stale') diagnostics.push('config-restart-required');
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
 * installation-wide and shown unless every scope the ledger names was refused. Every failure becomes a typed diagnostic; nothing here writes or decides.
 */
export class MonitorApplication {
  constructor(private readonly ports: MonitorPorts) {}
  async inspect(targets: readonly MonitorTarget[]): Promise<MonitorSnapshot> {
    const observedAt = this.ports.now(); const installs: MonitorInstall[] = [];
    for (const target of targets) installs.push(await this.install(target, observedAt));
    return Object.freeze({ schemaVersion: 1, observedAt, installs: Object.freeze(installs), control: 'observe-only' });
  }
  /** Typed diagnostics, never an exception: `info:image-updating`, `info:image-current:<version>`, or the problem `image-refresh-failed:<reason>`. */
  private async imageRefresh(target: MonitorTarget, diagnostics: string[]) {
    if (!this.ports.readImageRefresh) return;
    try {
      const refresh = await this.ports.readImageRefresh(target);
      if (refresh.status === 'updating') diagnostics.push('info:image-updating');
      else if (refresh.status === 'current') diagnostics.push(`info:image-current:${refresh.imageVersion ?? ''}`);
      else if (refresh.status === 'failed') diagnostics.push(`image-refresh-failed:${refresh.reason ?? 'UNKNOWN'}`);
    } catch (error) { diagnostics.push('image-refresh-unreadable:' + code(error)); }
  }
  private async install(target: MonitorTarget, observedAt: number): Promise<MonitorInstall> {
    const diagnostics: string[] = []; const serviceState = await service(this.ports, target, diagnostics);
    await this.imageRefresh(target, diagnostics);
    let reading: MonitorLedgerReading;
    try { reading = await this.ports.readLedger(target); } catch (error) {
      diagnostics.push('ledger-unavailable:' + code(error));
      return Object.freeze({ id: target.id, path: target.path, status: 'unavailable', scopeIds: [], service: serviceState, ledgerVersion: null, runs: [], workers: [],
        approvals: [], pools: [], diagnostics: Object.freeze(diagnostics) });
    }
    diagnostics.push(...reading.diagnostics);
    const admitted = new Set<string>(); const summaries = new Set<string>(); const workers: WorkerObservation[] = []; let denied = false;
    for (const scopeId of reading.scopeIds) {
      try {
        const scope = await this.ports.observeScope(target, scopeId);
        if (scope.access !== 'admitted') { denied ||= scope.access === 'denied'; diagnostics.push(`scope-${scope.access}:${scopeId}`); continue; }
        admitted.add(scopeId); workers.push(...scope.workers); if (scope.approvals === true) summaries.add(scopeId);
        else if (reading.approvals.some(value => value.scopeId === scopeId)) diagnostics.push('approvals-denied:' + scopeId);
        if (scope.workerStatus !== 'available') diagnostics.push(`workers-${scope.workerStatus}:${scopeId}`);
        if (scope.truncated) diagnostics.push('info:workers-truncated:' + scopeId);
      } catch (error) { diagnostics.push(`scope-unavailable:${scopeId}:${code(error)}`); }
    }
    const recency = new Map(reading.runs.flatMap(run => run.attempts.map(value => [`${run.snapshot.identity.scopeId}/${value.attemptId}`,
      Math.max(value.sealedAtMs ?? value.observedEndAtMs ?? -1, value.dispatch?.grantedAtMs ?? -1)] as const)));
    const rank = (value: WorkerObservation) => recency.get(`${value.identity?.scopeId}/${value.identity?.attemptId}`) ?? -1;
    const finished = workers.filter(value => value.terminal).sort((a, b) => rank(b) - rank(a)); const kept = new Set(finished.slice(0, MONITOR_FINISHED_WORKERS));
    if (finished.length > MONITOR_FINISHED_WORKERS) diagnostics.push('info:workers-finished-capped:' + (finished.length - MONITOR_FINISHED_WORKERS));
    const shown = workers.filter(value => !value.terminal || kept.has(value)).sort((a, b) => rank(b) - rank(a));
    if (this.ports.readShown) {
      try { reading = await this.ports.readShown(target, shown.flatMap(value => value.identity ? [value.identity] : []));
        diagnostics.push(...reading.diagnostics.filter(value => !diagnostics.includes(value))); }
      catch (error) { diagnostics.push('shown-content-unavailable:' + code(error)); }
    }
    // Ledger-only observations carry no sidecar provider/model: fill them from the ledger attempt (evaluation record, pin, profile adapter).
    const ledger = new Map(reading.runs.flatMap(run => run.attempts.map(value => [`${run.snapshot.identity.scopeId}/${value.attemptId}`, value] as const)));

    const byAttempt = new Map(workers.filter(value => value.identity).map(value => [`${value.identity!.scopeId}/${value.identity!.attemptId}`, value]));
    const pools = new Map(reading.pools.map(pool => [pool.poolId, pool]));
    const runs = reading.runs.filter(run => admitted.has(run.snapshot.identity.scopeId)).map(run => {
      const scopeId = run.snapshot.identity.scopeId;
      const own = new Map(run.attempts.flatMap(attempt => { const worker = byAttempt.get(`${scopeId}/${attempt.attemptId}`); return worker ? [[attempt.attemptId, worker] as const] : []; }));
      return projectMonitorRun({ run, approvals: reading.approvals, pool: run.poolId ? pools.get(run.poolId) ?? null : null, workers: own, observedAt });
    }).sort((a, b) => (b.lastActivityMs ?? -1) - (a.lastActivityMs ?? -1));
    const enrich = (value: WorkerObservation): MonitorWorker => {
      const id = value.identity;
      const record = id ? reading.runs.find(run => run.snapshot.identity.scopeId === id.scopeId && run.snapshot.identity.runId === id.runId
        && run.snapshot.identity.layoutRevision === id.layoutRevision && run.snapshot.bindings.some(binding => binding.identity.taskId === id.taskId
          && binding.identity.attemptId === id.attemptId && binding.identity.generation === id.generation)) : undefined;
      const known = record ? ledger.get(`${id!.scopeId}/${id!.attemptId}`) : undefined;
      const task = record?.snapshot.graph.tasks.find(task => task.id === id!.taskId);
      const input = task?.workInput, text = input?.title ?? input?.task ?? input?.acceptance ?? null;
      const title = text ? redactSensitive(terminalSafeText(text)).replace(/\s+/g, ' ').trim() || null : null;
      const projected = runs.find(run => run.scopeId === id?.scopeId && run.runId === id?.runId)?.tasks.find(task => task.taskId === id?.taskId);
      const content = known?.content;
      const usageEvidence = value.usageEvidence === 'invalid' || value.usageEvidence === 'unavailable' ? value.usageEvidence : content?.usageEvidence ?? value.usageEvidence;
      const usage = usageEvidence === 'invalid' || usageEvidence === 'unavailable' ? null : content?.usage ?? resolveWorkerUsage(value);
      const { usage: previousUsage, usageEvidence: previousEvidence, ...baseValue } = value; void previousUsage; void previousEvidence;
      return { ...baseValue, provider: value.provider === 'unknown' ? known?.provider ?? value.provider : value.provider,
        ...(value.model ? {} : known?.model ? { model: known.model } : {}),
        ...(usage ? { usage } : {}), ...(usageEvidence ? { usageEvidence } : {}),
        human: { ...(record ? { taskBrief: projectTaskBrief(record.snapshot, id!.taskId),
          resultBrief: projectResultBrief(id!.attemptId, { verdict: known ? projected?.evaluation.verdict ?? null : null,
            ...(known && projected?.evaluation.reason ? { reason: projected.evaluation.reason } : {}) }, content?.finalReport ?? null, record.delivery ?? null) } : {}), title, tokenUsageRecorded: usage?.tokenUsageRecorded === true, titleEvidence: !title ? 'missing' : input?.title ? 'title' : input?.task ? 'task' : 'acceptance',
          evaluation: known ? projected?.evaluation.verdict ?? null : null,
          ...(known && projected?.evaluation.reason ? { evaluationReason: projected.evaluation.reason } : {}),
          transcript: content?.transcript ?? { state: 'missing', excerpt: [], truncated: false },
          patch: content?.patch ?? { state: 'missing', files: [], fileCount: null, truncated: false, baseCommit: null }, finalReport: content?.finalReport ?? null,
          startedAtMs: known?.dispatch?.grantedAtMs ?? null, endedAtMs: known?.sealedAtMs ?? known?.observedEndAtMs ?? null,
          endedAtSource: known?.sealedAtMs != null ? 'sealed' : known?.observedEndAtMs != null ? 'observed' : null } };
    };
    const approvals: MonitorApproval[] = reading.approvals.filter(value => admitted.has(value.scopeId)).map(value => Object.freeze({ scopeId: value.scopeId,
      approvalId: value.approvalId, subjectKind: value.subjectKind, summary: summaries.has(value.scopeId) ? value.summary : '', requiredAssurance: null, createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs }));
    const poolViews: MonitorPool[] = !reading.scopeIds.length || admitted.size ? reading.pools.map(pool => Object.freeze({ poolId: pool.poolId, capacity: pool.inFlightSlots, inFlight: pool.inFlight,
      held: pool.hold?.state === 'held', heldBy: pool.hold?.state === 'held' ? pool.hold.changedBy : null, executionCapacity: pool.executionSlots, executing: pool.execution })) : [];
    const status = !reading.scopeIds.length || admitted.size ? 'available' : denied ? 'denied' : 'unavailable';
    return Object.freeze({ id: target.id, path: target.path, status, scopeIds: Object.freeze([...admitted]), service: serviceState, ledgerVersion: reading.ledgerVersion,
      runs: Object.freeze(runs),
      workers: Object.freeze(shown.map(enrich)), map: !reading.scopeIds.length || admitted.size ? reading.map ?? null : null, approvals: Object.freeze(approvals), pools: Object.freeze(poolViews), diagnostics: Object.freeze(diagnostics) });
  }
}
