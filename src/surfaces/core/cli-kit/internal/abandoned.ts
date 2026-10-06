import { t, type Locale } from '#platform/index.js';

type ClosureIdentity = Readonly<{ taskId: string; attemptId: string }>;
/** `task close-abandoned` result as rendered by every CLI surface: closed (with the inactivity proof) or refused (nothing changed). */
export type AbandonedClosureView = Readonly<{ identity: ClosureIdentity; status: 'closed'; heartbeat: 'stale' | 'missing' | 'recorded'; phase: string }
  | { identity: ClosureIdentity; status: 'refused'; reason: 'not-launched' | 'terminal' | 'not-active' | 'effects-unresolved' | 'container-present' | 'executor-live'; phase: string }>;
export function renderAbandonedClosure(closure: AbandonedClosureView, locale: Locale): string {
  const params = { task: closure.identity.taskId, attempt: closure.identity.attemptId };
  if (closure.status === 'closed') {
    const heartbeat = { stale: t('cli.task.abandoned.heartbeat.stale', {}, locale), missing: t('cli.task.abandoned.heartbeat.missing', {}, locale),
      recorded: t('cli.task.abandoned.heartbeat.recorded', {}, locale) }[closure.heartbeat];
    return t('cli.task.abandoned.closed', { ...params, heartbeat }, locale);
  }
  const reason = { 'not-launched': t('cli.task.abandoned.reason.not-launched', {}, locale), terminal: t('cli.task.abandoned.reason.terminal', {}, locale),
    'not-active': t('cli.task.abandoned.reason.not-active', {}, locale), 'effects-unresolved': t('cli.task.abandoned.reason.effects-unresolved', {}, locale),
    'container-present': t('cli.task.abandoned.reason.container-present', {}, locale), 'executor-live': t('cli.task.abandoned.reason.executor-live', {}, locale) }[closure.reason];
  return t('cli.task.abandoned.refused', { ...params, reason }, locale);
}
