import preview from './preview.json' with { type: 'json' };
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ErrorRegistry, getConfigFieldDefault, redactForRecord, t, type Locale } from '#platform/index.js';
import type { EffectConfirmationView } from '#engine/index.js';
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
      reader.question(t('cli.task.delivery.prompt', {}, locale), answer => finish(answer.trim().toLowerCase() === 'y'));
    });
  } finally { clearTimeout(timer); control.signal?.removeEventListener('abort', abort); reader.close(); }
}
