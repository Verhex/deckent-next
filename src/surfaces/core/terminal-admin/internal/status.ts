import { t } from '#platform/index.js';
import { part } from './failure.js';
import type { TerminalAdminCall } from './context.js';

/** `/status`: the host's status report re-read now (`report`), then the runtime service as it answers now. A failed read is named, not replaced by the opening line. */
export async function statusLines(call: TerminalAdminCall, report: () => Promise<string>): Promise<readonly string[]> {
  const { root, options, locale, context } = call;
  const body = await report();
  const service = await part(t('terminal.admin.status.partService', {}, locale), locale, context.describeRuntimeService ? async () => {
    const descriptor = await context.describeRuntimeService!(root, options);
    return [t('terminal.admin.status.service', { instance: descriptor.instanceId, pid: descriptor.processId ?? '-',
      build: descriptor.build?.sourceCommit?.slice(0, 12) ?? t('terminal.value.unknown', {}, locale) }, locale)];
  } : null);
  return [...body.split('\n'), ...service];
}
