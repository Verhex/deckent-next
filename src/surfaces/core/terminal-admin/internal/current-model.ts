import { t } from '#platform/index.js';
import type { TerminalAdminCall } from './context.js';

/** What `/status` and `/model` show about the model this terminal chats with: a human name when the catalog knows it, the exact reference always. */
export type CurrentModel = Readonly<{ status: 'ready' | 'not-declared'; reference: string; text: string; short: string }> | null;

type Reference = Readonly<{ providerId: string; providerVersion: number; modelId: string; modelVersion: number }>;
type CatalogChannel = Readonly<{ channelId: string; access: string; providerVersion?: number; channel?: Readonly<{ kind: string; cli?: string | null }>;
  models?: readonly Readonly<{ modelId: string; model: Readonly<Record<string, unknown>> }>[] }>;

/** The channel kind in words; an unknown kind stays its typed name (a fallback the person can still read and copy). */
export function channelKindText(kind: string | undefined, cli: string, channelId: string, locale: TerminalAdminCall['locale']): string {
  if (kind === 'native-cli') return t('terminal.admin.model.kindNativeCli', { cli }, locale);
  if (kind === 'http-api') return t('terminal.admin.model.kindHttpApi', {}, locale);
  if (kind === 'local-server') return t('terminal.admin.model.kindLocalServer', {}, locale);
  return kind ?? channelId;
}
function toolSupportText(support: string | undefined, locale: TerminalAdminCall['locale']): string | null {
  if (support === 'supported') return t('terminal.admin.model.toolsSupported', {}, locale);
  if (support === 'unsupported') return t('terminal.admin.model.toolsUnsupported', {}, locale);
  return support === 'unknown' ? t('terminal.admin.model.toolsUnknown', {}, locale) : null;
}
/** The model lifecycle state in words. */
export function lifecycleText(state: string, locale: TerminalAdminCall['locale']): string {
  if (state === 'active') return t('terminal.admin.model.lifecycleActive', {}, locale);
  if (state === 'legacy') return t('terminal.admin.model.lifecycleLegacy', {}, locale);
  if (state === 'deprecated') return t('terminal.admin.model.lifecycleDeprecated', {}, locale);
  return state === 'retired' ? t('terminal.admin.model.lifecycleRetired', {}, locale) : state;
}

/** `<display name> (local server) · tool calls supported`: display name, channel kind and tool support from the ledger catalog entry (channel evidence, not a probe). */
export function modelEntryText(channel: CatalogChannel, entry: Readonly<{ modelId: string; model: Readonly<Record<string, unknown>> }>, locale: TerminalAdminCall['locale']): Readonly<{ short: string; text: string }> {
  const model = entry.model as { displayName?: string; capabilities?: { tools?: string } };
  const where = channelKindText(channel.channel?.kind, channel.channel?.cli ?? channel.channelId, channel.channelId, locale);
  const tools = toolSupportText(model.capabilities?.tools, locale);
  const short = t('terminal.admin.model.named', { name: model.displayName ?? entry.modelId, where }, locale);
  return { short, text: [short, ...(tools ? [tools] : [])].join(' · ') };
}

/** The current model in words. The catalog read is best effort here (`/model` names a failing catalog itself): without it the exact reference is the text. */
export async function readCurrentModel(call: TerminalAdminCall): Promise<CurrentModel> {
  const { root, scopeId, options, locale, context } = call;
  if (!context.describeTerminalChatPlan) return null;
  const plan = await context.describeTerminalChatPlan(root, options);
  const reference = plan.reference as Reference | null;
  if (!reference) return null;
  const name = `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
  let found: Readonly<{ short: string; text: string }> = { short: reference.modelId, text: reference.modelId };
  if (context.inspectModelCatalog) {
    try {
      const view = await context.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options);
      for (const channel of view.channels as readonly CatalogChannel[]) {
        const entry = channel.access === 'denied' ? undefined : channel.models?.find(item => channel.channelId === reference.providerId && channel.providerVersion === reference.providerVersion
          && (item.model as { id?: string; version?: number }).id === reference.modelId && (item.model as { version?: number }).version === reference.modelVersion);
        if (entry) { found = modelEntryText(channel, entry, locale); break; }
      }
    } catch { /* the catalog part of /model names its own failure; here the reference stays the text */ }
  }
  return { status: plan.status === 'ready' ? 'ready' : 'not-declared', reference: name, ...found };
}
