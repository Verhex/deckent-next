import { t } from '#platform/index.js';
import { part } from './failure.js';
import type { TerminalAdminCall } from './context.js';

/** `/model`: the model this terminal chats with now (fresh chat plan) and the ledger catalog as this scope sees it. Selecting is a later, governed step. */
export async function modelLines(call: TerminalAdminCall, args: string): Promise<readonly string[]> {
  const { root, scopeId, options, locale, context } = call;
  if (args.trim()) return [t('terminal.admin.model.usage', {}, locale)];
  let current: string | null = null;
  const identity = await part(t('terminal.admin.model.partIdentity', {}, locale), locale, context.describeTerminalChatPlan ? async () => {
    const plan = await context.describeTerminalChatPlan!(root, options);
    const reference = plan.reference;
    if (!reference) return [t('terminal.admin.model.notConfigured', {}, locale)];
    current = reference.modelId;
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
      for (const entry of channel.models) lines.push(t('terminal.admin.model.entry', { model: entry.modelId, lifecycle: entry.model.lifecycle.state, state: state(entry.activation),
        mark: entry.modelId === current ? t('terminal.admin.model.currentMark', {}, locale) : '' }, locale));
    }
    return [...lines, t('terminal.admin.model.notice', {}, locale)];
  } : null);
  return [...identity, ...catalog];
}
