import { loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelReference } from '#domain/index.js';
import type { ModelPanelChoice, ModelPanelSource, ModelPanelView } from '#surfaces/core/terminal-panels/index.js';
import type { TerminalLaunchContext } from './context.js';

type Host = Pick<TerminalLaunchContext, 'inspectDeclaredModels' | 'inspectModelActivation' | 'inspectModelBinding' | 'inspectModelCatalog' | 'describeTerminalChatPlan'
  | 'listSecretNames'>;
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
const errorCode = (error: unknown) => String((error as { code?: unknown })?.code ?? 'failed');

/**
 * The terminal `/model` window's source (T4 MODEL-SWITCH). It lists the models the provider catalog declares (exact references only) with what
 * stands between each and this scope's next turn, in the order the service checks them: an invocation profile in this scope (the connection),
 * the key that profile names in the secret store, and the model's activation. A model that fails one is listed with that reason and the exact
 * governed command, never pickable. Discovered models are never added or activated from here: the catalog changes only on its governed path.
 * Nothing here is a reachability probe; "ready" means every recorded precondition holds. The default write is not bound (open owner decision).
 */
export function modelPanelSource(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): ModelPanelSource {
  return {
    async inspect(): Promise<ModelPanelView> {
      const title = t('tui.model.title', { scope: scopeId }, locale), notes: string[] = [];
      const declared = host.inspectDeclaredModels ? await host.inspectDeclaredModels(root, options) : null;
      if (!declared || declared.status !== 'declared' || declared.catalog.providers.every(provider => provider.models.length === 0)) {
        return { title, choices: [], notes: [t('tui.model.noneDeclared', {}, locale)], defaultBlocked: t('tui.model.defaultPending', {}, locale) };
      }
      const profiles = profilesOf(await loadConfig(root, options) as Record<string, unknown>, scopeId);
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
        let blocked: string | null = null, state = t('tui.model.state.ready', {}, locale);
        if (!profile) blocked = t('tui.model.reason.noProfile', {}, locale);
        else if (profile.credentialRef && names !== null && !names.includes(profile.credentialRef)) blocked = t('tui.model.reason.keyMissing', { name: profile.credentialRef }, locale);
        else if (host.inspectModelActivation) {
          try {
            const activation = (await host.inspectModelActivation(root, { schemaVersion: 1, scopeId, reference }, options)).activation;
            if (activation?.state !== 'active') {
              const binding = host.inspectModelBinding ? await host.inspectModelBinding(root, reference, options).catch(() => null) : null;
              blocked = t('tui.model.reason.inactive', { scope: scopeId, provider: provider.id, providerVersion: provider.version, model: model.id, modelVersion: model.version,
                revision: activation?.revision ?? 0, digest: binding?.binding?.digest ?? '<digest>', catalog: binding?.catalogRevision ?? '<revision>' }, locale);
            }
          } catch (error) { blocked = t('tui.model.reason.activationUnread', { code: errorCode(error) }, locale); }
        }
        if (blocked) state = t('tui.model.state.blocked', {}, locale);
        return { reference, label: display.get(exact) ?? model.id, detail: t('tui.model.detail', { native: model.nativeId, reference: exact, state }, locale), group: provider.id,
          blocked, configured: plan?.reference ? sameReference(plan.reference, reference) : false };
      })));
      return { title, choices, notes, defaultBlocked: t('tui.model.defaultPending', {}, locale) };
    },
  };
}
