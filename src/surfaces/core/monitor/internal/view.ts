import { t, type Locale } from '#platform/index.js';
import type { MonitorApproval, MonitorBlocker, MonitorInstall, MonitorPool, MonitorRun, MonitorRunState, MonitorSnapshot, WorkerObservation } from '#engine/index.js';
import { span, type MonitorBlock, type MonitorColumn, type MonitorLine, type MonitorRole, type MonitorRow, type MonitorSpan } from './layout.js';
import { agoText, blockerLabel, clockText, durationText, expiryText, forText, installStatusLabel, MONITOR_TABS, processLabel, runStateLabel,
  taskPhaseLabel, verdictLabel, workerPhaseLabel, type MonitorTab } from './labels.js';
import { renderWorkerModelLine } from './worker-model.js';

/**
 * The one view model of the MonitorSnapshot (MONITOR-SURFACE): the `--once` text, `/monitor` and the fullscreen view all project these
 * blocks. Every time is relative to the snapshot's `observedAt` (the age as observed, stable for a given snapshot). The blocker is the
 * engine's; this surface only words and orders it.
 */
export interface MonitorFilters { readonly install?: string; readonly scope?: string }
export interface MonitorView { readonly header: readonly MonitorLine[]; readonly tabs: Readonly<Record<MonitorTab, readonly MonitorBlock[]>> }
interface Marks { readonly states: Readonly<Record<MonitorRunState, string>>; readonly warn: string; readonly on: string; readonly off: string; readonly sep: string }
const UNICODE: Marks = { states: { progressing: '▶', waiting: '~', blocked: '!', accepted: '✓', failed: '✗', cancelled: '■' }, warn: '⚠', on: '●', off: '○', sep: '·' };
const ASCII: Marks = { states: { progressing: '>', waiting: '~', blocked: '!', accepted: '+', failed: 'x', cancelled: '-' }, warn: '!', on: '*', off: 'o', sep: '|' };
const STATE_ROLE: Readonly<Record<MonitorRunState, MonitorRole>> = { progressing: 'info', waiting: 'warning', blocked: 'error', accepted: 'success',
  failed: 'error', cancelled: 'muted' };
const OPEN: readonly MonitorRunState[] = ['progressing', 'waiting', 'blocked'];
/** Not a stall: the Run moves (or its worker runs) on its own. */
const MOVING = new Set(['none', 'worker-running']);
const blockerRole = (blocker: MonitorBlocker): MonitorRole => blocker.code === 'awaiting-approval' ? 'warning' : MOVING.has(blocker.code) ? 'muted'
  : ['worker-stale-heartbeat', 'unresolved-effect', 'evaluation-unknown', 'worker-exited-unevaluated', 'unknown'].includes(blocker.code) ? 'error' : 'warning';
const short = (value: string | null | undefined, size: number) => value ? value.slice(0, size) : '—';

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
function wordsFor(snapshot: MonitorSnapshot, locale: Locale, ascii: boolean) {
  const marks = ascii ? ASCII : UNICODE, now = snapshot.observedAt, multi = snapshot.installs.length > 1, sep = ` ${marks.sep} `;
  const builtAt = (value: string | null) => { const ms = value === null ? NaN : Date.parse(value); return Number.isFinite(ms) ? clockText(ms) : value ?? '—'; };
  const words = {
    locale, now, marks, sep, multi,
    col: (header: string, priority: number, min: number, max: number, cut?: 'start'): MonitorColumn => cut ? { header, priority, min, max, cut } : { header, priority, min, max },
    installColumn: (priority: number): readonly MonitorColumn[] => multi ? [{ header: t('monitor.col.install', {}, locale), priority, min: 8, max: 16 }] : [],
    installCell: (install: MonitorInstall): readonly MonitorSpan[] => multi ? [span(install.id, 'muted')] : [],
    stateCell: (state: MonitorRunState) => span(`${marks.states[state]} ${runStateLabel(state, locale)}`, STATE_ROLE[state]),
    blockerText: (blocker: MonitorBlocker) => `${blockerLabel(blocker.code, locale)}${blocker.detail ? ` (${blocker.detail})` : ''}`,
    runName: (run: MonitorRun) => `${run.scopeId}/${run.runId}`,
    progress: (run: MonitorRun) => t('monitor.progress', { accepted: run.phaseCounts['accepted'] ?? run.tasks.filter(task => task.phase === 'accepted').length,
      total: run.tasks.length }, locale),
    serviceText: (install: MonitorInstall) => !install.service ? t('monitor.service.none', {}, locale)
      : install.service.state === 'running' ? t('monitor.service.running', { pid: install.service.processId ?? '—' }, locale)
        : install.service.state === 'stopped' ? t('monitor.service.stopped', {}, locale) : t('monitor.service.unknown', {}, locale),
    buildText: (install: MonitorInstall) => install.service?.build
      ? t('monitor.build', { commit: short(install.service.build.sourceCommit, 12), builtAt: builtAt(install.service.build.builtAt) }, locale)
      : t('monitor.build.unknown', {}, locale),
    ledgerText: (install: MonitorInstall) => install.ledgerVersion === null ? t('monitor.ledger.unknown', {}, locale) : t('monitor.ledger', { version: install.ledgerVersion }, locale),
    diagnosticsText: (install: MonitorInstall) => t('monitor.diagnostics', { count: install.diagnostics.length, codes: install.diagnostics.join(', ') }, locale),
    /** A bare age for table cells whose header already says since/for (`3 h 12 min`); details keep the full sentence. */
    age: (since: number | null) => since === null ? t('monitor.time.unknown', {}, locale) : durationText(now - since, locale),
    workerName: (worker: WorkerObservation) => `${worker.identity?.runId ?? '—'}/${worker.taskId}`,
    heartbeat: (worker: WorkerObservation): MonitorSpan => worker.custody === 'released' ? span(t('monitor.heartbeat.released', {}, locale), 'muted')
      : !worker.files || worker.files.heartbeat.ageMs === null ? span('—', 'muted')
        : worker.files.heartbeat.freshness === 'stale' ? span(`${marks.warn} ${t('monitor.heartbeat.stale', { age: durationText(worker.files.heartbeat.ageMs, locale) }, locale)}`, 'error')
          : span(durationText(worker.files.heartbeat.ageMs, locale), worker.files.heartbeat.freshness === 'fresh' ? 'success' : 'muted'),
    processText: (worker: WorkerObservation) => `${processLabel(worker.process, locale)}${worker.terminal ? ` ${worker.terminal.exitCode ?? worker.terminal.signal ?? '—'}` : ''}`,
    modelText: (worker: WorkerObservation) => `${worker.provider}/${worker.model?.requested.modelId ?? worker.files?.usage?.model ?? '—'}`,
  };
  return words;
}
type Words = ReturnType<typeof wordsFor>;

function runDetail(w: Words, install: MonitorInstall, run: MonitorRun) {
  const { locale, now, sep } = w;
  return (): readonly MonitorLine[] => [
    [span(t('monitor.detail.run', { run: run.runId, scope: run.scopeId, revision: run.revision, install: install.id }, locale), 'strong')],
    [w.stateCell(run.state), span(sep), span(w.progress(run)), span(sep), span(t('monitor.detail.activity', { when: agoText(now, run.lastActivityMs, locale) }, locale), 'muted')],
    ...(run.blocker ? [[span(t('monitor.detail.blocker', { reason: w.blockerText(run.blocker), task: run.blocker.taskId ?? '—', since: forText(now, run.blocker.sinceMs, locale) }, locale),
      blockerRole(run.blocker))]] : []),
    ...(run.cancellationRequested ? [[span(t('monitor.detail.cancelRequested', {}, locale), 'warning')]] : []),
    ...run.tasks.flatMap(task => {
      const attempt = task.lastAttempt;
      return [
        [span(t('monitor.detail.task', { task: task.taskId, kind: task.kind, phase: taskPhaseLabel(task.phase, locale), attempts: task.attempts,
          profile: task.profile ? `${task.profile.id}@${task.profile.version}` : '—' }, locale), task.phase === 'failed' ? 'error' : task.phase === 'accepted' ? 'success' : undefined)],
        ...(attempt ? [[span(`    ${t('monitor.detail.attempt', { attempt: short(attempt.attemptId, 8), generation: attempt.generation, launch: attempt.launch ?? '—',
          phase: workerPhaseLabel(attempt.workerPhase, locale), heartbeat: attempt.heartbeatAgeMs === null ? '—' : durationText(attempt.heartbeatAgeMs, locale),
          provider: attempt.provider ?? '—', exit: attempt.exitCode ?? '—', started: agoText(now, attempt.startedAtMs, locale) }, locale)}`, 'muted')]] : []),
        [span(`    ${t('monitor.detail.evaluation', { verdict: verdictLabel(task.evaluation.verdict, locale),
          when: task.evaluation.observedAtMs === null ? '' : agoText(now, task.evaluation.observedAtMs, locale) }, locale).trimEnd()}`, 'muted')],
        ...(task.dependencies.length ? [[span(`    ${t('monitor.detail.dependencies', { list: task.dependencies.join(', ') }, locale)}`, 'muted')]] : []),
      ];
    }),
  ];
}

function runsBlock(w: Words, ordered: readonly Entry<MonitorRun>[]): MonitorBlock {
  const { locale, now } = w;
  return { kind: 'table', empty: t('monitor.empty.runs', {}, locale), columns: [
    w.col(t('monitor.col.run', {}, locale), 0, 20, 44), w.col(t('monitor.col.state', {}, locale), 1, 14, 16),
    w.col(t('monitor.col.blocker', {}, locale), 2, 22, 48), w.col(t('monitor.col.since', {}, locale), 3, 12, 16),
    w.col(t('monitor.col.tasks', {}, locale), 4, 12, 16), w.col(t('monitor.col.scope', {}, locale), 5, 8, 24), ...w.installColumn(6),
    w.col(t('monitor.col.activity', {}, locale), 7, 14, 20)],
  rows: ordered.map(({ install, value: run }): MonitorRow => ({ key: `${install.id}:${w.runName(run)}`, detail: runDetail(w, install, run), cells: [
    span(run.runId), w.stateCell(run.state), run.blocker ? span(w.blockerText(run.blocker), blockerRole(run.blocker)) : span('—', 'muted'),
    span(run.blocker ? w.age(run.blocker.sinceMs) : '—'), span(w.progress(run)), span(run.scopeId, 'muted'), ...w.installCell(install),
    span(agoText(now, run.lastActivityMs, locale), 'muted')] })) };
}

function workerDetail(w: Words, install: MonitorInstall, worker: WorkerObservation) {
  const { locale } = w;
  return (): readonly MonitorLine[] => {
    const activity = worker.files?.activity ?? null, usage = worker.files?.usage ?? null;
    return [
      [span(t('monitor.detail.worker', { task: w.workerName(worker), attempt: worker.identity?.attemptId ?? '—', generation: worker.identity?.generation ?? '—',
        provider: worker.provider, install: install.id }, locale), 'strong')],
      [span(t('monitor.detail.now', { phase: workerPhaseLabel(activity?.phase, locale), target: [activity?.target, activity?.detail].filter(Boolean).join(' — ') || '—' }, locale))],
      [span(t('monitor.detail.heartbeat', { heartbeat: w.heartbeat(worker).text, process: w.processText(worker), pid: worker.files?.pid ?? '—', handle: worker.handle ?? '—' }, locale))],
      ...(usage ? [[span(t('monitor.detail.usage', { turns: usage.turns ?? '—', input: usage.tokens.input, output: usage.tokens.output,
        cost: usage.costUsd === null ? '—' : usage.costUsd.toFixed(4), tools: usage.toolErrors }, locale))]] : []),
      ...(worker.model ? [[span(renderWorkerModelLine(worker.model, locale))]] : []),
      ...(worker.workspace ? [[span(t('monitor.detail.workspace', { path: worker.workspace }, locale), 'muted')]] : []),
      ...(worker.custody === 'released' ? [[span(t('monitor.detail.released', {}, locale), 'muted')]] : []),
      ...(worker.diagnostics.length ? [[span(t('monitor.detail.diagnostics', { codes: worker.diagnostics.join(', ') }, locale), 'warning')]] : []),
    ];
  };
}

function workersBlock(w: Words, entries: readonly Entry<WorkerObservation>[], empty: string): MonitorBlock {
  const { locale } = w;
  return { kind: 'table', empty, columns: [w.col(t('monitor.col.task', {}, locale), 0, 20, 48), w.col(t('monitor.col.phase', {}, locale), 1, 10, 18),
    w.col(t('monitor.col.heartbeat', {}, locale), 2, 10, 20), w.col(t('monitor.col.process', {}, locale), 3, 9, 20), w.col(t('monitor.col.attempt', {}, locale), 6, 8, 8),
    w.col(t('monitor.col.model', {}, locale), 4, 16, 32), ...w.installColumn(5)],
  rows: entries.map(({ install, value: worker }): MonitorRow => ({ key: `${install.id}:${worker.identity?.attemptId ?? worker.taskId}`,
    detail: workerDetail(w, install, worker), cells: [span(w.workerName(worker)), span(workerPhaseLabel(worker.files?.activity?.phase, locale), 'info'), w.heartbeat(worker),
      span(w.processText(worker), worker.process === 'running' ? undefined : 'muted'), span(short(worker.identity?.attemptId, 8), 'muted'), span(w.modelText(worker), 'muted'),
      ...w.installCell(install)] })) };
}

/** `compact` (summary) keeps subject, wait and expiry; the Approvals tab adds the required assurance and the scope. */
function approvalsBlock(w: Words, entries: readonly Entry<MonitorApproval>[], compact: boolean): MonitorBlock {
  const { locale, now } = w;
  const detail = (install: MonitorInstall, approval: MonitorApproval) => (): readonly MonitorLine[] => [
    [span(t('monitor.detail.approval', { id: approval.approvalId, scope: approval.scopeId, kind: approval.subjectKind, install: install.id }, locale), 'strong')],
    [span(approval.summary)],
    [span(t('monitor.detail.assurance', { assurance: approval.requiredAssurance ?? '—' }, locale))],
    [span(t('monitor.detail.waiting', { since: agoText(now, approval.createdAtMs, locale), expires: expiryText(now, approval.expiresAtMs, locale) }, locale), 'muted')],
    [span(t('monitor.detail.approvalHint', { id: approval.approvalId }, locale), 'muted')],
  ];
  return { kind: 'table', empty: t('monitor.empty.approvals', {}, locale), columns: [
    w.col(t('monitor.col.subject', {}, locale), 0, 24, 60), w.col(t('monitor.col.waiting', {}, locale), 1, 11, 16),
    w.col(t('monitor.col.expires', {}, locale), 2, 16, 26), ...(compact ? [] : [w.col(t('monitor.col.assurance', {}, locale), 3, 9, 20),
      w.col(t('monitor.col.scope', {}, locale), 4, 8, 20)]), ...w.installColumn(5)],
  rows: entries.map(({ install, value: approval }): MonitorRow => ({ key: `${install.id}:${approval.approvalId}`, detail: detail(install, approval), cells: [
    span(`${approval.subjectKind}: ${approval.summary}`), span(w.age(approval.createdAtMs), 'warning'),
    span(expiryText(now, approval.expiresAtMs, locale), approval.expiresAtMs !== null && approval.expiresAtMs < now ? 'error' : 'muted'),
    ...(compact ? [] : [span(approval.requiredAssurance ?? '—', 'muted'), span(approval.scopeId, 'muted')]), ...w.installCell(install)] })) };
}

function poolsBlock(w: Words, entries: readonly Entry<MonitorPool>[]): MonitorBlock {
  const { locale, marks } = w;
  const held = (pool: MonitorPool) => pool.held ? span(`${marks.warn} ${t('monitor.pool.held', { by: pool.heldBy ?? '—' }, locale)}`, 'warning')
    : span(t('monitor.pool.notHeld', {}, locale), 'muted');
  const usage = (pool: MonitorPool) => t('monitor.pool.usage', { inFlight: pool.inFlight, capacity: pool.capacity ?? t('monitor.pool.unbounded', {}, locale) }, locale);
  return { kind: 'table', empty: t('monitor.empty.pools', {}, locale), columns: [
    w.col(t('monitor.col.pool', {}, locale), 0, 12, 32), w.col(t('monitor.col.usage', {}, locale), 1, 8, 20), w.col(t('monitor.col.held', {}, locale), 2, 10, 40),
    ...w.installColumn(3)],
  rows: entries.map(({ install, value: pool }): MonitorRow => ({ key: `${install.id}:${pool.poolId}`, cells: [
    span(pool.poolId), span(usage(pool), pool.capacity !== null && pool.inFlight >= pool.capacity ? 'warning' : undefined), held(pool), ...w.installCell(install)],
  detail: () => [[span(t('monitor.detail.pool', { pool: pool.poolId, install: install.id }, locale), 'strong')], [span(usage(pool))], [held(pool)]] })) };
}

function installsBlocks(w: Words, installs: readonly MonitorInstall[]): MonitorBlock[] {
  const { locale, marks, sep } = w;
  const detail = (install: MonitorInstall) => (): readonly MonitorLine[] => [
    [span(t('monitor.detail.install', { install: install.id, status: installStatusLabel(install.status, locale) }, locale), 'strong')],
    [span(t('monitor.detail.path', { path: install.path }, locale))],
    [span(t('monitor.detail.scopes', { scopes: install.scopeIds.join(', ') || '—' }, locale))],
    [span(`${w.serviceText(install)}${sep}${t('monitor.detail.instance', { instance: install.service?.instanceId ?? '—' }, locale)}`)],
    [span(`${w.buildText(install)}${sep}${t('monitor.detail.tree', { tree: short(install.service?.build?.sourceTreeSha256, 12) }, locale)}`)],
    [span(w.ledgerText(install))],
    [span(t('monitor.detail.counts', { runs: install.runs.length, workers: install.workers.length, approvals: install.approvals.length, pools: install.pools.length }, locale), 'muted')],
    ...(install.diagnostics.length ? [[span(`${marks.warn} ${w.diagnosticsText(install)}`, 'warning')]] : []),
  ];
  const table: MonitorBlock = { kind: 'table', empty: t('monitor.empty.installs', {}, locale), columns: [
    w.col(t('monitor.col.install', {}, locale), 0, 10, 20), w.col(t('monitor.col.status', {}, locale), 1, 10, 18), w.col(t('monitor.col.service', {}, locale), 2, 18, 28),
    w.col(t('monitor.col.build', {}, locale), 3, 20, 44), w.col(t('monitor.col.path', {}, locale), 4, 16, 60, 'start'), w.col(t('monitor.col.ledger', {}, locale), 5, 8, 22)],
  rows: installs.map((install): MonitorRow => ({ key: install.id, detail: detail(install), cells: [
    span(`${install.status === 'available' ? marks.on : marks.off} ${install.id}`, install.status === 'available' ? 'success' : 'error'),
    span(installStatusLabel(install.status, locale), install.status === 'available' ? undefined : 'error'), span(w.serviceText(install)), span(w.buildText(install), 'muted'),
    span(install.path, 'muted'), span(w.ledgerText(install), 'muted')] })) };
  return installs.length === 1 && installs[0]!.id === 'current'
    ? [table, { kind: 'line', line: [span('')] }, { kind: 'line', line: [span(t('monitor.empty.otherInstalls', {}, locale), 'muted')] }] : [table];
}

/** What needs a human first: counts, install problems, approvals, stuck Runs (oldest blocker first), failed Runs, live workers. */
function summaryBlocks(w: Words, installs: readonly MonitorInstall[], runs: readonly Entry<MonitorRun>[], stuck: readonly Entry<MonitorRun>[],
  approvals: readonly Entry<MonitorApproval>[], workers: readonly Entry<WorkerObservation>[]): MonitorBlock[] {
  const { locale, now, marks } = w;
  const count = (state: MonitorRunState) => runs.filter(entry => entry.value.state === state).length;
  const heading = (text: string): MonitorBlock => ({ kind: 'line', line: [span(text, 'accent')] });
  const blank: MonitorBlock = { kind: 'line', line: [span('')] };
  const failed = runs.filter(entry => entry.value.state === 'failed');
  const running = workers.filter(entry => entry.value.process === 'running');
  const firstFailure = (run: MonitorRun) => {
    const first = run.tasks.find(task => task.phase === 'failed' || task.evaluation.verdict === 'rejected');
    return first ? `${marks.states.failed} ${t('monitor.summary.firstFailure', { task: first.taskId, phase: taskPhaseLabel(first.phase, locale),
      verdict: verdictLabel(first.evaluation.verdict, locale) }, locale)}` : '—';
  };
  return [
    { kind: 'line', line: [span(t('monitor.summary.counts', { progressing: count('progressing'), waiting: count('waiting'), blocked: count('blocked'),
      accepted: count('accepted'), failed: count('failed'), cancelled: count('cancelled') }, locale), 'strong')] },
    ...installs.filter(install => install.status !== 'available' || install.diagnostics.length).map((install): MonitorBlock => ({ kind: 'line', line: [
      span(`${marks.warn} ${install.status === 'available' ? t('monitor.summary.installWarnings', { install: install.id, problems: install.diagnostics.join(', ') }, locale)
        : t('monitor.summary.installProblem', { install: install.id, status: installStatusLabel(install.status, locale), problems: install.diagnostics.join(', ') || '—' }, locale)}`,
      install.status === 'available' ? 'warning' : 'error')] })),
    blank, heading(t('monitor.summary.yours', { count: approvals.length }, locale)), approvalsBlock(w, approvals, true),
    blank, heading(t('monitor.summary.stuck', { count: stuck.length }, locale)),
    { kind: 'table', empty: runs.some(entry => OPEN.includes(entry.value.state)) ? t('monitor.summary.noStuck', {}, locale) : t('monitor.summary.noOpenRuns', {}, locale),
      columns: [w.col(t('monitor.col.run', {}, locale), 0, 18, 44), w.col(t('monitor.col.blockedTask', {}, locale), 3, 10, 24),
        w.col(t('monitor.col.reason', {}, locale), 1, 22, 50), w.col(t('monitor.col.since', {}, locale), 2, 12, 16),
        w.col(t('monitor.col.scope', {}, locale), 4, 8, 24), ...w.installColumn(5)],
      rows: stuck.map(({ install, value: run }): MonitorRow => ({ key: `${install.id}:${w.runName(run)}`, detail: runDetail(w, install, run), cells: [
        span(run.runId), span(run.blocker!.taskId ?? '—', 'muted'), span(`${marks.states[run.state]} ${w.blockerText(run.blocker!)}`, blockerRole(run.blocker!)),
        span(w.age(run.blocker!.sinceMs)), span(run.scopeId, 'muted'), ...w.installCell(install)] })) },
    ...(failed.length ? [blank, heading(t('monitor.summary.failed', { count: failed.length }, locale)), { kind: 'table' as const, empty: '',
      columns: [w.col(t('monitor.col.run', {}, locale), 0, 20, 44), w.col(t('monitor.col.firstFailure', {}, locale), 1, 20, 50),
        w.col(t('monitor.col.activity', {}, locale), 2, 14, 20), w.col(t('monitor.col.scope', {}, locale), 4, 8, 24), ...w.installColumn(3)],
      rows: failed.map(({ install, value: run }): MonitorRow => ({ key: `${install.id}:${w.runName(run)}`, detail: runDetail(w, install, run), cells: [
        span(run.runId), span(firstFailure(run), 'error'), span(agoText(now, run.lastActivityMs, locale), 'muted'), span(run.scopeId, 'muted'),
        ...w.installCell(install)] })) }] : []),
    blank, heading(t('monitor.summary.workers', { count: running.length }, locale)), workersBlock(w, running, t('monitor.summary.noWorkers', {}, locale)),
  ];
}

function headerLines(w: Words, installs: readonly MonitorInstall[]): MonitorLine[] {
  const { locale, now, marks, sep } = w;
  return [
    [span(t('monitor.title', {}, locale), 'strong'), span(sep), span(t('monitor.observed', { time: clockText(now) }, locale)), span(sep),
      span(t('monitor.observeOnly', {}, locale), 'muted')],
    ...(installs.length ? installs.map((install): MonitorLine => {
      const ok = install.status === 'available';
      return [span(`${ok ? marks.on : marks.off} ${install.id}`, ok ? 'success' : 'error'), span(sep),
        span(ok ? w.serviceText(install) : installStatusLabel(install.status, locale), ok ? undefined : 'error'), span(sep), span(w.buildText(install)), span(sep),
        span(w.ledgerText(install), 'muted'), ...(install.diagnostics.length ? [span(sep), span(`${marks.warn} ${w.diagnosticsText(install)}`, 'warning')] : []),
        span(sep), span(install.path, 'muted')];
    }) : [[span(t('monitor.empty.installs', {}, locale), 'muted')]]),
  ];
}

export function buildMonitorView(snapshot: MonitorSnapshot, locale: Locale, ascii: boolean): MonitorView {
  const w = wordsFor(snapshot, locale, ascii), installs = snapshot.installs;
  const runs = each(installs, install => install.runs);
  const stuck = runs.filter(entry => OPEN.includes(entry.value.state) && entry.value.blocker && !MOVING.has(entry.value.blocker.code))
    .sort((a, b) => (a.value.blocker!.sinceMs ?? Infinity) - (b.value.blocker!.sinceMs ?? Infinity) || w.runName(a.value).localeCompare(w.runName(b.value)));
  const stuckSet = new Set(stuck.map(entry => entry.value));
  // Runs tab: stuck first (oldest blocker first), then the other open Runs, then finished ones (latest activity first).
  const ordered = [...stuck, ...runs.filter(entry => OPEN.includes(entry.value.state) && !stuckSet.has(entry.value)),
    ...runs.filter(entry => !OPEN.includes(entry.value.state)).sort((a, b) => (b.value.lastActivityMs ?? 0) - (a.value.lastActivityMs ?? 0))];
  const approvals = each(installs, install => install.approvals).sort((a, b) => (a.value.createdAtMs ?? Infinity) - (b.value.createdAtMs ?? Infinity));
  const workers = each(installs, install => install.workers);
  const tabs: Record<MonitorTab, readonly MonitorBlock[]> = {
    summary: summaryBlocks(w, installs, runs, stuck, approvals, workers), runs: [runsBlock(w, ordered)],
    workers: [workersBlock(w, workers, t('monitor.empty.workers', {}, locale))], approvals: [approvalsBlock(w, approvals, false)],
    pools: [poolsBlock(w, each(installs, install => install.pools))], installs: installsBlocks(w, installs),
  };
  return { header: headerLines(w, installs), tabs: Object.fromEntries(MONITOR_TABS.map(tab => [tab, tabs[tab]])) as Record<MonitorTab, readonly MonitorBlock[]> };
}
