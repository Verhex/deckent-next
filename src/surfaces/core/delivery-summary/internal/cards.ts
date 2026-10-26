import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { AutonomyEvaluation, DeliverySummary, DeliverySummaryOperation, DeliverySummaryRequest, QueueConsent,
  TargetQueueView } from '#engine/index.js';
import { renderAutonomyShadow, renderDeliverySummary, type DeliveryRenderOptions } from './render.js';
import limits from './limits.json' with { type: 'json' };

/**
 * TESLIM-KARTI-OZET (alpha.53 A3): what every delivery card asks for and how it places the summary. The summary is a view read under the
 * caller's own grants; it never replaces or alters an exact card (consent stays bound to the card's digest) and carries no authority.
 */
/** Each card's DeliverySummary, in request order; null = no summary for that card (Run absent or not readable). */
export type DeliverySummaryReader = (root: string, requests: readonly DeliverySummaryRequest[], options: ConfigLoadOptions) => Promise<readonly (DeliverySummary | null)[]>;
/** OTONOM-TESLIM shadow (lane B1): the latest autonomy@1 evaluation of one queue ticket. Shown in list and inspect only, never on a consent card. */
export type AutonomyShadowView = Pick<AutonomyEvaluation, 'verdict' | 'reasons'>;
export type AutonomyShadowReader = (root: string, scopeId: string, commandId: string, options: ConfigLoadOptions) => Promise<AutonomyShadowView | null>;

/**
 * The request of one queue ticket. A delivery ticket moves its target branch (`adopt`); the consent's own operation wins on a consent card.
 * `protected` is the git adapter's answer already recorded on the ticket: refused as protected (true), past candidate preparation, which runs the
 * protection check (false), otherwise not known yet (null). The verification Run is the ticket's own derived id; absent until the service admits it.
 */
export function queueSummaryRequest(view: TargetQueueView, topPaths: number, operation?: DeliverySummaryOperation): DeliverySummaryRequest {
  return { schemaVersion: 1, identity: view.identity, operation: operation ?? (view.operation === 'rollback' ? 'rollback' : 'adopt'),
    target: { id: view.target.id, protected: view.outcome === 'target-protected' ? true : view.basis !== null ? false : null },
    verificationRunId: null, ticketCommandId: view.commandId, topPaths };
}
export const consentSummaryOperation = (operation: QueueConsent['operation']): DeliverySummaryOperation => operation === 'publish' ? 'deliver' : operation;
/**
 * The summaries of the tickets one consent card asks about, in item order: each ticket read again by its id when the card is asked (a ticket
 * that cannot be read gets null), its exact paths left to the card (no paths here). Callers inject the queue read and the summary reader.
 */
export async function readConsentSummaries(view: Pick<QueueConsent, 'operation' | 'items'>, inspect: (commandId: string) => Promise<TargetQueueView | null>,
  describe: (requests: readonly DeliverySummaryRequest[]) => Promise<readonly (DeliverySummary | null)[]>): Promise<readonly (DeliverySummary | null)[]> {
  const tickets = await Promise.all(view.items.map(item => inspect(item.commandId).catch(() => null)));
  const present = tickets.filter(ticket => ticket !== null), read = present.length
    ? await describe(present.map(ticket => queueSummaryRequest(ticket, 0, consentSummaryOperation(view.operation)))).catch(() => present.map(() => null)) : [];
  return tickets.map(ticket => ticket ? read[present.indexOf(ticket)] ?? null : null);
}

/** Lines placed ABOVE an exact consent card: a heading that says the card below is what the yes approves, then one block per ticket. No shadow. */
export function consentSummaryLines(summaries: readonly (DeliverySummary | null)[], locale: Locale, options: DeliveryRenderOptions = {}): readonly string[] {
  if (!summaries.length) return [];
  return [t('delivery.card.above', {}, locale), ...summaries.flatMap(summary => summary ? renderDeliverySummary(summary, locale, options) : [t('delivery.summary.unavailable', {}, locale)])];
}
/** The summary block of one ticket view (inspect, enqueue, rollback); `shadow` is passed by inspect only. Undefined summary = not requested. */
export function ticketSummaryBlock(summary: DeliverySummary | null | undefined, shadow: AutonomyShadowView | null | undefined, locale: Locale, settled = false): readonly string[] {
  if (summary === undefined) return [];
  return [...summary ? renderDeliverySummary(summary, locale, { omit: settled ? ['actions'] : [] }) : [t('delivery.summary.unavailable', {}, locale)], ...shadow ? [renderAutonomyShadow(shadow, locale)] : []];
}
/** Short list cells: the bounded title, one risk word and the shadow word (list only). */
export function summaryListCells(summary: DeliverySummary | null | undefined, shadow: AutonomyShadowView | null | undefined, locale: Locale) {
  const title = summary && summary.title.source !== 'untitled' ? summary.title.text : '—', chars = [...title];
  return { title: chars.length > limits.listTitleChars ? `${chars.slice(0, limits.listTitleChars - 1).join('')}…` : title,
    risk: summary ? summary.risk.class === 'small' ? t('delivery.list.risk.small', {}, locale) : t('delivery.list.risk.other', {}, locale) : '—',
    shadow: shadow ? shadow.verdict === 'would-deliver' ? t('delivery.list.shadow.deliver', {}, locale) : t('delivery.list.shadow.hold', {}, locale) : '—' };
}
