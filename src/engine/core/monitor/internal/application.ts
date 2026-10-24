import { projectTaskBrief, projectResultBrief } from '#engine/core/runs/index.js';
import { resolveWorkerUsage, type WorkerObservation } from '#engine/core/worker-observation/index.js';
import type { MonitorApproval, MonitorInstall, MonitorPool, MonitorService, MonitorSnapshot, MonitorWorker } from './contract.js';
import { monitorQuerySchema, type MonitorQuery } from './contract.js';
import type { MonitorLedgerIndex, MonitorLedgerReading, MonitorPorts, MonitorTarget } from './evidence.js';
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
 * MONITOR (owner 2026-10-02): builds the one observe-only `MonitorSnapshot`. Per target it indexes the ledger (ids only), asks the target's
 * own scope policy for every scope the ledger names and the `pool inspect` decision for every pool (M-VIS, owner 2026-10-19 PB-POOL-VIS),
 * then reads only admitted scopes' Runs/approvals and visible pools' rows and occupancy. Other pools are counted, never named.
 * Every failure becomes a typed diagnostic; nothing here writes or decides.
 */
export class MonitorApplication {
  constructor(private readonly ports: MonitorPorts) {}
  async inspect(targets: readonly MonitorTarget[], query: MonitorQuery = { schemaVersion: 1 }): Promise<MonitorSnapshot> {
    const { install } = monitorQuerySchema.parse(query);
    // Select before any port call and before path deduplication, so an explicitly selected alias keeps its id.
    const selected = targets.filter(target => install === undefined || target.id === install)
      .filter((target, index, all) => all.findIndex(other => other.path === target.path) === index);
    // Installs are independent read-only observations: they are read concurrently and kept in target order.
    const observedAt = this.ports.now(), installs = await Promise.all(selected.map(target => this.install(target, observedAt)));
    return Object.freeze({ schemaVersion: 1, observedAt, installs: Object.freeze(installs), control: 'observe-only',
      sourcesRead: Object.freeze(selected.map(target => target.id)) });
  }
  /** Typed diagnostics, never an exception: `info:image-updating`, `info:image-current[:<version>]`, or the problem `image-refresh-failed:<reason>`. */
  private async imageRefresh(target: MonitorTarget, diagnostics: string[]) {
    if (!this.ports.readImageRefresh) return;
    try {
      const refresh = await this.ports.readImageRefresh(target);
      if (refresh.status === 'updating') diagnostics.push('info:image-updating');
      // No recorded version: the bare code (an empty detail would print as empty parentheses).
      else if (refresh.status === 'current') diagnostics.push(refresh.imageVersion ? `info:image-current:${refresh.imageVersion}` : 'info:image-current');
      else if (refresh.status === 'failed') diagnostics.push(`image-refresh-failed:${refresh.reason ?? 'UNKNOWN'}`);
    } catch (error) { diagnostics.push('image-refresh-unreadable:' + code(error)); }
  }
  private async install(target: MonitorTarget, observedAt: number): Promise<MonitorInstall> {
    const diagnostics: string[] = []; const serviceState = await service(this.ports, target, diagnostics);
    await this.imageRefresh(target, diagnostics);
    const unavailable = (error: unknown) => { diagnostics.push('ledger-unavailable:' + code(error));
      return Object.freeze({ id: target.id, path: target.path, status: 'unavailable' as const, scopeIds: [], service: serviceState, ledgerVersion: null, runs: [], workers: [],
        approvals: [], pools: [], diagnostics: Object.freeze(diagnostics) }); };
    let index: MonitorLedgerIndex, reading: MonitorLedgerReading;
    try { index = await this.ports.indexLedger(target); } catch (error) { return unavailable(error); }
    const admitted = new Set<string>(); const summaries = new Set<string>(); const workers: WorkerObservation[] = [];
    const scopeNotes: string[] = [], refused: (readonly [string, string])[] = [], failed: (readonly [string, string])[] = [];
    for (const scopeId of index.scopeIds) {
      try {
        const scope = await this.ports.observeScope(target, scopeId);
        if (scope.access === 'denied') { refused.push([scopeId, scope.reason ?? '']); continue; }
        if (scope.access !== 'admitted') { failed.push([scopeId, scope.reason ?? '']); continue; }
        admitted.add(scopeId); workers.push(...scope.workers); if (scope.approvals === true) summaries.add(scopeId);
        if (scope.workerStatus !== 'available') scopeNotes.push(`workers-${scope.workerStatus}:${scopeId}`);
        if (scope.truncated) scopeNotes.push('info:workers-truncated:' + scopeId);
      } catch (error) { failed.push([scopeId, code(error)]); }
    }
    // MON-SCOPE-NAMES / MON-NAMES (owner 2026-10-19): refused and failed scopes are named (`scope-refused|scope-failed:<CODE>:<id>`, the code never holds
    // `:`) only on the viewer's installation-wide scope-diagnostics allow; otherwise, and when that decision fails (one nameless reason), counts.
    const decide = this.ports.observeScopeDiagnostics?.bind(this.ports), unnamed: string[] = [];
    const named = refused.length + failed.length > 0 && !!decide && await Promise.resolve().then(() => decide(target, [...admitted, ...index.scopeIds.filter(id => !admitted.has(id))]))
      .then(value => value === true, error => { unnamed.push('scope-diagnostics-unavailable:' + code(error)); return false; });
    const counts = new Map<string, number>(); for (const [, reason] of failed) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (named) scopeNotes.push(...failed.map(([id, reason]) => `scope-failed:${reason}:${id}`));
    else scopeNotes.push(...[...counts].map(([reason, count]) => `scopes-unavailable:${count}${reason ? ':' + reason : ''}`), ...unnamed);
    // M-VIS: a pool is shown only on the viewer's own `pool inspect` allow; a failed decision hides it too, reported once without any pool id.
    const visible = new Set<string>(), undecided = new Set<string>();
    for (const poolId of index.poolIds) if (await this.ports.observePool(target, poolId, [...admitted]).catch(error => { undecided.add(code(error)); return false; }) === true) visible.add(poolId);
    for (const failure of undecided) scopeNotes.push('pool-decisions-unavailable:' + failure);
    if (refused.length) scopeNotes.unshift(...named ? refused.map(([id, reason]) => `scope-refused:${reason}:${id}`) : [`scopes-denied:${refused.length}`]);
    const brainWaits = await this.brainWaits(target, index.scopeIds, admitted, scopeNotes);
    try { reading = await this.ports.readLedger(target, Object.freeze({ scopeIds: Object.freeze([...admitted]), poolIds: Object.freeze([...visible]) })); }
    catch (error) { diagnostics.push(...scopeNotes); return unavailable(error); }
    diagnostics.push(...reading.diagnostics, ...scopeNotes);
    for (const scopeId of admitted) if (!summaries.has(scopeId) && reading.approvals.some(value => value.scopeId === scopeId)) diagnostics.push('approvals-denied:' + scopeId);
    const recency = new Map(reading.runs.flatMap(run => run.attempts.map(value => [`${run.snapshot.identity.scopeId}/${value.attemptId}`,
      Math.max(value.sealedAtMs ?? value.observedEndAtMs ?? -1, value.dispatch?.grantedAtMs ?? -1)] as const)));
    const rank = (value: WorkerObservation) => recency.get(`${value.identity?.scopeId}/${value.identity?.attemptId}`) ?? -1;
    const finished = workers.filter(value => value.terminal).sort((a, b) => rank(b) - rank(a)); const kept = new Set(finished.slice(0, MONITOR_FINISHED_WORKERS));
    if (finished.length > MONITOR_FINISHED_WORKERS) diagnostics.push('info:workers-finished-capped:' + (finished.length - MONITOR_FINISHED_WORKERS));
    const shown = workers.filter(value => !value.terminal || kept.has(value)).sort((a, b) => rank(b) - rank(a));
    if (this.ports.readShown) {
      // PRE-34: every failed task's attempt states why it stopped, even when its worker is beyond the finished-worker limit (bounded by the Run page).
      const failures = reading.runs.filter(run => admitted.has(run.snapshot.identity.scopeId)).flatMap(run => run.snapshot.bindings
        .filter(binding => run.snapshot.progress.some(task => task.taskId === binding.identity.taskId && task.phase === 'failed')).map(binding => binding.identity));
      try { reading = await this.ports.readShown(target, shown.flatMap(value => value.identity ? [value.identity] : []), failures);
        diagnostics.push(...reading.diagnostics.filter(value => !diagnostics.includes(value))); }
      catch (error) { diagnostics.push('shown-content-unavailable:' + code(error)); }
    }
    // Ledger-only observations carry no sidecar provider/model: fill them from the ledger attempt (evaluation record, pin, profile adapter).
    const ledger = new Map(reading.runs.flatMap(run => run.attempts.map(value => [`${run.snapshot.identity.scopeId}/${value.attemptId}`, value] as const)));

    const byAttempt = new Map(workers.filter(value => value.identity).map(value => [`${value.identity!.scopeId}/${value.identity!.attemptId}`, value]));
    // The application filters again: an adapter that answered more than it was asked never widens the view.
    const shownPools = reading.pools.filter(pool => visible.has(pool.poolId)), pools = new Map(shownPools.map(pool => [pool.poolId, pool]));
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
      status: value.status === 'decided' ? 'decided' : value.status === 'expired' || value.expiresAtMs <= observedAt ? 'expired' : 'pending', approvalId: value.approvalId, subjectKind: value.subjectKind, summary: summaries.has(value.scopeId) ? value.summary : '', requiredAssurance: null, createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs }));
    const poolViews: MonitorPool[] = shownPools.map(pool => Object.freeze({ poolId: pool.poolId, capacity: pool.inFlightSlots, inFlight: pool.inFlight,
      held: pool.hold?.state === 'held', heldBy: pool.hold?.state === 'held' ? pool.hold.changedBy : null, executionCapacity: pool.executionSlots, executing: pool.execution }));
    const hiddenPools = index.poolIds.length - visible.size, open = !index.scopeIds.length || admitted.size > 0;
    const status = open ? 'available' : refused.length ? 'denied' : 'unavailable';
    return Object.freeze({ id: target.id, path: target.path, status, scopeIds: Object.freeze([...admitted]), service: serviceState, ledgerVersion: reading.ledgerVersion,
      runs: Object.freeze(runs),
      workers: Object.freeze(shown.map(enrich)), map: open ? reading.map ?? null : null, approvals: Object.freeze(approvals), pools: Object.freeze(poolViews),
      ...(hiddenPools > 0 ? { hiddenPools } : {}), ...(brainWaits.length ? { brainWaits } : {}), diagnostics: Object.freeze(diagnostics) });
  }
  /**
   * f4: active Brain quota waits of scopes the viewer may read. A scope the ledger already names uses its admission above; a scope only a wait
   * names (no Run yet) is asked the same scope decision here, and its workers are not taken. A wait of a scope the viewer may not read is never
   * shown or named: `info:brain-waits-hidden:<n>` counts them. A failed read is the problem code `brain-waits-unavailable:<CODE>`.
   */
  private async brainWaits(target: MonitorTarget, indexed: readonly string[], admitted: Set<string>, notes: string[]) {
    if (!this.ports.readBrainWaits) return [];
    let stored;
    try { stored = await this.ports.readBrainWaits(target); } catch (error) { notes.push('brain-waits-unavailable:' + code(error)); return []; }
    const allowed = new Set(admitted);
    for (const scopeId of new Set(stored.records.map(record => record.scopeId))) if (!indexed.includes(scopeId))
      if (await this.ports.observeScope(target, scopeId).then(scope => scope.access === 'admitted', () => false)) allowed.add(scopeId);
    const shown = stored.records.filter(record => allowed.has(record.scopeId)), hidden = stored.records.length - shown.length;
    if (hidden) notes.push('info:brain-waits-hidden:' + hidden);
    if (stored.truncated) notes.push('info:brain-waits-truncated');
    return Object.freeze(shown.map(record => Object.freeze({ ...record })));
  }
}
