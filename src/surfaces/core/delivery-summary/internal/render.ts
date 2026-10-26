import { redactSensitive, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { AutonomyEvaluation, DeliverySummary } from '#engine/index.js';
import { acceptanceEvidenceQualifier } from '#surfaces/core/cli-human/index.js';
import { actionLabels, flagLabels, holdReasonLabels, modelVerdictLabels, operationLabels, phaseLabels, verdictLabels } from './labels.js';
import limits from './limits.json' with { type: 'json' };

/**
 * Human lines of one DeliverySummary (TESLIM-KARTI-OZET). Pure: no I/O, no authority. The worker's report and checks are always labelled as
 * claims, the system verification Run as the system's own; a section the caller may not read or that has no evidence says so instead of vanishing.
 * Evidence wording is the shared acceptance qualifier, model verdict wording the shared worker-model keys. The autonomy shadow line is a separate
 * function on purpose: it never belongs on the y/N consent prompt (alpha.53 law-audit fold 3).
 */
export const DELIVERY_RENDER_LIMITS = Object.freeze(limits);
/** `omit`: sections a card already shows in its own exact words (the delivery window's title and file stats); never acceptance or risk. Settled ticket views omit the consent actions. */
export type DeliveryRenderOptions = Readonly<{ maxLineChars?: number; omit?: readonly ('title' | 'operation' | 'change' | 'actions')[] }>;

const safe = (value: string) => redactSensitive(terminalSafeText(value));
function bound(line: string, max: number): string {
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}
function evidenceWords(evidence: DeliverySummaryEvidence, locale: Locale): string {
  return evidence.length ? acceptanceEvidenceQualifier(evidence.map(row => row.evaluator), locale) : t('delivery.accepted.noEvidence', {}, locale);
}
type DeliverySummaryEvidence = DeliverySummary['acceptance']['evidence'];

export function renderDeliverySummary(summary: DeliverySummary, locale: Locale, options: DeliveryRenderOptions = {}): readonly string[] {
  const max = Math.max(limits.minLineChars, options.maxLineChars ?? limits.lineChars), lines: string[] = [];
  const target = summary.target.state === 'available' ? safe(summary.target.id) : t('delivery.target.unavailable', {}, locale);
  const omit = new Set(options.omit ?? []);
  if (!omit.has('title')) lines.push(summary.title.source === 'untitled' ? t('delivery.title.untitled', {}, locale) : t('delivery.title', { title: safe(summary.title.text) }, locale));
  if (!omit.has('operation')) lines.push(operationLabels(locale, target)[summary.operation]);
  const { outcome, change, tests, model, risk, acceptance } = summary;
  lines.push(outcome.state === 'available' ? t('delivery.outcome', { summary: outcome.truncated ? `${safe(outcome.summary)} …` : safe(outcome.summary) }, locale)
    : outcome.state === 'withheld' ? t('delivery.outcome.withheld', {}, locale) : t('delivery.outcome.unavailable', {}, locale));
  if (omit.has('change')) { /* the card lists its own exact changes */ }
  else if (change.state !== 'available') lines.push(change.state === 'withheld' ? t('delivery.change.withheld', {}, locale) : t('delivery.change.unavailable', {}, locale));
  else {
    lines.push(t('delivery.change', { files: change.files, added: change.added, removed: change.removed }, locale));
    const shown = change.topPaths.map(safe).join(', ');
    if (shown) lines.push(t('delivery.change.paths', { paths: change.topPathsOmitted > 0 ? t('delivery.change.pathsMore', { paths: shown, more: change.topPathsOmitted }, locale) : shown }, locale));
    if (change.outOfScopeCount > 0) lines.push(t('delivery.change.outOfScope', { count: change.outOfScopeCount,
      paths: change.outOfScope.length < change.outOfScopeCount ? t('delivery.change.pathsMore', { paths: change.outOfScope.map(safe).join(', '), more: change.outOfScopeCount - change.outOfScope.length }, locale) : change.outOfScope.map(safe).join(', ') }, locale));
    if (change.scope === 'unscoped') lines.push(t('delivery.change.unscoped', {}, locale));
  }
  lines.push(t('delivery.accepted', { verdict: verdictLabels(locale)[acceptance.verdict], criteria: acceptance.criteriaCount, evidence: evidenceWords(acceptance.evidence, locale) }, locale));
  lines.push(tests.worker.state === 'available' ? t('delivery.tests.worker', { passed: tests.worker.passed, failed: tests.worker.failed, notRun: tests.worker.notRun, unknown: tests.worker.unknown }, locale)
    : tests.worker.state === 'withheld' ? t('delivery.tests.worker.withheld', {}, locale) : t('delivery.tests.worker.unavailable', {}, locale));
  lines.push(tests.verification.state === 'available' ? t('delivery.tests.verification', { run: safe(tests.verification.runId),
    phase: phaseLabels(locale)[tests.verification.phase], evidence: evidenceWords(tests.verification.evidence, locale) }, locale)
    : tests.verification.state === 'withheld' ? t('delivery.tests.verification.withheld', {}, locale) : t('delivery.tests.verification.unavailable', {}, locale));
  lines.push(model.state === 'available' ? t('delivery.model', { channel: safe(model.requested.channelId), model: safe(model.requested.modelId),
    verdict: modelVerdictLabels(locale, safe(model.requested.channelId))[model.verdict] }, locale) : model.state === 'withheld' ? t('delivery.model.withheld', {}, locale) : t('delivery.model.unavailable', {}, locale));
  const parts = [risk.class === 'small' ? t('delivery.risk.small', {}, locale) : t('delivery.risk.other', {}, locale), ...(risk.protectedTarget === true ? [t('delivery.risk.protected', {}, locale)] : []),
    ...(risk.sizeBucket ? [t('delivery.risk.size', { size: safe(risk.sizeBucket) }, locale)] : []), ...risk.flags.map(flag => flagLabels(locale)[flag])];
  lines.push(t('delivery.risk', { parts: parts.join(' · ') }, locale));
  if (!omit.has('actions')) lines.push(t('delivery.actions', { yes: actionLabels(locale)[summary.actions.yes], no: actionLabels(locale)[summary.actions.no] }, locale));
  return Object.freeze(lines.map(line => bound(line, max)));
}

/** One line for list / inspect / monitor cards; never for the consent prompt. */
export function renderAutonomyShadow(result: Pick<AutonomyEvaluation, 'verdict' | 'reasons'>, locale: Locale, options: DeliveryRenderOptions = {}): string {
  const max = Math.max(limits.minLineChars, options.maxLineChars ?? limits.lineChars);
  return bound(result.verdict === 'would-deliver' ? t('delivery.shadow.deliver', {}, locale)
    : t('delivery.shadow.hold', { reasons: result.reasons.map(reason => holdReasonLabels(locale)[reason]).join(', ') }, locale), max);
}
