import { clockText, t, type Locale } from '#platform/index.js';
import type { ENVIRONMENT_TIMED_OUT_CODE, WorkerPhase } from '#domain/index.js';
import type { MONITOR_ENVIRONMENT_DETAIL, WorkerProcessState } from '#engine/index.js';
import type { MonitorDeliveryState, MonitorDeliveryOutlook, MonitorBlockerCode, MonitorInstallStatus, MonitorRunState, MonitorTask, StopCause } from '#engine/index.js';
import { holdNoteText } from '#surfaces/core/recovery-text/index.js';
import { phaseLabel } from './transcript.js';

/** Every monitor word comes from the catalogs; the maps keep each key a literal (lint-arch i18n rule). */
export function durationText(ms: number, locale: Locale): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('monitor.duration.seconds', { s }, locale);
  const m = Math.floor(s / 60);
  // Seconds matter while a wait is young; past ten minutes they are noise (htop-style readable ages).
  if (m < 10) return t('monitor.duration.minutes', { m, s: s % 60 }, locale);
  if (m < 60) return t('monitor.duration.minutesOnly', { m }, locale);
  const h = Math.floor(m / 60);
  if (h < 24) return t('monitor.duration.hours', { h, m: m % 60 }, locale);
  return t('monitor.duration.days', { d: Math.floor(h / 24), h: h % 24 }, locale);
}
/** `3 min 12 s ago`, relative to the snapshot's own observation time (stable output; never the wall clock). */
export const agoText = (now: number, at: number | null, locale: Locale) => at === null ? t('monitor.time.unknown', {}, locale)
  : t('monitor.time.ago', { duration: durationText(now - at, locale) }, locale);
export const forText = (now: number, since: number | null, locale: Locale) => since === null ? t('monitor.time.unknown', {}, locale)
  : t('monitor.time.for', { duration: durationText(now - since, locale) }, locale);
export const expiryText = (now: number, at: number | null, locale: Locale) => at === null ? t('monitor.time.unknown', {}, locale)
  : at > now ? t('monitor.time.expiresIn', { duration: durationText(at - now, locale) }, locale)
    : t('monitor.time.expired', { duration: durationText(now - at, locale) }, locale);
/** One local-clock format for every surface (platform; the subscription quota refusal names the same time). */
export { clockText };

export function runStateLabel(state: MonitorRunState, locale: Locale): string {
  const labels: Record<MonitorRunState, string> = { parked: t('monitor.state.parked', {}, locale), incomplete: t('monitor.state.incomplete', {}, locale), progressing: t('monitor.state.progressing', {}, locale), waiting: t('monitor.state.waiting', {}, locale),
    blocked: t('monitor.state.blocked', {}, locale), accepted: t('monitor.state.accepted', {}, locale), failed: t('monitor.state.failed', {}, locale),
    cancelled: t('monitor.state.cancelled', {}, locale) };
  return labels[state];
}
export function blockerLabel(code: MonitorBlockerCode, locale: Locale): string {
  const labels: Record<MonitorBlockerCode, string> = { parked: t('monitor.blocker.parked', {}, locale), 'awaiting-decision': t('monitor.blocker.awaitingDecision', {}, locale),
    none: t('monitor.blocker.none', {}, locale), 'waiting-pool-slot': t('monitor.blocker.waitingPoolSlot', {}, locale),
    'waiting-execution-slot': t('monitor.blocker.waitingExecutionSlot', {}, locale),
    'pool-held': t('monitor.blocker.poolHeld', {}, locale), 'waiting-dependency': t('monitor.blocker.waitingDependency', {}, locale),
    'waiting-scope-conflict': t('monitor.blocker.waitingScopeConflict', {}, locale),
    'awaiting-approval': t('monitor.blocker.awaitingApproval', {}, locale), 'worker-running': t('monitor.blocker.workerRunning', {}, locale),
    'worker-stale-heartbeat': t('monitor.blocker.workerStaleHeartbeat', {}, locale), 'worker-silent': t('monitor.blocker.workerSilent', {}, locale),
    'worker-exited-unevaluated': t('monitor.blocker.workerExitedUnevaluated', {}, locale),
    'evaluation-not-ready': t('monitor.blocker.evaluationNotReady', {}, locale), 'evaluation-unknown': t('monitor.blocker.evaluationUnknown', {}, locale),
    'unresolved-effect': t('monitor.blocker.unresolvedEffect', {}, locale), 'cancellation-pending': t('monitor.blocker.cancellationPending', {}, locale),
    'not-admitted': t('monitor.blocker.notAdmitted', {}, locale), unknown: t('monitor.blocker.unknown', {}, locale) };
  return labels[code];
}
const TASK_PHASES = ['pending', 'active', 'evaluating', 'accepted', 'failed', 'cancelled', 'reconciling', 'skipped', 'awaiting-decision'] as const;
/** Task phases of the task-graph contract in words; an unknown phase stays visible as its typed name. */
export function taskPhaseLabel(phase: string, locale: Locale): string {
  const labels: Record<(typeof TASK_PHASES)[number], string> = { skipped: t('monitor.phase.skipped', {}, locale), 'awaiting-decision': t('monitor.phase.awaitingDecision', {}, locale), pending: t('monitor.phase.pending', {}, locale), active: t('monitor.phase.active', {}, locale),
    evaluating: t('monitor.phase.evaluating', {}, locale), accepted: t('monitor.phase.accepted', {}, locale), failed: t('monitor.phase.failed', {}, locale),
    cancelled: t('monitor.phase.cancelled', {}, locale), reconciling: t('monitor.phase.reconciling', {}, locale) };
  return (TASK_PHASES as readonly string[]).includes(phase) ? labels[phase as (typeof TASK_PHASES)[number]] : phase;
}
const WORKER_PHASES: readonly WorkerPhase[] = ['starting', 'thinking', 'reading', 'editing', 'running', 'searching', 'fetching', 'delegating', 'finished', 'failed'];
export const workerPhaseLabel = (phase: string | null | undefined, locale: Locale) => !phase ? '—'
  : WORKER_PHASES.includes(phase as WorkerPhase) ? phaseLabel(phase as WorkerPhase, locale) : phase;
export function processLabel(state: WorkerProcessState, locale: Locale): string {
  const labels: Record<WorkerProcessState, string> = { running: t('monitor.process.running', {}, locale), paused: t('monitor.process.paused', {}, locale),
    created: t('monitor.process.created', {}, locale), exited: t('monitor.process.exited', {}, locale), missing: t('monitor.process.missing', {}, locale),
    unknown: t('monitor.process.unknown', {}, locale), 'present-unverified': t('monitor.process.presentUnverified', {}, locale),
    'absent-unverified': t('monitor.process.absentUnverified', {}, locale), denied: t('monitor.process.denied', {}, locale) };
  return labels[state];
}
/** How the process ended, in words (`çıkış 0`, `kayıp, çıkış 134`, `çıktı, sinyal SIGKILL`): one form for the monitor and `workers --verbose`. */
export function processExitText(state: WorkerProcessState, terminal: { readonly exitCode?: number | null | undefined; readonly signal?: string | null | undefined } | null | undefined, locale: Locale): string {
  const word = processLabel(state, locale);
  if (!terminal) return word;
  if (terminal.exitCode !== null && terminal.exitCode !== undefined) return state === 'exited' ? t('monitor.process.exitCode', { code: terminal.exitCode }, locale)
    : t('monitor.process.withExit', { state: word, code: terminal.exitCode }, locale);
  return terminal.signal ? t('monitor.process.withSignal', { state: word, signal: terminal.signal }, locale) : word;
}
export function installStatusLabel(status: MonitorInstallStatus, locale: Locale): string {
  const labels: Record<MonitorInstallStatus, string> = { available: t('monitor.install.available', {}, locale),
    unavailable: t('monitor.install.unavailable', {}, locale), denied: t('monitor.install.denied', {}, locale) };
  return labels[status];
}
/** The typed cause of a failed Task (R5/R3); one map so every surface names the same cause. */
export function notAcceptedLabel(reason: NonNullable<MonitorTask['evaluation']['reason']>, locale: Locale): string {
  const labels = { 'no-change-produced': t('task.acceptance.noChangeProduced', {}, locale), 'report-missing': t('task.acceptance.reportMissing', {}, locale),
    'report-invalid': t('task.acceptance.reportInvalid', {}, locale), 'declared-check-not-passed': t('task.acceptance.declaredCheckNotPassed', {}, locale),
    'worker-stalled': t('task.acceptance.workerStalled', {}, locale), 'acceptance-check-not-run': t('task.acceptance.checkNotRun', {}, locale) };
  return labels[reason];
}
/** The engine's environment-park detail prefix, tied to its constant by type (a value import would load the host graph at CLI startup). */
const ENVIRONMENT_DETAIL: typeof MONITOR_ENVIRONMENT_DETAIL = 'environment-not-ready:', ENVIRONMENT_TIMED_OUT: typeof ENVIRONMENT_TIMED_OUT_CODE = 'EXECUTION_ENVIRONMENT_TIMED_OUT';
/** A blocker's detail in words where one is known (a missing patch; PRE-7: an environment park names its requirement); else the recorded detail. */
export function blockerDetailText(detail: string, locale: Locale): string {
  // S6R-6: a system safety hold's note (the engine passes it only for a nervous/auditor hold) in its catalog words, never the raw code.
  if (/^(recovery|nervous):/u.test(detail)) return holdNoteText(detail, 'nervous', locale);
  if (detail === 'patch-missing') return t('monitor.blocker.patchMissing', {}, locale);
  // E1: a timed-out environment check held the Run (progression park with this code): no answer, re-run it; never an installation problem.
  if (detail === ENVIRONMENT_TIMED_OUT) return t('monitor.blocker.environmentTimedOut', {}, locale);
  return detail.startsWith(ENVIRONMENT_DETAIL) ? t('monitor.blocker.environmentNotReady', { requirement: detail.slice(ENVIRONMENT_DETAIL.length) }, locale) : detail;
}
/** PRE-7: the next step after an acceptance check the worker could not run. Deckent's preflight checks only declared requirements, so an
 * undeclared missing tool reaches the worker; the operator may declare it on the task's template (never added automatically). */
export function notAcceptedNextStep(reason: NonNullable<MonitorTask['evaluation']['reason']>, profile: Readonly<{ id: string; version: number }> | null, locale: Locale): string[] {
  return reason === 'acceptance-check-not-run' ? [t('task.acceptance.checkNotRunNext', { template: profile?.id ?? '—', version: profile?.version ?? '—' }, locale)] : [];
}
/** PRE-34: the shared stop cause in words (one map, every monitor surface); `unrecorded` keeps the honest "not recorded". */
export function stopCauseText(cause: StopCause, locale: Locale): string {
  switch (cause.kind) {
    case 'line': return cause.line;
    case 'tests': return t('monitor.cause.tests', { count: cause.count, name: cause.name ?? '—' }, locale);
    case 'not-accepted': return notAcceptedLabel(cause.reason, locale);
    case 'exit': return t('monitor.cause.exit', { code: cause.code }, locale);
    case 'signal': return t('monitor.cause.signal', {}, locale);
    case 'interrupted': return t('monitor.cause.interrupted', {}, locale);
    case 'cancelled': return t('monitor.cause.cancelled', {}, locale);
    case 'skipped': return t('monitor.cause.skipped', {}, locale);
    case 'not-launched': return t('monitor.cause.notLaunched', {}, locale);
    case 'no-attempt': return t('monitor.cause.noAttempt', {}, locale);
    case 'output-denied': return t('monitor.cause.outputDenied', {}, locale);
    case 'rejected': return t('monitor.cause.rejected', {}, locale);
    case 'rolled-back': return t('monitor.cause.rolledBack', {}, locale);
    case 'unrecorded': return t('monitor.detail.firstFailureMissingShort', {}, locale);
  }
}
export function verdictLabel(verdict: 'accepted' | 'accepted-unverified' | 'rejected' | 'unknown' | 'pending' | null, locale: Locale): string {
  if (verdict === null) return t('monitor.verdict.none', {}, locale);
  const labels = { 'accepted-unverified': t('monitor.verdict.acceptedUnverified', {}, locale), accepted: t('monitor.verdict.accepted', {}, locale), rejected: t('monitor.verdict.rejected', {}, locale),
    unknown: t('monitor.verdict.unknown', {}, locale), pending: t('monitor.verdict.pending', {}, locale) };
  return labels[verdict];
}
export type MonitorTab = 'summary' | 'runs' | 'workers' | 'approvals' | 'pools' | 'installs' | 'map';
export const MONITOR_TABS: readonly MonitorTab[] = ['summary', 'runs', 'workers', 'approvals', 'pools', 'installs', 'map'];
export function tabLabel(tab: MonitorTab, locale: Locale): string {
  const labels: Record<MonitorTab, string> = { summary: t('monitor.tab.summary', {}, locale), runs: t('monitor.tab.runs', {}, locale),
    workers: t('monitor.tab.workers', {}, locale), approvals: t('monitor.tab.approvals', {}, locale), pools: t('monitor.tab.pools', {}, locale),
    installs: t('monitor.tab.installs', {}, locale), map: t('monitor.tab.map', {}, locale) };
  return labels[tab];
}

export function deliveryLabel(state: MonitorDeliveryState, locale: Locale): string {
  const labels: Record<MonitorDeliveryState, string> = { integrating: t('monitor.delivery.integrating', {}, locale), integrated: t('monitor.delivery.integrated', {}, locale),
    delivering: t('monitor.delivery.delivering', {}, locale), delivered: t('monitor.delivery.delivered', {}, locale), adopting: t('monitor.delivery.adopting', {}, locale),
    adopted: t('monitor.delivery.adopted', {}, locale), 'rolling-back': t('monitor.delivery.rollingBack', {}, locale), 'rolled-back': t('monitor.delivery.rolledBack', {}, locale) };
  return labels[state];
}
/** Table cell wording of an accepted Run's delivery outlook (no receipt yet). */
/** BeUser M-33: the shown outlook adds `set-aside` (carried beside the wire outlook, which keeps its value). */
export type ShownDeliveryOutlook = MonitorDeliveryOutlook | 'set-aside';
export const shownOutlook = (outlook: MonitorDeliveryOutlook | undefined, setAside: boolean | undefined): ShownDeliveryOutlook | undefined => outlook && setAside ? 'set-aside' : outlook;
export function deliveryOutlookLabel(outlook: ShownDeliveryOutlook, locale: Locale): string {
  const labels: Record<ShownDeliveryOutlook, string> = { none: t('monitor.delivery.none', {}, locale), 'patch-not-prepared': t('monitor.delivery.patchNotPrepared', {}, locale),
    'awaiting-delivery': t('monitor.delivery.awaiting', {}, locale), 'set-aside': t('monitor.delivery.setAside', {}, locale) };
  return labels[outlook];
}
/** The detail sentence of the outlook; `patch-not-prepared` names that the cause is not recorded and where the exact one is shown. */
export function deliveryOutlookDetail(outlook: ShownDeliveryOutlook, locale: Locale): string {
  const labels: Record<ShownDeliveryOutlook, string> = { none: t('monitor.detail.deliveryOutlook.none', {}, locale),
    'patch-not-prepared': t('monitor.detail.deliveryOutlook.patchNotPrepared', {}, locale), 'awaiting-delivery': t('monitor.detail.deliveryOutlook.awaiting', {}, locale),
    'set-aside': t('monitor.detail.deliveryOutlook.setAside', {}, locale) };
  return labels[outlook];
}

/** S9 (owner L-A): the card lines of an expired quota wait: what happened, the known reset (if any), the choices. Nothing here cancels. */
export function quotaAskLines(resetsAtMs: readonly (number | null)[], locale: Locale): readonly string[] {
  const known = resetsAtMs.length > 0 && resetsAtMs.every((reset): reset is number => reset !== null) ? Math.max(...resetsAtMs as number[]) : null;
  return [t('quotaask.card.title', {}, locale), known === null ? t('quotaask.card.resetUnknown', {}, locale) : t('quotaask.card.resetKnown', { time: clockText(known) }, locale),
    t('quotaask.card.options', {}, locale)];
}

export function quotaWaitText(deadline: number, resetKnown: boolean, locale: Locale, retryLimit = false, now = Date.now()): string {
  const hint = t('run.quota.releaseHint', {}, locale);
  if (retryLimit) return `${t('run.quota.retryLimit', {}, locale)} · ${hint}`;
  const date = new Date(deadline), time = deadline - now > 24 * 60 * 60 * 1000 ? clockText(deadline) : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${resetKnown ? t('run.quota.reset', { time }, locale) : t('run.quota.wait', { time }, locale)} · ${hint}`;
}
