import preview from './preview.json' with { type: 'json' };
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ErrorRegistry, getConfigFieldDefault, redactForRecord, t, type Locale, MESSAGE_REGISTRY } from '#platform/index.js';
import type { EffectConfirmationView, QueueConsent, TargetQueueView } from '#engine/index.js';
const word = (key: string, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[key] ?? key;
const text = (value: string) => redactForRecord(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
/** One window, one explicit y. EOF, cancellation, blank input and every other answer decline. */
export async function askDeliveryConfirmation(view: EffectConfirmationView, locale: Locale,
  input: Readable = process.stdin, output: Writable = process.stderr, control: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<boolean> {
  if (!(input as { isTTY?: boolean }).isTTY) throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED');
  const operation = view.operation === 'deliver-integration' ? t('cli.help.action.integration-deliver', {}, locale)
    : view.operation === 'rollback-integration' ? t('cli.help.action.integration-rollback', {}, locale) : t('cli.help.action.integration-adopt', {}, locale);
  output.write(t('cli.task.delivery.card', { operation,
    title: text(view.title), run: text(view.runId), task: text(view.taskId), ref: text(view.resource),
    from: text(view.from), to: text(view.to), count: view.files.length, added: view.added, removed: view.removed,
    files: view.files.slice(0, preview.maxFiles).map(text).join('\n'), omitted: Math.max(0, view.files.length - preview.maxFiles) }, locale) + '\n');
  return askLine(locale, input, output, control);
}
export async function askQueueConfirmation(view: Omit<QueueConsent, 'capability'>, locale: Locale,
  input: Readable = process.stdin, output: Writable = process.stderr, control: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<boolean> {
  if (!(input as { isTTY?: boolean }).isTTY) throw ErrorRegistry.createError('DELIVERY_INTERACTIVE_REQUIRED');
  output.write(renderQueueConsent(view, locale) + '\n');
  // The adoption card moves a branch: its question says so; publication keeps the reference-write question.
  return askLine(locale, input, output, control, view.operation === 'adopt' ? t('queue.confirm.adoptPrompt', { branch: text(view.target.id) }, locale) : undefined);
}
export function renderQueueConsent(view: Omit<QueueConsent, 'capability'>, locale: Locale): string {
  return t('queue.confirm.card', { operation: word(`queue.confirm.${view.operation}`, locale),
    targetLabel: word(view.display.labelKey, locale), target: text(view.target.id), digest: view.digest, expires: new Date(view.expiresAt).toISOString(), count: view.items.length,
    items: view.items.map(item => t('queue.confirm.item', { command: text(item.commandId), from: text(item.from), to: text(item.to),
      candidate: item.candidateDigest, verification: item.verificationReceipt, changes: item.changes.slice(0, preview.maxFiles).map(text).join('\n'), omitted: Math.max(0, item.changes.length - preview.maxFiles) }, locale)).join('\n') }, locale);
}
async function askLine(locale: Locale, input: Readable, output: Writable, control: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  prompt = t('cli.task.delivery.prompt', {}, locale)): Promise<boolean> {
  const reader = createInterface({ input, output, terminal: true });
  const timeoutMs = control.timeoutMs ?? getConfigFieldDefault('approvals').sessionTtlMs;
  const timer = setTimeout(() => reader.close(), timeoutMs);
  const abort = () => reader.close();
  control.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (control.signal?.aborted) return false;
    return await new Promise<boolean>(resolve => {
      let finished = false;
      const finish = (value: boolean) => { if (!finished) { finished = true; resolve(value); } };
      reader.once('close', () => finish(false)); reader.once('SIGINT', () => { finish(false); reader.close(); });
      reader.question(prompt, answer => finish(answer.trim().toLowerCase() === 'y'));
    });
  } finally { clearTimeout(timer); control.signal?.removeEventListener('abort', abort); reader.close(); }
}

export function renderQueueStatus(view: TargetQueueView, locale: Locale): string {
  return t('queue.window.status', { targetLabel: word(view.display.labelKey, locale), target: text(view.target.id), basisLabel: word(view.display.basisKey, locale), basis: view.basis?.effective ?? '—', versionLabel: word(view.display.versionKey, locale), version: view.basis?.candidate ?? '—', command: view.commandId, position: view.position ?? '—', state: word(`queue.state.${view.state}`, locale),
    outcome: view.outcome ? word(`queue.outcome.${view.outcome}`, locale) : view.reason ? word(`error.${view.reason}`, locale) : '—',
    owner: word(`queue.owner.${view.responsibility}`, locale), next: word(view.nextAction === 'prepare-current' ? view.display.prepareActionKey : `queue.next.${view.nextAction}`, locale) }, locale);
}
