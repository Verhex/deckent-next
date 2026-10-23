import { randomUUID } from 'node:crypto';
import { t, type Locale } from '#platform/index.js';
import type { DeliverySummary, EffectConfirmationView, QueueConsent, TargetQueueView } from '#engine/index.js';
import { consentSummaryLines, renderDeliverySummary, ticketSummaryBlock } from '#surfaces/core/delivery-summary/index.js';
import { renderQueueConsent, renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';
import type { DeliveryPreview, DeliveryTarget, TerminalDeliveryPort } from '#surfaces/core/terminal-delivery/index.js';
import REGISTRY from './task.json' with { type: 'json' };

/** The person's answer on one card (the CLI card launcher in production): an option id, or null when cancelled. */
export type TaskCardAsk = (request: CliCardRequest) => Promise<string | null>;
export type TaskDeliveryIo = Readonly<{ locale: Locale; ask: TaskCardAsk; print: (text: string) => void;
  /** The read-only diff of the previewed patch (the CLI's own patch-preview view). */
  diff: (preview: DeliveryPreview) => Promise<void> }>;

const yesNo = (locale: Locale) => [{ id: 'yes', label: t('cli.task.menu.yes', {}, locale), key: 'y' }, { id: 'no', label: t('cli.task.menu.no', {}, locale), key: 'n' }];
const shown = <T>(items: readonly T[]) => ({ items: items.slice(0, REGISTRY.menu.filesShown), omitted: Math.max(0, items.length - REGISTRY.menu.filesShown) });

/**
 * The confirmation port's exact card (the same `cli.task.delivery.card` text the plain `task integration-*` commands print), answered on
 * the CLI card: only an explicit yes writes; Enter alone, Esc, cancellation and silence decline (the caller's bounded signal).
 */
export function deliveryConsentCard(view: EffectConfirmationView, locale: Locale): CliCardRequest {
  const operation = view.operation === 'deliver-integration' ? t('cli.help.action.integration-deliver', {}, locale)
    : view.operation === 'rollback-integration' ? t('cli.help.action.integration-rollback', {}, locale) : t('cli.help.action.integration-adopt', {}, locale);
  const files = shown(view.files);
  const [title = operation, ...body] = t('cli.task.delivery.card', { operation, title: view.title, run: view.runId, task: view.taskId, ref: view.resource,
    from: view.from, to: view.to, count: view.files.length, added: view.added, removed: view.removed, files: files.items.join('\n'), omitted: files.omitted }, locale).split('\n');
  return { title, body: [...body, view.operation === 'deliver-integration' ? t('cli.task.menu.confirm.deliver', { ref: view.resource }, locale)
    : t('cli.task.menu.confirm.move', { ref: view.resource }, locale)], options: yesNo(locale) };
}
/** The queue's exact batch card (`queue.confirm.card`, as `task integration-queue-confirm` shows it) on the CLI card; the tickets' summary goes ABOVE its body. */
export function queueConsentCard(view: Omit<QueueConsent, 'capability'>, locale: Locale, summaries: readonly (DeliverySummary | null)[] = []): CliCardRequest {
  const [title = '', ...body] = renderQueueConsent(view, locale).split('\n');
  return { title, body: [...consentSummaryLines(summaries, locale), ...body, view.operation === 'adopt' ? t('cli.task.menu.confirm.move', { ref: view.target.id }, locale)
    : t('cli.task.menu.confirm.deliver', { ref: view.target.id }, locale)], options: yesNo(locale) };
}

/** What the person sees before choosing: changed files, base and source, scope warning, and where the patch goes (queue or adoption targets). */
function previewCard(preview: DeliveryPreview, locale: Locale): CliCardRequest {
  const files = shown(preview.files);
  return { title: t('cli.task.menu.deliver.title', { task: preview.target.taskId, title: preview.target.title }, locale), body: [
    t('cli.task.patch.stat.summary', { count: preview.files.length, added: preview.added, removed: preview.removed }, locale),
    ...files.items.map(file => `${file.path} | +${file.added} -${file.removed}`), ...(files.omitted ? [t('cli.task.menu.deliver.moreFiles', { count: files.omitted }, locale)] : []),
    t('cli.task.menu.deliver.base', { base: preview.base, source: preview.source }, locale),
    ...(preview.outOfScope.length ? [t('cli.task.menu.deliver.outOfScope', { count: preview.outOfScope.length, paths: preview.outOfScope.join(', ') }, locale)] : []),
    // TESLIM-KARTI-OZET: what the worker claims, what acceptance rests on, model and risk (the card above already names the files).
    ...(preview.summary === undefined ? [] : preview.summary ? renderDeliverySummary(preview.summary, locale, { omit: ['title', 'operation', 'change'] }) : ticketSummaryBlock(null, undefined, locale)),
    preview.queueTarget ? t('cli.task.menu.deliver.queue', { target: preview.queueTarget }, locale)
      : preview.adoptionTargets.length ? t('cli.task.menu.deliver.targets', { targets: preview.adoptionTargets.join(', ') }, locale) : t('cli.task.menu.deliver.refOnly', {}, locale),
  ], options: [{ id: 'deliver', label: t('cli.task.menu.deliver.go', {}, locale), key: 'y' }, { id: 'diff', label: t('cli.task.menu.action.diff', {}, locale), key: 'd' },
    { id: 'no', label: t('cli.task.menu.no', {}, locale), key: 'n' }] };
}

/**
 * `deckent task` delivery on a person's terminal: the same port and applications as the terminal's `/deliver` window (TESLIM-PENCERESI),
 * never a second chain. Preview (read-only) → the person's choice → with a queue target, enqueue and the exact batch card; otherwise
 * candidate + delivery behind the confirmation port's own card, then an optional adoption (target, verification Run, its own card).
 * Attempt, command ids and revisions come from the system. A declined card writes nothing; the applications re-check everything.
 */
export async function deliverTask(port: TerminalDeliveryPort, target: DeliveryTarget, io: TaskDeliveryIo): Promise<void> {
  const { locale, ask, print } = io;
  const answer = async (view: EffectConfirmationView) => await ask(deliveryConsentCard(view, locale)) === 'yes';
  const preview = await port.preview(target);
  let choice: string | null;
  // Viewing the diff is read-only and returns to the same card.
  while ((choice = await ask(previewCard(preview, locale))) === 'diff') await io.diff(preview);
  if (choice !== 'deliver') { print(t('cli.task.menu.deliver.left', {}, locale)); return; }
  if (preview.queueTarget && port.queue) {
    const queue = port.queue, status = async (view: TargetQueueView) => print([...ticketSummaryBlock(queue.summary ? await queue.summary(view) : undefined, undefined, locale),
      renderQueueStatus(view, locale)].join('\n'));
    let view = await queue.prepareCurrent(target, `cli-queue-${randomUUID()}`);
    await status(view);
    if (view.state !== 'awaiting-confirmation') return;
    await queue.confirm(target.scopeId, view.commandId, async (consent, summaries) => await ask(queueConsentCard(consent, locale, summaries)) === 'yes');
    view = await queue.inspect(target.scopeId, view.commandId) ?? view;
    await status(view); return;
  }
  const delivered = await port.deliver(preview, { candidate: `cli-candidate-${randomUUID()}`, delivery: `cli-delivery-${randomUUID()}` }, answer);
  print(t('cli.task.integration.delivered', { ref: delivered.ref, commit: delivered.commit }, locale));
  if (!preview.adoptionTargets.length) return;
  const targetRef = await ask({ title: t('cli.task.menu.adopt.title', { commit: delivered.commit.slice(0, 12) }, locale), body: [t('cli.task.menu.adopt.body', {}, locale)],
    options: [...preview.adoptionTargets.map(ref => ({ id: `ref:${ref}`, label: ref })), { id: 'no', label: t('cli.task.menu.adopt.later', {}, locale), key: 'n' }] });
  if (!targetRef?.startsWith('ref:')) { print(t('cli.task.menu.adopt.left', { command: delivered.commandId }, locale)); return; }
  let verificationRunId: string | undefined;
  if (preview.verification) {
    const runs = await port.verificationRuns(preview);
    const options = [...runs.map(run => ({ id: `run:${run.runId}`, label: t('cli.task.menu.adopt.verifyRow', { run: run.runId, task: run.taskId }, locale) })),
      ...(preview.verification.required ? [] : [{ id: 'none', label: t('cli.task.menu.adopt.withoutVerification', {}, locale) }])];
    const picked = options.length ? await ask({ title: t('cli.task.menu.adopt.verifyTitle', { kind: preview.verification.kind }, locale), body: [], options }) : null;
    if (!picked) { print(options.length ? t('cli.task.menu.adopt.left', { command: delivered.commandId }, locale)
      : t('cli.task.menu.adopt.noVerification', { command: delivered.commandId, kind: preview.verification.kind }, locale)); return; }
    if (picked.startsWith('run:')) verificationRunId = picked.slice(4);
  }
  const adopted = await port.adopt(preview, delivered, targetRef.slice(4), `cli-adopt-${randomUUID()}`, answer, verificationRunId);
  print(t('cli.task.menu.adopt.done', { target: adopted.targetRef, from: adopted.fromCommit.slice(0, 12), to: adopted.toCommit.slice(0, 12),
    verification: adopted.verifiedBy ? t('cli.task.menu.adopt.verifiedBy', { run: adopted.verifiedBy }, locale) : t('cli.task.menu.adopt.notVerified', {}, locale),
    command: adopted.commandId }, locale));
}
