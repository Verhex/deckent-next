import { PACKAGE_VERSION, t } from '#platform/index.js';
import { queryFailureText } from './failure.js';
import { readCurrentModel } from './current-model.js';
import type { TerminalAdminCall } from './context.js';

/**
 * `/status`: one human sentence (is Deckent running, which version, which model), then the details: the host's status report re-read now (`report`)
 * and the runtime service as it answers now (instance, pid, build). A failed read is named, never replaced by an earlier value or the opening line.
 */
export async function statusLines(call: TerminalAdminCall, report: () => Promise<string>): Promise<readonly string[]> {
  const { root, options, locale, context } = call;
  const body = await report();
  let state = t('terminal.admin.status.open', {}, locale);
  let service: string;
  if (!context.describeRuntimeService) service = t('terminal.admin.partUnavailable', { part: t('terminal.admin.status.partService', {}, locale) }, locale);
  else {
    try {
      const descriptor = await context.describeRuntimeService(root, options);
      state = t('terminal.admin.status.running', {}, locale);
      service = t('terminal.admin.status.service', { instance: descriptor.instanceId, pid: descriptor.processId ?? '-',
        build: descriptor.build?.sourceCommit?.slice(0, 12) ?? t('terminal.value.unknown', {}, locale) }, locale);
    } catch (error) {
      state = t('terminal.admin.status.serviceUnread', {}, locale);
      service = t('terminal.admin.partFailed', { part: t('terminal.admin.status.partService', {}, locale), reason: queryFailureText(error, locale) }, locale);
    }
  }
  let model: string;
  try {
    const current = await readCurrentModel(call);
    model = current ? t('terminal.admin.status.model', { model: current.short }, locale) : t('terminal.admin.status.noModel', {}, locale);
  } catch { model = t('terminal.admin.status.modelUnread', {}, locale); }
  return [[state, t('terminal.admin.status.version', { version: PACKAGE_VERSION }, locale), model].join(' · '),
    t('terminal.admin.status.details', {}, locale), ...[...body.split('\n'), service].map(line => `  ${line}`)];
}
