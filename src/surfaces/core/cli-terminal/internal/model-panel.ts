import { loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelReference } from '#domain/index.js';
import type { ModelPanelChoice, ModelPanelSource, ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import { terminalConfigWrite, type ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { TerminalLaunchContext } from './context.js';

type Host = Pick<TerminalLaunchContext, 'inspectDeclaredModels' | 'inspectModelActivation' | 'inspectModelBinding' | 'inspectModelCatalog' | 'describeTerminalChatPlan'
  | 'listSecretNames' | 'inspectProviderSpendAccount'> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;
/** T4-B D1: the words of the setting that chose the model in effect (the `/model` window shows which layer wins). */
function winnerNote(source: string | null | undefined, model: string, locale: Locale): string | null {
  switch (source) {
    case 'project': return t('tui.model.winner.project', { model }, locale);
    case 'user-default': return t('tui.model.winner.userDefault', { model }, locale);
    case 'user': return t('tui.model.winner.user', { model }, locale);
    default: return null;
  }
}
type Profile = Readonly<{ reference: ModelReference; credentialRef: string | null }>;

const sameReference = (left: ModelReference, right: ModelReference) => left.providerId === right.providerId && left.providerVersion === right.providerVersion
  && left.modelId === right.modelId && left.modelVersion === right.modelVersion;
function profilesOf(config: Record<string, unknown>, scopeId: string): readonly Profile[] {
  const profiles = (config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [];
  return profiles.flatMap(raw => {
    const value = raw as { scopeId?: unknown; reference?: ModelReference; adapter?: { definition?: { authentication?: { credentialRef?: unknown } } } };
    const ref = value.adapter?.definition?.authentication?.credentialRef;
    return value.scopeId === scopeId && value.reference ? [{ reference: value.reference, credentialRef: typeof ref === 'string' ? ref : null }] : [];
  });
}
/** Whether this scope has a provider spending budget (the typed refusal without one: PROVIDER_SPEND_UNAVAILABLE): one declared in configuration,
 * or (stage 1) the scope's ledger account a governed create or an earlier call opened, read through the service. An unreadable account counts as none. */
export async function scopeBudgeted(config: Record<string, unknown>, scopeId: string, read: { root: string; options: ConfigLoadOptions;
  inspect?: TerminalLaunchContext['inspectProviderSpendAccount'] }): Promise<boolean> {
  if (((config['provider_spending'] as { budgets?: readonly { scopeId?: unknown }[] } | undefined)?.budgets ?? []).some(budget => budget.scopeId === scopeId)) return true;
  return read.inspect ? (await read.inspect(read.root, { schemaVersion: 1, scopeId, current: true }, read.options).catch(() => null))?.checkpoint != null : false;
}
const errorCode = (error: unknown) => String((error as { code?: unknown })?.code ?? 'failed');

/**
 * The terminal `/model` window's source (T4 MODEL-SWITCH). It lists the models the provider catalog declares (exact references only) with what
 * stands between each and this scope's next turn, in the order the service checks them: an invocation profile in this scope (the connection),
 * the key that profile names in the secret store, and the model's activation. A model that fails one is listed with that reason and the exact
 * governed command, never pickable. Discovered models are never added or activated from here: the catalog changes only on its governed path.
 * Nothing here is a reachability probe; "ready" means every recorded precondition holds. The window names the setting that chose the model in effect.
 */
export function modelPanelSource(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): ModelPanelSource {
  const defaultBlocked = () => host.configApplication && host.resolveConfigPrincipal ? null : t('tui.model.defaultReadOnly', {}, locale);
  return {
    async inspect(): Promise<ModelPanelView> {
      const title = t('tui.model.title', { scope: scopeId }, locale), notes: string[] = [];
      const declared = host.inspectDeclaredModels ? await host.inspectDeclaredModels(root, options) : null;
      if (!declared || declared.status !== 'declared' || declared.catalog.providers.every(provider => provider.models.length === 0)) {
        return { title, choices: [], notes: [t('tui.model.noneDeclared', {}, locale)], defaultBlocked: defaultBlocked() };
      }
      const config = await loadConfig(root, options) as Record<string, unknown>, profiles = profilesOf(config, scopeId);
      // (a) owner 2026-10-08: every model call reserves against this scope's budget; without one each turn is refused PROVIDER_SPEND_UNAVAILABLE.
      const budgeted = await scopeBudgeted(config, scopeId, { root, options, inspect: host.inspectProviderSpendAccount });
      if (!budgeted) notes.push(t('tui.budget.missing', { scope: scopeId }, locale));
      let names: readonly string[] | null = null;
      if (host.listSecretNames) { try { names = (await host.listSecretNames(root, options)).names; } catch { names = null; } }
      const plan = host.describeTerminalChatPlan ? await host.describeTerminalChatPlan(root, options).catch(() => null) : null;
      // Display names from the ledger catalog when it knows the model (best effort; the exact reference is always shown).
      const display = new Map<string, string>();
      if (host.inspectModelCatalog) {
        try {
          for (const channel of (await host.inspectModelCatalog(root, { schemaVersion: 1, scopeId }, options)).channels) {
            if (channel.access === 'denied') continue;
            for (const entry of channel.models) {
              const name = (entry.model as { displayName?: string }).displayName;
              if (name) display.set(`${channel.channelId}@${channel.providerVersion}/${entry.model.id}@${entry.model.version}`, name);
            }
          }
        } catch { /* names only; the reference stays the text */ }
      }
      const choices = await Promise.all(declared.catalog.providers.flatMap(provider => provider.models.map(async (model): Promise<ModelPanelChoice> => {
        const reference: ModelReference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
        const exact = `${provider.id}@${provider.version}/${model.id}@${model.version}`;
        const profile = profiles.find(item => sameReference(item.reference, reference));
        let blocked: string | null = null, command: string | null = null;
        if (!budgeted) blocked = t('tui.model.reason.noBudget', {}, locale);
        else if (!profile) blocked = t('tui.model.reason.noProfile', {}, locale);
        else if (profile.credentialRef && names !== null && !names.includes(profile.credentialRef)) blocked = t('tui.model.reason.keyMissing', { name: profile.credentialRef }, locale);
        else if (host.inspectModelActivation) {
          try {
            const activation = (await host.inspectModelActivation(root, { schemaVersion: 1, scopeId, reference }, options)).activation;
            if (activation?.state !== 'active') {
              const binding = host.inspectModelBinding ? await host.inspectModelBinding(root, reference, options).catch(() => null) : null;
              blocked = t('tui.model.reason.inactive', {}, locale);
              command = t('tui.model.command.activate', { scope: scopeId, provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version,
                revision: activation?.revision ?? 0, digest: binding?.binding?.digest ?? '<digest>', catalog: binding?.catalogRevision ?? '<revision>' }, locale);
            }
          } catch (error) { blocked = t('tui.model.reason.activationUnread', { code: errorCode(error) }, locale); }
        }
        return { reference, label: display.get(exact) ?? model.id, detail: blocked ? t('tui.model.state.blocked', {}, locale) : t('tui.model.state.ready', {}, locale),
          group: provider.id, blocked, exact: t('tui.model.exact', { reference: exact, native: model.nativeId }, locale), command,
          configured: plan?.reference ? sameReference(plan.reference, reference) : false };
      })));
      const inEffect = plan?.reference ? choices.find(choice => sameReference(choice.reference, plan.reference!)) : undefined;
      const note = winnerNote(plan?.source, inEffect?.label ?? plan?.reference?.modelId ?? '-', locale);
      return { title, choices, notes: [...notes, ...(note ? [note] : [])], defaultBlocked: defaultBlocked() };
    },
    // "Also make default" (T4-B D1, Jev d84b248d): the user's `terminal.defaultModel` through the governed `/config` writer on the user (global)
    // layer — policy-checked, approval-aware, audited; the file is created when the person has none yet. Never the project file.
    ...(host.configApplication && host.resolveConfigPrincipal ? { async makeDefault(choice: { reference: ModelReference }) {
      const outcome = await terminalConfigWrite(root, { action: 'set', keyPath: 'terminal.defaultModel', value: { ...choice.reference }, layer: 'global' }, host, options, locale);
      const plan = host.describeTerminalChatPlan ? await host.describeTerminalChatPlan(root, options).catch(() => null) : null;
      // A project that names its own model keeps winning: the window then offers the two governed answers (owner 2026-10-08, Jev 77898686).
      const shadowed = outcome.status === 'applied' && plan?.source === 'project' && plan.reference;
      return { ...outcome, lines: [...outcome.lines, ...(shadowed ? [t('tui.model.defaultShadowed', {}, locale)] : [])],
        shadow: shadowed ? { projectModel: plan.reference!.modelId } : null };
    },
    // Only the project's `terminal.chat.reference` is written or removed (its chat siblings stay), through the same governed writer.
    async resolveShadow(choice: { reference: ModelReference; label: string }, action: 'remove' | 'align') {
      const outcome = await terminalConfigWrite(root, action === 'remove' ? { action: 'unset', keyPath: 'terminal.chat.reference', layer: 'project' }
        : { action: 'set', keyPath: 'terminal.chat.reference', value: { ...choice.reference }, layer: 'project' }, host, options, locale);
      return outcome.status !== 'applied' ? outcome : { ...outcome, lines: [action === 'remove' ? t('tui.model.shadow.removed', {}, locale)
        : t('tui.model.shadow.aligned', { model: choice.label }, locale), ...outcome.lines] };
    } } : {}),
  };
}
