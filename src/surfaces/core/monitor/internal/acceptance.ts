import { t, type Locale } from '#platform/index.js';
import type { RunView } from '#engine/index.js';
type AcceptanceView = NonNullable<RunView['tasks'][number]['acceptance']>;
/** One renderer for the shared acceptance value on CLI task/run inspect and monitor detail. */
export function renderAcceptanceLine(view: AcceptanceView, locale: Locale): string {
  const unknown = t('acceptance.unknown', {}, locale);
  const outcomes = { accepted: t('acceptance.outcome.accepted', {}, locale), failed: t('acceptance.outcome.failed', {}, locale),
    'awaiting-decision': t('acceptance.outcome.awaiting-decision', {}, locale), incomplete: t('acceptance.outcome.incomplete', {}, locale) };
  const criteria = { completion: t('acceptance.criterion.completion', {}, locale), correctness: t('acceptance.criterion.correctness', {}, locale),
    safety: t('acceptance.criterion.safety', {}, locale), authorization: t('acceptance.criterion.authorization', {}, locale) };
  const ceilings = { 'missing-evidence': t('acceptance.ceiling.missing-evidence', {}, locale), 'unsettled-effect': t('acceptance.ceiling.unsettled-effect', {}, locale),
    'missing-approval': t('acceptance.ceiling.missing-approval', {}, locale) };
  return t('acceptance.summary' , { workClass: view.workClass ?? unknown, policyRevision: view.policyRevision ?? unknown,
    profileVersion: view.profileVersion ?? unknown, outcome: outcomes[view.outcome],
    criteria: view.criteria.map(row => `${criteria[row.criterionType]}: ${row.evidenceTypes.join(', ')}`).join('; ') || unknown,
    ceilings: view.ceilingReasons.map(reason => ceilings[reason]).join(', ') || unknown }, locale);
}
