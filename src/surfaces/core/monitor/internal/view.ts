import { renderAcceptanceLine } from './acceptance.js';
import { t, type Locale } from '#platform/index.js';
import { projectHumanState, projectRunStop, projectStopCause, resolveWorkerUsage, type StopCause, type MonitorApproval, type MonitorAttempt, type MonitorBlocker, type MonitorDeliveryState, type MonitorInstall, type MonitorPool, type MonitorRun, type MonitorRunState, type MonitorSnapshot, type MonitorTask,
  type MonitorWorker } from '#engine/index.js';
import { boundNamedScopes, describeDiagnostics, mapBlocks, span, type MonitorBlock, type MonitorColumn, type MonitorLine, type MonitorRole, type MonitorRow, type MonitorSpan } from '#surfaces/core/monitor-view/index.js';
import { deliveryLabel, deliveryOutlookLabel, deliveryOutlookDetail, agoText, blockerLabel, quotaWaitText, clockText, durationText, expiryText, forText, installStatusLabel, MONITOR_TABS, processExitText, processLabel, runStateLabel,
  taskPhaseLabel, verdictLabel, workerPhaseLabel, notAcceptedLabel, stopCauseText, type MonitorTab } from './labels.js';
import { renderWorkerModelLine } from './worker-model.js';
import { formatBytes, formatKnown, formatUsd, untitledWorkName } from '#surfaces/core/cli-human/index.js';
import { humanWorkerLines } from './human-worker.js';
import { renderResourceLine, renderResourceDetail } from './resources.js';
import { renderCostSummary, renderRecommendationLines } from './costs.js';
import { globalRunCell, globalStateCell, globalStateLabel, globalStateLines, globalSummary } from './global-state.js';
import { renderGraphSummaryLines } from './graph-summary.js';
import { installName, installsBlocks, installState, problemsSpan } from './installs.js';

/**
 * The one view model of the MonitorSnapshot (MONITOR-SURFACE): the `--once` text, `/monitor` and the fullscreen view all project these
 * blocks. Every time is relative to the snapshot's `observedAt` (the age as observed, stable for a given snapshot). The blocker is the
 * engine's; this surface only words and orders it.
 */
export interface MonitorFilters { readonly install?: string; readonly scope?: string }
export interface MonitorView { readonly header: readonly MonitorLine[]; readonly tabs: Readonly<Record<MonitorTab, readonly MonitorBlock[]>> }
/** PB-MON-UX markers: ✓ fine, ! needs attention, ○ off/absent, ● the install is reachable, → the next step (ASCII `+ ! o * ->`). */
interface Marks { readonly states: Readonly<Record<MonitorRunState, string>>; readonly warn: string; readonly ok: string; readonly on: string; readonly off: string; readonly sep: string;
  readonly approx: string; readonly next: string }
const UNICODE: Marks = { states: { parked: '⏸', incomplete: '!', progressing: '▶', waiting: '~', blocked: '!', accepted: '✓', failed: '✗', cancelled: '■' }, warn: '!', ok: '✓', on: '●', off: '○', sep: '·', approx: '≈', next: '→' };
const ASCII: Marks = { states: { parked: '=', incomplete: '!', progressing: '>', waiting: '~', blocked: '!', accepted: '+', failed: 'x', cancelled: '-' }, warn: '!', ok: '+', on: '*', off: 'o', sep: '|', approx: '~=', next: '->' };
const OPEN: readonly MonitorRunState[] = ['progressing', 'waiting', 'blocked', 'parked'];
/** Not a stall: the Run moves (or its worker runs) on its own. */
const MOVING = new Set(['none', 'worker-running']);
const blockerRole = (blocker: MonitorBlocker): MonitorRole => blocker.code === 'awaiting-approval' ? 'warning' : MOVING.has(blocker.code) ? 'muted'
  : ['worker-stale-heartbeat', 'unresolved-effect', 'evaluation-unknown', 'worker-exited-unevaluated', 'unknown'].includes(blocker.code) ? 'error' : 'warning';
const short = (value: string | null | undefined, size: number) => value ? value.slice(0, size) : '—';
/** Worse first: what needs eyes sorts to the top when the state sort is chosen. */
const STATE_RANK: Readonly<Record<MonitorRunState, number>> = { parked: 0, incomplete: 0, blocked: 0, waiting: 1, failed: 2, progressing: 3, cancelled: 4, accepted: 5 };
/** `MonitorAttempt.endedAtSource`: 'observed' = the end is the host's own recorded worker exit in the attempt sidecar, not a sealed log end. */
const endedObserved = (attempt: MonitorAttempt | null) => attempt?.endedAtSource === 'observed';
const observedEnd = (run: MonitorRun) => {
  const last = run.tasks.map(task => task.lastAttempt).filter((attempt): attempt is MonitorAttempt => attempt !== null && attempt.endedAtMs !== null)
    .sort((a, b) => b.endedAtMs! - a.endedAtMs!)[0] ?? null;
  return endedObserved(last);
};
const OUTLOOK_ROLE: Readonly<Record<NonNullable<MonitorRun['deliveryOutlook']>, MonitorRole>> = { none: 'muted', 'patch-not-prepared': 'warning', 'awaiting-delivery': 'info' };
const DELIVERY_ROLE: Readonly<Record<MonitorDeliveryState, MonitorRole>> = { integrating: 'info', integrated: 'info', delivering: 'info', delivered: 'success',
  adopting: 'info', adopted: 'success', 'rolling-back': 'warning', 'rolled-back': 'warning' };

const timeText = (ms: number | null | undefined) => ms === null || ms === undefined ? '—' : clockText(ms).slice(11);

/** `--install` keeps one observed install; `--scope` keeps that scope's Runs, workers and approvals (pools are installation-wide). */
export function filterSnapshot(snapshot: MonitorSnapshot, filters: MonitorFilters): MonitorSnapshot {
  if (filters.install === undefined && filters.scope === undefined) return snapshot;
  const scope = filters.scope;
  const installs = snapshot.installs.filter(install => filters.install === undefined || install.id === filters.install).map(install => scope === undefined ? install : {
    ...install, scopeIds: install.scopeIds.filter(id => id === scope), runs: install.runs.filter(run => run.scopeId === scope),
    workers: install.workers.filter(worker => worker.identity?.scopeId === scope), approvals: install.approvals.filter(approval => approval.scopeId === scope) });
  return { ...snapshot, installs };
}

interface Entry<T> { readonly install: MonitorInstall; readonly value: T }
const each = <T>(installs: readonly MonitorInstall[], pick: (install: MonitorInstall) => readonly T[]): Entry<T>[] =>
  installs.flatMap(install => pick(install).map(value => ({ install, value })));

/** Words and cells shared by every block of one view (one locale, one observation time, one marker set). */
function wordsFor(snapshot: MonitorSnapshot, locale: Locale, ascii: boolean, verbose: boolean) {
  const marks = ascii ? ASCII : UNICODE, now = snapshot.observedAt, multi = snapshot.installs.length > 1, sep = ` ${marks.sep} `;
  const builtAt = (value: string | null) => { const ms = value === null ? NaN : Date.parse(value); return Number.isFinite(ms) ? clockText(ms) : value ?? '—'; };
  // Every worker finds its Run task and attempt by identity (finished, ledger-only workers have no sidecar files: model and events come from here).
  const identityKey = (install: MonitorInstall, runId: string, scopeId: string, taskId: string, attempt: { attemptId: string; generation: number }) =>
    JSON.stringify([install.id, scopeId, runId, taskId, attempt.attemptId, attempt.generation]);
  const attempts = new Map<string, { readonly run: MonitorRun; readonly task: MonitorTask; readonly attempt: MonitorAttempt }>();
  const workers = new Map<string, MonitorWorker>();
  // PRE-34: a worker of an earlier attempt (the task has since bound a later one) still finds its task, so its state is not guessed.
  const tasks = new Map(snapshot.installs.flatMap(install => install.runs.flatMap(run => run.tasks.map(task =>
    [JSON.stringify([install.id, run.scopeId, run.runId, task.taskId]), { run, task }] as const))));
  for (const install of snapshot.installs) for (const worker of install.workers) {
    const id = worker.identity; if (!id || id.taskId !== worker.taskId) continue;
    const key = identityKey(install, id.runId, id.scopeId, id.taskId, id);
    workers.set(key, worker);
  }
  for (const install of snapshot.installs) for (const run of install.runs) for (const task of run.tasks) {
    if (task.lastAttempt) attempts.set(identityKey(install, run.runId, run.scopeId, task.taskId, task.lastAttempt), { run, task, attempt: task.lastAttempt });
  }
  const attemptOf = (install: MonitorInstall, worker: MonitorWorker) => worker.identity && worker.taskId === worker.identity.taskId
    ? attempts.get(identityKey(install, worker.identity.runId, worker.identity.scopeId, worker.taskId, worker.identity)) ?? null : null;
  const words = {
    locale, now, marks, sep, multi, ascii, verbose,
    col: (header: string, priority: number, min: number, max: number, extra: Partial<Pick<MonitorColumn, 'cut' | 'sortKey'>> = {}): MonitorColumn => ({ header, priority, min, max, ...extra }),
    installColumn: (priority: number): readonly MonitorColumn[] => multi ? [{ header: t('monitor.col.install', {}, locale), priority, min: 8, max: 16 }] : [],
    installCell: (install: MonitorInstall): readonly MonitorSpan[] => multi ? [span(install.id, 'muted')] : [],
    stateCell: (run: MonitorRun) => globalRunCell(run, locale),
    blockerText: (blocker: MonitorBlocker) => ['quota-exhausted', 'quota-reset-unknown', 'quota-retry-limit'].includes(blocker.detail ?? '') && blocker.deadlineMs !== undefined
      ? quotaWaitText(blocker.deadlineMs, blocker.detail !== 'quota-reset-unknown', locale, blocker.detail === 'quota-retry-limit', now) : `${blockerLabel(blocker.code, locale)}${blocker.detail ? ` (${blocker.detail === 'patch-missing' ? t('monitor.blocker.patchMissing', {}, locale) : blocker.detail})` : ''}`,
    runName: (run: MonitorRun) => `${run.scopeId}/${run.runId}`,
    progress: (run: MonitorRun) => t('monitor.progress', { accepted: run.phaseCounts['accepted'] ?? run.tasks.filter(task => task.phase === 'accepted').length,
      total: run.tasks.length }, locale),
    /**
     * Admission → proven finish only (owner: never a computed duration without a proven end). An open Run runs to the observation time;
     * a finished Run needs `finishedAtMs`; else "unknown". `≈` marks an end taken from the host-observed worker exit instead of a sealed log.
     */
    runDuration: (run: MonitorRun) => {
      const start = run.createdAtMs ?? null, open = OPEN.includes(run.state);
      if (open) return start === null ? t('monitor.duration.open', {}, locale) : t('monitor.duration.running', { duration: durationText(now - start, locale) }, locale);
      const end = run.finishedAtMs ?? null;
      if (start === null || end === null) return t('monitor.time.unknown', {}, locale);
      return `${observedEnd(run) ? `${marks.approx} ` : ''}${durationText(end - start, locale)}`;
    },
    deliveryText: (run: MonitorRun) => run.delivery ? deliveryLabel(run.delivery.state, locale) : run.deliveryOutlook ? deliveryOutlookLabel(run.deliveryOutlook, locale) : '—',
    deliveryRole: (run: MonitorRun): MonitorRole | undefined => run.delivery ? DELIVERY_ROLE[run.delivery.state] : run.deliveryOutlook ? OUTLOOK_ROLE[run.deliveryOutlook] : 'muted',
    serviceText: (install: MonitorInstall) => !install.service ? t('monitor.service.none', {}, locale)
      : install.service.state === 'running' ? t('monitor.service.running', { pid: install.service.processId ?? '—' }, locale)
        : install.service.state === 'stopped' ? t('monitor.service.stopped', {}, locale) : t('monitor.service.unknown', {}, locale),
    /** The build a service runs: commit and source tree; the build time only when the service reported one (never an empty "(— built)"). */
    buildText: (install: MonitorInstall) => { const build = install.service?.build;
      if (!build) return t('monitor.build.unknown', {}, locale);
      const parts = [t('monitor.build', { commit: short(build.sourceCommit, 12) }, locale), t('monitor.detail.tree', { tree: short(build.sourceTreeSha256, 12) }, locale)];
      return [...parts, ...(build.builtAt ? [t('monitor.build.builtAt', { builtAt: builtAt(build.builtAt) }, locale)] : [])].join(sep); },
    ledgerText: (install: MonitorInstall) => install.ledgerVersion === null ? t('monitor.ledger.unknown', {}, locale) : t('monitor.ledger', { version: install.ledgerVersion }, locale),
    /** The warnings a person reads (named scope lines bounded unless `verbose`); `problemCount` is the true number. */
    warnings: (install: MonitorInstall) => boundNamedScopes(describeDiagnostics(install.diagnostics, locale).filter(entry => !entry.note), locale, verbose),
    problemCount: (install: MonitorInstall) => describeDiagnostics(install.diagnostics, locale).filter(entry => !entry.note).length,
    notes: (install: MonitorInstall) => describeDiagnostics(install.diagnostics, locale).filter(entry => entry.note),
    /** A bare age for table cells whose header already says since/for (`3 h 12 min`); details keep the full sentence. */
    age: (since: number | null) => since === null ? t('monitor.time.unknown', {}, locale) : durationText(now - since, locale),
    attemptOf,
    /** The human-state subject extras of a worker: its exact attempt's task and Run blocker, else (an earlier attempt) its task alone. */
    workerSubject: (install: MonitorInstall, worker: MonitorWorker): { task?: MonitorTask; blocker?: MonitorBlocker | null } => {
      const own = attemptOf(install, worker); if (own) return { task: own.task, blocker: own.run.blocker };
      const owner = worker.identity ? tasks.get(JSON.stringify([install.id, worker.identity.scopeId, worker.identity.runId, worker.taskId])) : undefined;
      return owner ? { task: owner.task } : {};
    },
    workerOf: (install: MonitorInstall, run: MonitorRun, task: MonitorTask) => task.lastAttempt
      ? workers.get(identityKey(install, run.runId, run.scopeId, task.taskId, task.lastAttempt)) : undefined,
    workerName: (worker: MonitorWorker) => `${worker.identity?.runId ?? '—'}/${worker.taskId}`,
    heartbeat: (worker: MonitorWorker): MonitorSpan => worker.custody === 'released' ? span(t('monitor.heartbeat.released', {}, locale), 'muted')
      : !worker.files || worker.files.heartbeat.ageMs === null ? span('—', 'muted')
        : worker.files.heartbeat.freshness === 'stale' ? span(`${marks.warn} ${t('monitor.heartbeat.stale', { age: durationText(worker.files.heartbeat.ageMs, locale) }, locale)}`, 'error')
          : span(durationText(worker.files.heartbeat.ageMs, locale), worker.files.heartbeat.freshness === 'fresh' ? 'success' : 'muted'),
    processText: (worker: MonitorWorker) => processExitText(worker.process, worker.terminal, locale),
    /** PRE-5: a worker without a recorded title is named by its task and kind (a delivery-queue verify Run records none), never "no title". */
    workTitle: (install: MonitorInstall, worker: MonitorWorker): string => {
      const owner = words.workerSubject(install, worker).task;
      return worker.human?.title ?? (owner ? untitledWorkName(worker.taskId, owner.kind, locale) : words.workerName(worker));
    },
  };
  return words;
}
export type Words = ReturnType<typeof wordsFor>;
const modelOf = (w: Words, install: MonitorInstall, worker: MonitorWorker) =>
  worker.model?.requested.modelId ?? w.attemptOf(install, worker)?.attempt.model ?? worker.files?.usage?.model ?? null;

/**
 * M2: the worker's story in one human sentence: which provider/model, when it started and finished, how many turns, how it closed. Every part comes from the
 * snapshot's own evidence (ledger dispatch/terminal, sealed worker events); a part without proof is omitted or says so, never guessed.
 */
function narrativeLine(w: Words, attempt: MonitorAttempt, live: boolean): MonitorLine | null {
  const { locale, now } = w;
  if (attempt.startedAtMs === null && attempt.endedAtMs === null) return null;
  const close = attempt.closeReason === 'exit-ok' ? t('monitor.narrative.close.exitOk', {}, locale)
    : attempt.closeReason === 'exit-error' ? t('monitor.narrative.close.exitError', { code: attempt.exitCode ?? '—' }, locale)
      : attempt.closeReason === 'signal' ? t('monitor.narrative.close.signal', {}, locale) : attempt.closeReason === 'interrupted' ? t('monitor.narrative.close.interrupted', {}, locale)
        : attempt.closeReason === 'cancelled' ? t('monitor.narrative.close.cancelled', {}, locale) : null;
  const outcome = attempt.sessionOutcome === 'success' ? t('monitor.narrative.outcome.success', {}, locale) : attempt.sessionOutcome === 'error' ? t('monitor.narrative.outcome.error', {}, locale)
    : attempt.sessionOutcome === 'limit' ? t('monitor.narrative.outcome.limit', {}, locale) : null;
  const elapsed = attempt.startedAtMs !== null && attempt.endedAtMs !== null ? `${endedObserved(attempt) ? `${w.marks.approx} ` : ''}${durationText(attempt.endedAtMs - attempt.startedAtMs, locale)}` : null;
  const parts = [t('monitor.narrative.head', { worker: `${attempt.provider ?? '—'}/${attempt.model ?? '—'}` }, locale),
    ...(attempt.startedAtMs !== null ? [t('monitor.narrative.started', { time: timeText(attempt.startedAtMs) }, locale)] : []),
    attempt.endedAtMs !== null ? t('monitor.narrative.finished', { time: timeText(attempt.endedAtMs), duration: elapsed ?? t('monitor.time.unknown', {}, locale) }, locale)
      : live && attempt.startedAtMs !== null ? t('monitor.narrative.running', { duration: durationText(now - attempt.startedAtMs, locale) }, locale) : t('monitor.narrative.endUnknown', {}, locale),
    ...(attempt.turns != null ? [t('monitor.narrative.turns', { turns: attempt.turns }, locale)] : []), ...(close ? [close] : []), ...(outcome ? [outcome] : [])];
  return [span(`    ${parts.join(w.sep)}`, 'strong')];
}
/** M3: how many tests failed and the first names (count and names come from the recorded output under the read-output decision). */
function failedTestLines(w: Words, attempt: MonitorAttempt): MonitorLine[] {
  const failed = attempt.failedTests; if (!failed) return [];
  const { locale } = w, more = failed.count - failed.names.length;
  return [[span(`    ${t('monitor.detail.failedTests', { count: failed.count, shown: failed.names.length }, locale)}`, 'error')],
    ...failed.names.map((name): MonitorLine => [span(`      ${w.marks.states.failed} ${name}`, 'error')]),
    ...(more > 0 ? [[span(`      ${t('monitor.detail.failedTestsMore', { more }, locale)}`, 'muted')] as MonitorLine]
      : failed.truncated ? [[span(`      ${t('monitor.detail.failedTestsPartial', {}, locale)}`, 'muted')] as MonitorLine] : [])];
}
/** One attempt as a timeline: start/end/duration/exit/model, the first failing line, then the last worker-reported events. */
function attemptLines(w: Words, attempt: MonitorAttempt, cause: StopCause | null, live: boolean): MonitorLine[] {
  const { locale, now } = w;
  // A live attempt runs to the observation time; an ended one needs its proven end, else the duration is unknown (never guessed).
  const end = attempt.endedAtMs ?? (live ? now : null);
  const duration = attempt.startedAtMs === null || end === null ? t('monitor.time.unknown', {}, locale)
    : `${endedObserved(attempt) ? `${w.marks.approx} ` : ''}${durationText(end - attempt.startedAtMs, locale)}`;
  const story = narrativeLine(w, attempt, live);
  return [
    ...(story ? [story] : []),
    [span(`    ${t('monitor.detail.attempt', { attempt: short(attempt.attemptId, 8), generation: attempt.generation, launch: attempt.launch ?? '—',
      started: timeText(attempt.startedAtMs), ended: attempt.endedAtMs !== null ? timeText(attempt.endedAtMs) : live ? t('monitor.detail.stillRunning', {}, locale)
        : t('monitor.time.unknown', {}, locale), duration, exit: attempt.exitCode ?? '—', model: attempt.model ?? '—', provider: attempt.provider ?? '—' }, locale)}`, 'muted')],
    ...(attempt.container ? [[span(`    ${t('monitor.detail.container', { id: attempt.container.containerId, image: attempt.container.imageId, started: attempt.container.startedAt ?? '—', ended: attempt.container.finishedAt ?? '—', cpus: attempt.container.resources.cpus, memory: formatBytes(attempt.container.resources.memoryBytes, locale) }, locale)}`, 'muted')]] : []),
    ...describeDiagnostics(attempt.diagnostics ?? [], locale).map(entry => [span(`    ${entry.note ? entry.text : `${w.marks.warn} ${entry.text}`}`, entry.note ? 'muted' : 'warning')]),
    ...(attempt.endedAtMs === null && live ? [[span(`    ${t('monitor.detail.live', { phase: workerPhaseLabel(attempt.workerPhase, locale),
      heartbeat: attempt.heartbeatAgeMs === null ? '—' : durationText(attempt.heartbeatAgeMs, locale) }, locale)}`, 'muted')]] : []),
    ...(attempt.firstFailure ? [[span(`    ${t('monitor.detail.firstFailure', { line: attempt.firstFailure }, locale)}`, 'error')]]
      : cause && cause.kind !== 'tests' ? [[span(`    ${t('monitor.detail.cause', { cause: stopCauseText(cause, locale) }, locale)}`, 'warning')]] : []),
    ...failedTestLines(w, attempt),
    ...(attempt.recentEvents?.length ? [[span(`    ${t('monitor.detail.events', { count: attempt.recentEvents.length }, locale)}`, 'muted')],
      ...attempt.recentEvents.map(event => [span(`      ${timeText(event.atMs)} ${w.marks.sep} ${event.kind} ${w.marks.sep} ${event.summary}`)])] : []),
  ];
}
const taskFailed = (task: MonitorTask) => task.phase === 'failed' || task.evaluation.verdict === 'rejected';
const failureCause = (task: MonitorTask) => taskFailed(task) ? projectStopCause(task) : null;

function runDetail(w: Words, install: MonitorInstall, run: MonitorRun) {
  const { locale, now, sep } = w;
  return (): readonly MonitorLine[] => [
    [span(t('monitor.detail.run', { run: run.runId, scope: run.scopeId, revision: run.revision, install: install.id }, locale), 'strong')],
    ...(run.costReport ? [renderCostSummary(run.costReport, locale), ...renderRecommendationLines(run.costReport, locale)].map(text => [span(text)]) : []),
    ...(run.authority ? [[span(t('cli.run.inspect.authority', { record: run.authority.decision.eventId, sequence: run.authority.decision.sequence,
      approval: run.authority.approval?.approvalId ?? '-' }, locale), 'muted')]] : []),
    [w.stateCell(run), span(sep), span(w.progress(run)), span(sep), span(t('monitor.detail.span', { created: timeText(run.createdAtMs ?? null), duration: w.runDuration(run) }, locale)),
      span(sep), span(t('monitor.detail.activity', { when: agoText(now, run.lastActivityMs, locale) }, locale), 'muted')],
    ...(run.graphSummary ? renderGraphSummaryLines(run.graphSummary, locale, w.ascii).map(text => [span(text, 'muted')]) : []),
    ...globalStateLines(projectHumanState({ kind: 'run', value: run }), locale),
    ...(run.blocker ? [[span(t('monitor.detail.blocker', { reason: w.blockerText(run.blocker), task: run.blocker.taskId ?? '—', since: forText(now, run.blocker.sinceMs, locale) }, locale),
      blockerRole(run.blocker))]] : []),
    ...(run.blocker?.deadlineMs !== undefined ? [[span(expiryText(now, run.blocker.deadlineMs, locale), 'warning')]] : []),
    ...(run.cancellationRequested ? [[span(t('monitor.detail.cancelRequested', {}, locale), 'warning')]] : []),
    ...run.tasks.flatMap(task => {
      const worker = w.workerOf(install, run, task);
      const state = projectHumanState({ kind: 'task', value: task, blocker: run.blocker, ...(worker ? { worker } : {}) });
      return [
      [globalStateCell(state, locale), span(sep), span(t('monitor.detail.task', { task: task.taskId, kind: task.kind, phase: taskPhaseLabel(task.phase, locale), attempts: task.attempts,
        profile: task.profile ? `${task.profile.id}@${task.profile.version}` : '—' }, locale), taskFailed(task) ? 'error' : task.phase === 'accepted' ? 'success' : undefined)],
      ...globalStateLines(state, locale),
      ...(task.waiting ? [[span(t('monitor.detail.poolWait', { reason: blockerLabel(task.waiting.code, locale), pool: task.waiting.poolId, execution: task.waiting.occupancy.execution, inFlight: task.waiting.occupancy.inFlight, executionSlots: task.waiting.effectiveCapacity.executionSlots, inFlightSlots: task.waiting.effectiveCapacity.inFlightSlots }, locale), 'warning')]] : []),
      ...(task.decision ? [[span(`    ${blockerLabel(task.decision.reason === 'needs-input' ? 'awaiting-decision' : task.decision.reason, locale)} ${sep} ${expiryText(now, task.decision.deadlineMs, locale)}`, 'warning')]] : []),
      ...(task.decision?.question ? [[span(t('cli.run.lifecycle.question', { question: task.decision.question }, locale), 'warning')]] : []),
      ...(task.billingAxis !== undefined ? [[span(t('billing.axis', { axis: task.billingAxis ? { subscription: t('billing.subscription', {}, locale), local: t('billing.local', {}, locale), metered: t('billing.metered', {}, locale) }[task.billingAxis] : t('proposal.planning.unknown', {}, locale) }, locale))]] : []),
      ...(task.lastAttempt ? attemptLines(w, task.lastAttempt, failureCause(task), task.phase === 'active') : []),
      [span(`    ${t('monitor.detail.evaluation', { verdict: verdictLabel(task.evaluation.verdict, locale),
        when: task.evaluation.observedAtMs === null ? '' : agoText(now, task.evaluation.observedAtMs, locale) }, locale).trimEnd()}`, 'muted')],
      ...(task.custodyDisposition ? [[span(task.custodyDisposition === 'released' ? t('task.custody.released', {}, locale) : t('task.custody.hold-manual', {}, locale), 'warning')]] : []),
      ...(task.acceptance ? [[span(renderAcceptanceLine(task.acceptance, locale), 'muted')]] : []),
      ...(task.handoffs ?? []).map(receipt => [span(`    ${(receipt.kind === 'workspace-started-from-patch' ? t('monitor.detail.workspaceStartedFromPatch', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale) : t('monitor.detail.handoffReceived', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale))}`, 'success')]),
      ...(task.configExclusions ? [[span(`    ${t('monitor.detail.configExcluded', { count: task.configExclusions.count }, locale)}`, 'warning')],
        ...task.configExclusions.entries.map(entry => [span(t('monitor.detail.configExcludedEntry', { path: entry.path, rule: entry.rule, by: entry.by }, locale), 'muted')])] : []),
      ...(task.evaluation.reason ? [[span(`    ${notAcceptedLabel(task.evaluation.reason, locale)}`, 'error')]] : []),
      ...(task.dependencies.length ? [[span(`    ${t('monitor.detail.dependencies', { list: task.dependencies.join(', ') }, locale)}`, 'muted')]] : []),
    ]; }),
    run.delivery === undefined ? [span(t('monitor.detail.deliveryUnknown', {}, locale), 'muted')]
      : run.delivery === null ? [span(run.deliveryOutlook ? deliveryOutlookDetail(run.deliveryOutlook, locale) : t('monitor.detail.deliveryNone', {}, locale), run.deliveryOutlook ? OUTLOOK_ROLE[run.deliveryOutlook] : 'muted')]
      : [span(t('monitor.detail.delivery', { state: deliveryLabel(run.delivery.state, locale), commit: run.delivery.commit ?? '—' }, locale), DELIVERY_ROLE[run.delivery.state])],
  ];
}

function runRow(w: Words, install: MonitorInstall, run: MonitorRun, cells: readonly MonitorSpan[]): MonitorRow {
  const state = [projectHumanState({ kind: 'run', value: run }).state, globalStateLabel(projectHumanState({ kind: 'run', value: run }).state, w.locale), run.state, runStateLabel(run.state, w.locale), run.blocker?.code ?? '', run.blocker ? blockerLabel(run.blocker.code, w.locale) : ''].join(' ').toLowerCase();
  return { key: `${install.id}:${w.runName(run)}`, detail: runDetail(w, install, run), cells,
    facets: { state, install: install.id.toLowerCase(), kind: run.tasks.map(task => task.kind).join(' ').toLowerCase(), run: run.runId.toLowerCase(),
      stateLabel: globalRunCell(run, w.locale).text },
    sort: { age: run.createdAtMs ?? run.lastActivityMs, state: STATE_RANK[run.state], name: run.runId },
    signature: `${run.state}|${run.blocker?.code ?? ''}|${run.tasks.map(task => `${task.phase}/${task.lastAttempt?.workerPhase ?? ''}`).join(',')}` };
}

function runsBlock(w: Words, runs: readonly Entry<MonitorRun>[]): MonitorBlock {
  const { locale, now } = w;
  // Newest admission first; Runs without a proven admission time go last (by last activity). The Summary keeps the oldest stuck Run first.
  const at = (run: MonitorRun) => [run.createdAtMs ?? null, run.lastActivityMs ?? -1] as const;
  const ordered = [...runs].sort((a, b) => { const [ca, la] = at(a.value), [cb, lb] = at(b.value);
    return ca === null || cb === null ? (ca === null ? 1 : 0) - (cb === null ? 1 : 0) || lb - la : cb - ca; });
  return { kind: 'table', empty: t('monitor.empty.runs', {}, locale), columns: [
    w.col(t('monitor.col.run', {}, locale), 0, 20, 44, { sortKey: 'name' }), w.col(t('monitor.col.state', {}, locale), 1, 18, 28, { sortKey: 'state' }),
    w.col(t('monitor.col.blocker', {}, locale), 2, 22, 48), w.col(t('monitor.col.since', {}, locale), 4, 12, 16),
    w.col(t('monitor.col.duration', {}, locale), 3, 12, 16, { sortKey: 'age' }), w.col(t('monitor.col.tasks', {}, locale), 5, 12, 16),
    w.col(t('monitor.col.delivery', {}, locale), 3, 15, 24),
    w.col(t('monitor.col.scope', {}, locale), 6, 8, 24), ...w.installColumn(7), w.col(t('monitor.col.activity', {}, locale), 8, 14, 20)],
  rows: ordered.map(({ install, value: run }) => runRow(w, install, run, [
    span(run.runId), w.stateCell(run), run.blocker ? span(w.blockerText(run.blocker), blockerRole(run.blocker)) : span('—', 'muted'),
    span(run.blocker ? w.age(run.blocker.sinceMs) : '—'), span(OPEN.includes(run.state) ? t('monitor.duration.open', {}, locale) : w.runDuration(run),
      OPEN.includes(run.state) ? 'info' : undefined), span(w.progress(run)),
    run.delivery || run.deliveryOutlook ? span(w.deliveryText(run), w.deliveryRole(run)) : span('—', 'muted'), span(run.scopeId, 'muted'), ...w.installCell(install),
    span(agoText(now, run.lastActivityMs, locale), 'muted')])) };
}

function workerDetail(w: Words, install: MonitorInstall, worker: MonitorWorker) {
  const { locale } = w;
  return (): readonly MonitorLine[] => {
    const activity = worker.files?.activity ?? null, usage = resolveWorkerUsage(worker), own = w.attemptOf(install, worker);
    const state = projectHumanState({ kind: 'worker', value: worker, ...w.workerSubject(install, worker) });
    const status = [[globalStateCell(state, locale)], ...globalStateLines(state, locale)];
    const activityLine = [span(t('monitor.detail.now', { phase: workerPhaseLabel(activity?.phase ?? own?.attempt.workerPhase, locale), target: [activity?.target, activity?.detail].filter(Boolean).join(' — ') || '—' }, locale))];
    const resources = worker.resources ? renderResourceDetail(worker.resources, locale).map(text => [span(text)]) : [];
    if (worker.human) return [...status, activityLine, ...resources, ...humanWorkerLines(worker, locale, w.workTitle(install, worker))];
    return [
      ...status,
      ...resources,
      [span(t('monitor.detail.worker', { task: w.workerName(worker), attempt: worker.identity?.attemptId ?? '—', generation: worker.identity?.generation ?? '—',
        provider: formatKnown(worker.provider, locale), install: install.id }, locale), 'strong')],
      activityLine,
      [span(t('monitor.detail.heartbeat', { heartbeat: w.heartbeat(worker).text, process: w.processText(worker), pid: worker.files?.pid ?? '—', handle: worker.handle ?? '—' }, locale))],
      ...(own ? attemptLines(w, own.attempt, failureCause(own.task), own.task.phase === 'active' && !worker.terminal) : []),
      ...(usage ? [[span(t('monitor.detail.usage', { turns: usage.turns ?? '—', input: usage.tokenUsageRecorded === true ? usage.tokens.input : '—', output: usage.tokenUsageRecorded === true ? usage.tokens.output : '—',
        cost: usage.costUsd === null ? '—' : formatUsd(usage.costUsd, locale), tools: usage.toolErrors }, locale))]]
        : worker.usageEvidence === 'invalid' || worker.usageEvidence === 'unavailable' ? [[span(t('cli.workers.usageRejected', { reason: worker.usageEvidence === 'invalid' ? t('cli.workers.usageEvidence.invalid', {}, locale) : t('cli.workers.usageEvidence.unavailable', {}, locale) }, locale), 'warning')]] : []),
      ...(worker.model ? [[span(renderWorkerModelLine(worker.model, locale))]] : []),
      ...(worker.workspace ? [[span(t('monitor.detail.workspace', { path: worker.workspace }, locale), 'muted')]] : []),
      ...(worker.custody === 'released' ? [[span(t('monitor.detail.released', {}, locale), 'muted')]] : []),
      ...describeDiagnostics(worker.diagnostics, locale).map(entry => [span(entry.note ? entry.text : `${w.marks.warn} ${entry.text}`, entry.note ? 'muted' : 'warning')]),
    ];
  };
}

function workersBlock(w: Words, entries: readonly Entry<MonitorWorker>[], empty: string): MonitorBlock {
  const { locale } = w;
  const resources = entries.some(entry => entry.value.resources !== undefined);
  const started = (entry: Entry<MonitorWorker>) => w.attemptOf(entry.install, entry.value)?.attempt.startedAtMs ?? null;
  // Newest first by the matched attempt's start (workers carry no time of their own); unmatched last, in observation order.
  const ordered = entries.map((entry, index) => ({ entry, index, at: started(entry) })).sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.index - b.index);
  return { kind: 'table', empty, columns: [w.col(t('monitor.col.task', {}, locale), 0, 20, 48, { sortKey: 'name' }), w.col(t('monitor.col.state', {}, locale), 1, 10, 24),
    w.col(t('monitor.col.heartbeat', {}, locale), 2, 10, 20), w.col(t('monitor.col.process', {}, locale), 3, 9, 20, { sortKey: 'state' }),
    w.col(t('monitor.col.attempt', {}, locale), 6, 8, 8), w.col(t('monitor.col.model', {}, locale), 4, 16, 32), ...(resources ? [w.col(t('resource.column', {}, locale), 4, 18, 88)] : []), ...w.installColumn(5)],
  rows: ordered.map(({ entry: { install, value: worker }, at }): MonitorRow => {
    const own = w.attemptOf(install, worker), phase = worker.files?.activity?.phase ?? (worker.terminal ? null : own?.attempt.workerPhase ?? null);
    const status = projectHumanState({ kind: 'worker', value: worker, ...w.workerSubject(install, worker) });
    return { key: `${install.id}:${worker.identity?.attemptId ?? worker.taskId}`, detail: workerDetail(w, install, worker),
      // PRE-5: `--once` is a summary; a worker's full detail is printed with --verbose, a held worker's always (it waits for a person).
      detailInText: status.state === 'held' || (w.verbose && !!worker.human), detailOnVerbose: !!worker.human && status.state !== 'held',
      ...(status.state === 'held' ? { context: [[globalStateCell(status, locale)]] } : {}), cells: [span(worker.human ? w.workTitle(install, worker) : w.workerName(worker)),
      status.state === 'held' ? span(globalStateLabel('held', locale), 'warning') : globalStateCell(status, locale), w.heartbeat(worker), span(w.processText(worker), worker.process === 'running' ? undefined : 'muted'),
      span(short(worker.identity?.attemptId, 8), 'muted'), span(`${formatKnown(worker.provider, locale)}/${modelOf(w, install, worker) ?? '—'}`, 'muted'), ...(resources ? [span(renderResourceLine(worker.resources, locale))] : []), ...w.installCell(install)],
    facets: { state: `${status.state} ${globalStateLabel(status.state, locale)} ${worker.process} ${processLabel(worker.process, locale)} ${phase ?? ''}`.toLowerCase(), install: install.id.toLowerCase(),
      kind: own?.task.kind.toLowerCase() ?? '', run: worker.identity?.runId.toLowerCase() ?? '', stateLabel: globalStateCell(status, locale).text },
    sort: { age: at, state: worker.process === 'running' ? 0 : 1, name: worker.taskId },
    signature: `${worker.process}|${phase ?? ''}|${worker.terminal?.exitCode ?? ''}|${worker.files?.heartbeat.freshness ?? ''}` };
  }) };
}

/** `compact` (summary) keeps subject, wait and expiry; the Approvals tab adds the required assurance and the scope. */
function approvalsBlock(w: Words, entries: readonly Entry<MonitorApproval>[], compact: boolean): MonitorBlock {
  const { locale, now } = w;
  const detail = (install: MonitorInstall, approval: MonitorApproval) => (): readonly MonitorLine[] => [
    [span(t('monitor.detail.approval', { id: approval.approvalId, scope: approval.scopeId, kind: approval.subjectKind, install: install.id }, locale), 'strong')],
    [approval.summary ? span(approval.summary) : span(t('monitor.approval.summaryHidden', {}, locale), 'muted')],
    [span(t('monitor.detail.assurance', { assurance: approval.requiredAssurance ?? '—' }, locale))],
    [span(t('monitor.detail.waiting', { since: agoText(now, approval.createdAtMs, locale), expires: expiryText(now, approval.expiresAtMs, locale) }, locale), 'muted')],
    [span(t('monitor.detail.approvalHint', { id: approval.approvalId }, locale), 'muted')],
  ];
  return { kind: 'table', empty: t('monitor.empty.approvals', {}, locale), columns: [
    w.col(t('monitor.col.subject', {}, locale), 0, 24, 60, { sortKey: 'name' }), w.col(t('monitor.col.waiting', {}, locale), 1, 11, 16, { sortKey: 'age' }),
    w.col(t('monitor.col.expires', {}, locale), 2, 16, 26), ...(compact ? [] : [w.col(t('monitor.col.assurance', {}, locale), 3, 9, 20),
      w.col(t('monitor.col.scope', {}, locale), 4, 8, 20)]), ...w.installColumn(5)],
  rows: entries.map(({ install, value: approval }): MonitorRow => ({ key: `${install.id}:${approval.approvalId}`, detail: detail(install, approval),
    facets: { state: `awaiting-approval ${approval.subjectKind}`.toLowerCase(), install: install.id.toLowerCase() },
    sort: { age: approval.createdAtMs, name: approval.approvalId }, signature: `${approval.expiresAtMs ?? ''}`, cells: [
    span(`${approval.subjectKind}: ${approval.summary || t('monitor.approval.summaryHidden', {}, locale)}`), span(w.age(approval.createdAtMs), 'warning'),
    span(expiryText(now, approval.expiresAtMs, locale), approval.expiresAtMs !== null && approval.expiresAtMs < now ? 'error' : 'muted'),
    ...(compact ? [] : [span(approval.requiredAssurance ?? '—', 'muted'), span(approval.scopeId, 'muted')]), ...w.installCell(install)] })) };
}

function poolsBlock(w: Words, entries: readonly Entry<MonitorPool>[]): MonitorBlock {
  const { locale, marks } = w;
  const held = (pool: MonitorPool) => pool.held ? span(`${marks.warn} ${t('monitor.pool.held', { by: pool.heldBy ?? '—' }, locale)}`, 'warning')
    : span(t('monitor.pool.notHeld', {}, locale), 'muted');
  const usage = (pool: MonitorPool) => t('monitor.pool.usage', { inFlight: pool.inFlight, capacity: pool.capacity ?? t('monitor.pool.unbounded', {}, locale) }, locale);
  return { kind: 'table', empty: t('monitor.empty.pools', {}, locale), columns: [
    w.col(t('monitor.col.pool', {}, locale), 0, 12, 32, { sortKey: 'name' }), w.col(t('monitor.col.usage', {}, locale), 1, 8, 20),
    w.col(t('monitor.col.held', {}, locale), 2, 10, 40, { sortKey: 'state' }),
    ...w.installColumn(3)],
  rows: entries.map(({ install, value: pool }): MonitorRow => ({ key: `${install.id}:${pool.poolId}`, facets: { state: pool.held ? 'held' : '', install: install.id.toLowerCase() },
    sort: { state: pool.held ? 0 : 1, name: pool.poolId }, signature: `${pool.inFlight}|${pool.held}`, cells: [
    span(pool.poolId), span(usage(pool), pool.capacity !== null && pool.inFlight >= pool.capacity ? 'warning' : undefined), held(pool), ...w.installCell(install)],
  detail: () => [[span(t('monitor.detail.pool', { pool: pool.poolId, install: install.id }, locale), 'strong')], [span(usage(pool))], [held(pool)]] })) };
}

/** M-VIS: pools the viewer may not `pool inspect` are one bare count (no name, capacity or holder). */
const hiddenPools = (installs: readonly MonitorInstall[], locale: Locale): MonitorBlock[] => {
  const count = installs.reduce((sum, install) => sum + (install.hiddenPools ?? 0), 0);
  return count ? [{ kind: 'line', line: [span(t('monitor.pool.hidden', { count }, locale), 'muted')] }] : [];
};

/** What needs a human first: counts, install problems, approvals, stuck Runs (oldest blocker first), failed Runs, live workers. */
function summaryBlocks(w: Words, installs: readonly MonitorInstall[], runs: readonly Entry<MonitorRun>[], stuck: readonly Entry<MonitorRun>[],
  approvals: readonly Entry<MonitorApproval>[], workers: readonly Entry<MonitorWorker>[]): MonitorBlock[] {
  const { locale, now, marks } = w;
  const heading = (text: string): MonitorBlock => ({ kind: 'line', line: [span(text, 'sectionHeader')] });
  const blank: MonitorBlock = { kind: 'line', line: [span('')] };
  // PRE-34: the same projection as the counter line, so "N durdu" and this section always agree (failed, cancelled, incomplete, rolled back).
  const failed = runs.flatMap(entry => { const stop = projectRunStop(entry.value); return stop ? [{ ...entry, stop }] : []; });
  const running = workers.filter(entry => entry.value.process === 'running');
  // "Why did it stop": the first stopped task's cause from the shared projection (recorded first failing line first), or an honest "not recorded".
  const firstFailure = (run: MonitorRun, { taskId, cause }: NonNullable<ReturnType<typeof projectRunStop>>) => `${run.state === 'accepted' ? marks.warn : marks.states[run.state]} ${cause.kind === 'tests' && taskId
    ? t('monitor.summary.failedTests', { task: taskId, count: cause.count, name: cause.name ?? '—' }, locale) : `${taskId ? `${taskId}: ` : ''}${stopCauseText(cause, locale)}`}`;
  return [
    { kind: 'line', line: [span(globalSummary({ installs }, locale), 'strong')] },
    ...installs.filter(install => install.status !== 'available' || w.warnings(install).length).map((install): MonitorBlock => {
      const problems = w.warnings(install).map(entry => entry.text).join('; ') || '—';
      return { kind: 'line', line: [span(`${marks.warn} ${install.status === 'available' ? t('monitor.summary.installWarnings', { install: install.id, problems }, locale)
        : t('monitor.summary.installProblem', { install: install.id, status: installStatusLabel(install.status, locale), problems }, locale)}`,
      install.status === 'available' ? 'warning' : 'error')] };
    }),
    ...installs.flatMap(install => w.notes(install).map((entry): MonitorBlock => ({ kind: 'line', line: [span(t('monitor.summary.installNote', { install: install.id,
      note: entry.text }, locale), 'muted')] }))),
    blank, heading(t('monitor.summary.yours', { count: approvals.length }, locale)), approvalsBlock(w, approvals, true),
    blank, heading(t('monitor.summary.stuck', { count: stuck.length }, locale)),
    { kind: 'table', empty: runs.some(entry => OPEN.includes(entry.value.state)) ? t('monitor.summary.noStuck', {}, locale) : t('monitor.summary.noOpenRuns', {}, locale),
      columns: [w.col(t('monitor.col.run', {}, locale), 0, 18, 44), w.col(t('monitor.col.blockedTask', {}, locale), 3, 10, 24),
        w.col(t('monitor.col.reason', {}, locale), 1, 22, 50), w.col(t('monitor.col.since', {}, locale), 2, 12, 16),
        w.col(t('monitor.col.scope', {}, locale), 4, 8, 24), ...w.installColumn(5)],
      rows: stuck.map(({ install, value: run }) => runRow(w, install, run, [
        span(run.runId), span(run.blocker!.taskId ?? '—', 'muted'), span(`${marks.states[run.state]} ${w.blockerText(run.blocker!)}`, blockerRole(run.blocker!)),
        span(w.age(run.blocker!.sinceMs)), span(run.scopeId, 'muted'), ...w.installCell(install)])) },
    ...stuck.flatMap(({ value: run }) => run.blocker!.deadlineMs === undefined ? [] : [{ kind: 'line' as const, line: [span(`${run.runId} ${w.sep} ${run.tasks.filter(task => task.decision).map(task => blockerLabel(task.decision!.reason === 'needs-input' ? 'awaiting-decision' : task.decision!.reason, locale)).join(', ')} ${w.sep} ${expiryText(w.now, run.blocker!.deadlineMs, locale)}`, 'warning')] }]),
    ...runs.filter(({ value: run }) => run.deliveryOutlook === 'patch-not-prepared').map(({ value: run }) => ({ kind: 'line' as const, line: [span(`${marks.warn} ${t('monitor.summary.patchNotPrepared', { run: run.runId }, locale)}`, 'warning')] })),
    ...runs.flatMap(({ value: run }) => run.tasks.flatMap(task => task.evaluation.reason ? [{ kind: 'line' as const, line: [span(`${run.runId}/${task.taskId} ${w.sep} ${notAcceptedLabel(task.evaluation.reason, locale)}`, 'error')] }] : [])),
    ...(failed.length ? [blank, heading(t('monitor.summary.failed', { count: failed.length }, locale)), { kind: 'table' as const, empty: '',
      columns: [w.col(t('monitor.col.run', {}, locale), 0, 20, 44), w.col(t('monitor.col.firstFailure', {}, locale), 1, 24, 90),
        w.col(t('monitor.col.activity', {}, locale), 2, 14, 20), w.col(t('monitor.col.scope', {}, locale), 4, 8, 24), ...w.installColumn(3)],
      rows: failed.map(({ install, value: run, stop }) => runRow(w, install, run, [
        span(run.runId), span(firstFailure(run, stop), 'error'), span(agoText(now, run.lastActivityMs, locale), 'muted'), span(run.scopeId, 'muted'),
        ...w.installCell(install)])) }] : []),
    blank, heading(t('monitor.summary.workers', { count: running.length }, locale)), workersBlock(w, running, t('monitor.summary.noWorkers', {}, locale)),
  ];
}

/** One line per install, status first (PB-MON-UX): reachable marker and name, status word, problem count, then the folder; build details live in Kurulumlar. */
function headerLines(w: Words, installs: readonly MonitorInstall[]): MonitorLine[] {
  const { locale, now, marks, sep } = w;
  return [
    [span(t('monitor.title', {}, locale), 'sectionHeader'), span(sep), span(t('monitor.observed', { time: clockText(now) }, locale)), span(sep),
      span(t('monitor.observeOnly', {}, locale), 'muted')],
    ...(installs.length ? installs.map((install): MonitorLine => {
      const ok = install.status === 'available';
      return [span(`${ok ? marks.on : marks.off} ${installName(install)}`, ok ? 'success' : 'error'), span(sep), installState(w, install), span(sep), problemsSpan(w, install),
        span(sep), span(install.path, 'muted')];
    }) : [[span(t('monitor.empty.installs', {}, locale), 'muted')]]),
  ];
}

export function buildMonitorView(snapshot: MonitorSnapshot, locale: Locale, ascii: boolean, verbose = false): MonitorView {
  const w = wordsFor(snapshot, locale, ascii, verbose), installs = snapshot.installs;
  const runs = each(installs, install => install.runs);
  const stuck = runs.filter(entry => OPEN.includes(entry.value.state) && entry.value.blocker && !MOVING.has(entry.value.blocker.code))
    .sort((a, b) => (a.value.blocker!.sinceMs ?? Infinity) - (b.value.blocker!.sinceMs ?? Infinity) || w.runName(a.value).localeCompare(w.runName(b.value)));
  const recordedApprovals = each(installs, install => install.approvals);
  const approvals = recordedApprovals.filter(({ value }) => (value.status === undefined || value.status === 'pending')
    && (value.expiresAtMs === null || value.expiresAtMs > snapshot.observedAt)).sort((a, b) => (a.value.createdAtMs ?? Infinity) - (b.value.createdAtMs ?? Infinity));
  const expired = recordedApprovals.filter(({ value }) => value.status === 'expired' || value.status !== 'decided' && value.expiresAtMs !== null && value.expiresAtMs <= snapshot.observedAt).length;
  const history: MonitorBlock[] = expired ? [{ kind: 'line', line: [span(t('monitor.approval.expiredCount', { count: expired }, locale), 'muted')] }] : [];
  const workers = each(installs, install => install.workers);
  const tabs: Record<MonitorTab, readonly MonitorBlock[]> = {
    summary: [...summaryBlocks(w, installs, runs, stuck, approvals, workers), ...history], runs: [runsBlock(w, runs),
      ...runs.flatMap(({ value: run }) => globalStateLines(projectHumanState({ kind: 'run', value: run }), locale).map(line => ({ kind: 'line' as const, line: [span(`${run.runId} ${w.sep} `), ...line] })))],
    workers: [workersBlock(w, workers, t('monitor.empty.workers', {}, locale))], approvals: [approvalsBlock(w, approvals, false), ...history],
    pools: [poolsBlock(w, each(installs, install => install.pools)), ...hiddenPools(installs, locale)], installs: installsBlocks(w, installs), map: mapBlocks(installs, locale, { ok: w.marks.ok, off: w.marks.off, warn: w.marks.warn, next: w.marks.next, sep: w.marks.sep }),
  };
  return { header: headerLines(w, installs), tabs: Object.fromEntries(MONITOR_TABS.map(tab => [tab, tabs[tab]])) as Record<MonitorTab, readonly MonitorBlock[]> };
}
