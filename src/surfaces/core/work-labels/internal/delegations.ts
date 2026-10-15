import type { DecisionDelegationView, DelegationCommand, DelegationQuery } from '#domain/index.js';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
export interface DelegationHandlers {
  inspect(root: string, query: DelegationQuery, options: ConfigLoadOptions): Promise<DecisionDelegationView>;
  change(root: string, command: DelegationCommand, confirm: (view: DecisionDelegationView) => Promise<boolean>, options: ConfigLoadOptions):
    Promise<{ readonly status: 'applied' | 'current' | 'cancelled'; readonly view: DecisionDelegationView }>;
}
export function delegationWords(locale: Locale) {
  return {
    step: { 'run-resume': t('policy.delegate.step.run-resume', {}, locale), 'run-close': t('policy.delegate.step.run-close', {}, locale),
      'task-accept': t('policy.delegate.step.task-accept', {}, locale), 'task-reject': t('policy.delegate.step.task-reject', {}, locale),
      'task-answer': t('policy.delegate.step.task-answer', {}, locale), 'approval-decide': t('policy.delegate.step.approval-decide', {}, locale) } as Readonly<Record<string, string>>,
    managed: { none: t('policy.delegate.managed.none', {}, locale), granted: t('policy.delegate.managed.granted', {}, locale), conflict: t('policy.delegate.managed.conflict', {}, locale) },
    effective: { allowed: t('policy.delegate.effective.allowed', {}, locale), denied: t('policy.delegate.effective.denied', {}, locale) },
    action: { grant: t('policy.delegate.grant', {}, locale), revoke: t('policy.delegate.revoke', {}, locale) },
    result: { applied: t('policy.delegate.result.applied', {}, locale), current: t('policy.delegate.result.current', {}, locale), cancelled: t('policy.delegate.result.cancelled', {}, locale) },
  };
}
export function delegationLines(view: DecisionDelegationView, locale: Locale): readonly string[] {
  const words = delegationWords(locale);
  return [t('policy.delegate.target', { actor: `${view.principal.issuer}/${view.principal.subject}`, scope: view.scopeId, resource: view.resourceId ?? '*', revision: view.revision }, locale),
    ...view.steps.map(row => t('policy.delegate.row', { step: row.step.id, label: words.step[row.step.id] ?? row.step.id,
      managed: words.managed[row.managed], effective: words.effective[row.effective] }, locale)),
    t('policy.delegate.limit', {}, locale)];
}
