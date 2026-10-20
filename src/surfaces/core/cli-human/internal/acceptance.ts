import { t, terminalSafeText, type Locale } from '#platform/index.js';
import registry from './human.json' with { type: 'json' };

type EvidenceEntry = Readonly<{ evidence: string; independent: boolean }>;
const EVIDENCE: Readonly<Record<string, EvidenceEntry>> = registry.acceptanceEvidence;

/**
 * What an acceptance rests on, in words (law 1): `process-exit@1` → "accepted on: exit code · content not independently verified".
 * The installed evaluators are in the kit registry; any other evaluator (an extension's) is named as is, its check stated as unknown.
 */
export function acceptanceEvidenceText(evaluator: Readonly<{ id: string; version: number }>, locale: Locale): string {
  return t('cli.human.acceptance.line', evidenceParts(evaluator, locale), locale);
}
/** The same words inline after an "accepted" verdict (PRE-1 B3): "exit code · content not independently verified", one part per distinct evaluator. */
export function acceptanceEvidenceQualifier(evaluators: readonly Readonly<{ id: string; version: number }>[], locale: Locale): string {
  const distinct = [...new Map(evaluators.map(evaluator => [`${evaluator.id}@${evaluator.version}`, evaluator])).values()];
  return distinct.map(evaluator => { const { kind, check } = evidenceParts(evaluator, locale); return `${kind} · ${check}`; }).join('; ');
}
function evidenceParts(evaluator: Readonly<{ id: string; version: number }>, locale: Locale) {
  const entry = Object.hasOwn(EVIDENCE, evaluator.id) ? EVIDENCE[evaluator.id]! : undefined;
  const kind = entry?.evidence === 'exit-code' ? t('cli.human.acceptance.exitCode', {}, locale)
    : entry?.evidence === 'operation-record' ? t('cli.human.acceptance.operationRecord', {}, locale)
      : t('cli.human.acceptance.evaluator', { evaluator: `${terminalSafeText(evaluator.id)}@${evaluator.version}` }, locale);
  const check = !entry ? t('cli.human.acceptance.checkUnknown', {}, locale)
    : entry.independent ? t('cli.human.acceptance.independent', {}, locale) : t('cli.human.acceptance.notIndependent', {}, locale);
  return { kind, check };
}
