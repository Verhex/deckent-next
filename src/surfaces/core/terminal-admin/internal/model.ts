import { t } from '#platform/index.js';
import { part } from './failure.js';
import type { TerminalAdminCall } from './context.js';

type CurrentReference = Readonly<{ providerId: string; providerVersion: number; modelId: string; modelVersion: number }>;

/** `/model`: the model this terminal chats with now (fresh chat plan) and the ledger catalog as this scope sees it. Selecting is a later, governed step. */
export async function modelLines(call: TerminalAdminCall, args: string): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  if (args.trim()) return [t('terminal.admin.model.usage', {}, locale)];
  // The exact reference (provider id and version, catalog model id and version), never a bare model id: the same model offered by another
  // provider channel, or another version of it, is not what this terminal chats with (P2-3b).
  let current: CurrentReference | null = null;
  const identity = await part(t('terminal.admin.model.partIdentity', {}, locale), locale, context.describeTerminalChatPlan ? async () => {
    const plan = await context.describeTerminalChatPlan!(root, options);
    const reference = plan.reference;
    if (!reference) return [t('terminal.admin.model.notConfigured', {}, locale)];
    current = reference;
    const name = `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
    return [plan.status === 'ready' ? t('terminal.admin.model.current', { model: name }, locale) : t('terminal.admin.model.currentNotDeclared', { model: name }, locale)];
  } : null);
  const catalog = await part(t('terminal.admin.model.partCatalog', {}, locale), locale, context.inspectModelCatalog ? async () => {
    const view = await context.inspectModelCatalog!(root, { schemaVersion: 1, scopeId }, options);
    const state = (value: { state: string } | null) => value?.state === 'active' ? t('terminal.admin.model.active', {}, locale) : t('terminal.admin.model.inactive', {}, locale);
    const lines = [t('terminal.admin.model.catalogHeading', { scope: view.scopeId, count: view.channels.length }, locale)];
    for (const channel of view.channels) {
      if (channel.access === 'denied') { lines.push(t('terminal.admin.model.channelDenied', { channel: channel.channelId }, locale)); continue; }
      lines.push(t('terminal.admin.model.channel', { channel: channel.channelId, kind: channel.channel.kind, state: state(channel.activation) }, locale));
      for (const entry of channel.models) {
        // The ledger lists a model under its native id; a ModelReference names the catalog model id (binding resolution compares `model.id`).
        const isCurrent = current !== null && channel.channelId === current.providerId && channel.providerVersion === current.providerVersion
          && entry.model.id === current.modelId && entry.model.version === current.modelVersion;
        lines.push(t('terminal.admin.model.entry', { model: entry.modelId, lifecycle: entry.model.lifecycle.state, state: state(entry.activation),
          mark: isCurrent ? t('terminal.admin.model.currentMark', {}, locale) : '' }, locale));
      }
    }
    return [...lines, t('terminal.admin.model.notice', {}, locale)];
  } : null);
  return [...identity, ...catalog];
}
