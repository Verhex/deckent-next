import { t, type Locale } from '#platform/index.js';

type HoldIdentity = Readonly<{ taskId: string; attemptId: string }>;
/** `task mark-lost` result as rendered by every CLI surface: held (unknown outcome, with the inactivity proof) or refused (nothing changed). */
export type LostAttemptView = Readonly<{ identity: HoldIdentity; status: 'held'; heartbeat: 'stale' | 'missing' | 'recorded'; phase: string }
  | { identity: HoldIdentity; status: 'refused'; reason: 'not-launched' | 'terminal' | 'not-active' | 'effects-unresolved' | 'container-present' | 'executor-live'; phase: string }>;
export function renderLostAttempt(hold: LostAttemptView, locale: Locale): string {
  const params = { task: hold.identity.taskId, attempt: hold.identity.attemptId };
  if (hold.status === 'held') {
    const heartbeat = { stale: t('cli.task.lost.heartbeat.stale', {}, locale), missing: t('cli.task.lost.heartbeat.missing', {}, locale),
      recorded: t('cli.task.lost.heartbeat.recorded', {}, locale) }[hold.heartbeat];
    return t('cli.task.lost.held', { ...params, heartbeat }, locale);
  }
  const reason = { 'not-launched': t('cli.task.lost.reason.not-launched', {}, locale), terminal: t('cli.task.lost.reason.terminal', {}, locale),
    'not-active': t('cli.task.lost.reason.not-active', {}, locale), 'effects-unresolved': t('cli.task.lost.reason.effects-unresolved', {}, locale),
    'container-present': t('cli.task.lost.reason.container-present', {}, locale), 'executor-live': t('cli.task.lost.reason.executor-live', {}, locale) }[hold.reason];
  return t('cli.task.lost.refused', { ...params, reason }, locale);
}
