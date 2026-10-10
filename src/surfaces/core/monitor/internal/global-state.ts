import { t, type Locale } from '#platform/index.js';
import { projectHumanState, type HumanState, type HumanStateCode, type HumanNextAction, type MonitorRun, type MonitorSnapshot } from '#engine/index.js';
import { blockerLabel, clockText } from './labels.js';
import { span, type MonitorLine, type MonitorRole, type MonitorSpan } from './layout.js';

export function globalStateLabel(state: HumanStateCode, locale: Locale): string {
  const labels: Record<HumanStateCode, string> = { queued: t('monitor.global.queued', {}, locale), running: t('monitor.global.running', {}, locale),
    checking: t('monitor.global.checking', {}, locale), held: t('monitor.global.held', {}, locale), done: t('monitor.global.done', {}, locale), stopped: t('monitor.global.stopped', {}, locale) };
  return labels[state];
}
const ROLES: Readonly<Record<HumanStateCode, MonitorRole>> = { queued: 'muted', running: 'info', checking: 'info', held: 'warning', done: 'success', stopped: 'error' };
export const globalStateCell = (value: HumanState, locale: Locale): MonitorSpan => span(value.state === 'held' ? t('monitor.global.heldBy', { state: globalStateLabel(value.state, locale), waitingOn: waitLabel(value.waitingOn, locale) }, locale) : globalStateLabel(value.state, locale), ROLES[value.state]);
const waitLabel = (waitingOn: 'you' | 'operator' | 'system', locale: Locale) => waitingOn === 'you' ? t('monitor.global.you', {}, locale)
  : waitingOn === 'operator' ? t('monitor.global.operator', {}, locale) : t('monitor.global.system', {}, locale);
function actionLabel(action: HumanNextAction, locale: Locale): string {
  const labels: Record<HumanNextAction, string> = { 'inspect-run': t('monitor.global.inspectRun', {}, locale), 'inspect-worker': t('monitor.global.inspectWorker', {}, locale),
    'inspect-approvals': t('monitor.global.inspectApprovals', {}, locale), 'inspect-pool': t('monitor.global.inspectPool', {}, locale), 'inspect-task': t('monitor.global.inspectTask', {}, locale) };
  return labels[action];
}
/** All five held fields remain visible; absent times say unknown, never "no expiry". */
export function globalStateLines(value: HumanState, locale: Locale): MonitorLine[] {
  if (value.state !== 'held') return [];
  const time = (at: number | null) => at === null ? t('monitor.time.unknown', {}, locale) : clockText(at);
  return [[span(t('monitor.global.hold', { waitingOn: waitLabel(value.waitingOn, locale), reason: `${blockerLabel(value.reason, locale)}${value.detail ? ` (${value.detail})` : ''}`,
    since: time(value.since), deadline: time(value.deadline), nextAction: actionLabel(value.nextAction, locale) }, locale), 'warning')]];
}
/** A held row shows who even when its detail drawer is closed. */
export const globalRunCell = (run: MonitorRun, locale: Locale): MonitorSpan => {
  const value = projectHumanState({ kind: 'run', value: run });
  return span(value.state === 'held' ? t('monitor.global.heldBy', { state: globalStateLabel(value.state, locale), waitingOn: waitLabel(value.waitingOn, locale) }, locale)
    : globalStateLabel(value.state, locale), ROLES[value.state]);
};
export function globalSummary(snapshot: Pick<MonitorSnapshot, 'installs'>, locale: Locale): string {
  const counts: Record<HumanStateCode, number> = { queued: 0, running: 0, checking: 0, held: 0, done: 0, stopped: 0 };
  for (const install of snapshot.installs) for (const run of install.runs) counts[projectHumanState({ kind: 'run', value: run }).state]++;
  return t('monitor.global.counts', counts, locale);
}
