import { emit, t, terminalSafeText } from '#platform/index.js';
import type { WorkerImageCard } from '#engine/index.js';
import { askCliCard, formatDecimal, formatDuration, type CliCardIo } from '#surfaces/core/cli-human/index.js';

/**
 * BR1 (owner Q2 2026-10-23): the person's card before the first worker image. A build names the version, the size estimate, the build's time
 * bound (`toolchains.update.buildTimeoutMs`), the network it uses and what it leaves unchanged; an adoption names the image and the builder's
 * short check container. Only `y` goes on; then one line says the build runs and how long it may take. Nothing is preselected.
 */
export const workerImageConfirm = (io: CliCardIo, timeoutMs: number, sizeGigabytes: number) => async (card: WorkerImageCard): Promise<boolean> => {
  const l = io.locale, limit = formatDuration(timeoutMs, l), version = terminalSafeText(card.imageVersion), adopt = card.mode === 'adopt';
  const body = card.mode === 'adopt' ? [t('setup.workerImage.card.adopt', { image: terminalSafeText(card.imageId), version }, l), t('setup.workerImage.card.adoptCheck', {}, l)]
    : [t('setup.workerImage.card.build', { size: formatDecimal(sizeGigabytes, l, 1), limit }, l), t('setup.workerImage.card.network', {}, l),
      ...card.held ? [t('setup.workerImage.card.held', { held: terminalSafeText(card.held) }, l)] : [], t('setup.workerImage.card.next', {}, l)];
  const answer = await askCliCard({ title: adopt ? t('setup.workerImage.card.adoptTitle', { version }, l) : t('setup.workerImage.card.title', { version }, l), body,
    options: [{ id: 'go', label: adopt ? t('setup.workerImage.card.adoptYes', {}, l) : t('setup.workerImage.card.yes', {}, l), role: 'yes' }, { id: 'no', label: t('setup.window.no', {}, l), role: 'no' }] }, io);
  if (answer === 'go') emit(adopt ? t('setup.workerImage.checking', {}, l) : t('setup.workerImage.building', { limit }, l), io.stdout ? { stdout: io.stdout as { write(text: string): unknown } } : {});
  return answer === 'go';
};
