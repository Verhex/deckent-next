import { t, type Locale } from '#platform/index.js';
import type { WorkerPhase } from '#domain/index.js';
import type { WorkerProcessState } from '#engine/index.js';
import type { MonitorBlockerCode, MonitorInstallStatus, MonitorRunState } from '#engine/index.js';
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
export const expiryText = (now: number, at: number | null, locale: Locale) => at === null ? t('monitor.time.noExpiry', {}, locale)
  : at >= now ? t('monitor.time.expiresIn', { duration: durationText(at - now, locale) }, locale)
    : t('monitor.time.expired', { duration: durationText(now - at, locale) }, locale);
export const clockText = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;

export function runStateLabel(state: MonitorRunState, locale: Locale): string {
  const labels: Record<MonitorRunState, string> = { parked: t('monitor.state.parked', {}, locale), incomplete: t('monitor.state.incomplete', {}, locale), progressing: t('monitor.state.progressing', {}, locale), waiting: t('monitor.state.waiting', {}, locale),
    blocked: t('monitor.state.blocked', {}, locale), accepted: t('monitor.state.accepted', {}, locale), failed: t('monitor.state.failed', {}, locale),
    cancelled: t('monitor.state.cancelled', {}, locale) };
  return labels[state];
}
export function blockerLabel(code: MonitorBlockerCode, locale: Locale): string {
  const labels: Record<MonitorBlockerCode, string> = { parked: t('monitor.blocker.parked', {}, locale), 'awaiting-decision': t('monitor.blocker.awaitingDecision', {}, locale),
    none: t('monitor.blocker.none', {}, locale), 'waiting-pool-slot': t('monitor.blocker.waitingPoolSlot', {}, locale),
    'pool-held': t('monitor.blocker.poolHeld', {}, locale), 'waiting-dependency': t('monitor.blocker.waitingDependency', {}, locale),
    'awaiting-approval': t('monitor.blocker.awaitingApproval', {}, locale), 'worker-running': t('monitor.blocker.workerRunning', {}, locale),
    'worker-stale-heartbeat': t('monitor.blocker.workerStaleHeartbeat', {}, locale),
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
export function installStatusLabel(status: MonitorInstallStatus, locale: Locale): string {
  const labels: Record<MonitorInstallStatus, string> = { available: t('monitor.install.available', {}, locale),
    unavailable: t('monitor.install.unavailable', {}, locale), denied: t('monitor.install.denied', {}, locale) };
  return labels[status];
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
