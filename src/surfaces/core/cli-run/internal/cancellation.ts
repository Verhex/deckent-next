import { EXIT_CODES, t, type ExitCode, type Locale } from '#platform/index.js';
import type { RunCancellationDeliveryHandler } from '#surfaces/core/cli-terminal/index.js';

type RunCancellationResult = Awaited<ReturnType<RunCancellationDeliveryHandler>>;

function unconfirmedCancellations(data: RunCancellationResult): number {
  return data.delivery.outcomes.filter(item => item.status !== 'terminal' && item.status !== 'not-dispatched' && item.status !== 'prevented').length;
}

export function runCancellationExitCode(data: RunCancellationResult): ExitCode {
  return unconfirmedCancellations(data) ? EXIT_CODES.error : EXIT_CODES.success;
}

/** Human rendering of a typed cancellation delivery; shared by `run cancel` and the terminal `/cancel` card. */
export function renderRunCancellation(data: RunCancellationResult, commandId: string, scopeId: string, runId: string, locale: Locale): string {
  const labels = {
    terminal: t('cli.run.cancel.terminal', {}, locale), unresolved: t('cli.run.cancel.unresolved', {}, locale),
    denied: t('cli.run.cancel.denied', {}, locale), unavailable: t('cli.run.cancel.unavailable', {}, locale),
    prevented: t('cli.run.cancel.prevented', {}, locale),
    'not-dispatched': t('cli.run.cancel.notDispatched', {}, locale),
  };
  const deliveryLabels = { queued: t('cli.run.cancel.deliveryQueued', {}, locale), claimed: t('cli.run.cancel.deliveryClaimed', {}, locale), exhausted: t('cli.run.cancel.deliveryExhausted', {}, locale), terminal: labels.terminal, prevented: labels.prevented };
  const unconfirmed = unconfirmedCancellations(data);
  return [t('cli.run.cancel.heading', { run: data.delivery.runId, command: commandId }, locale),
    ...(unconfirmed ? [t('cli.run.cancel.unconfirmed', { count: unconfirmed, total: data.delivery.outcomes.length }, locale)] : []),
    ...data.delivery.outcomes.flatMap(item => [t('cli.run.cancel.outcome', { task: item.taskId, attempt: item.attemptId, status: labels[item.status] }, locale),
      ...(item.delivery && ['queued', 'claimed', 'exhausted'].includes(item.delivery.state)
        ? [t('cli.run.cancel.delivery', { count: item.delivery.attempts, state: deliveryLabels[item.delivery.state] }, locale)] : [])]),
    ...(data.delivery.outcomes.length ? [] : [t('cli.run.cancel.empty', {}, locale)]),
    t('cli.run.cancel.notice', { scope: scopeId, run: runId }, locale),
  ].join('\n');
}
