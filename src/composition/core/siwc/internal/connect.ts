import { modelInvocationProfileSchema, type ModelConnectCommand, type JsonObject } from '#domain/index.js';
import { OAuthConnectionError, prepareSubscriptionConsent, modelInvocationProfileDigest, modelInvocationBillingAxis, type ConnectedAdapter } from '#engine/index.js';
import { SIWC_INFERENCE, listSiwcModels, siwcResponsesDefinitionSchema,
  OPENAI_CHAT_COMPLETIONS_FAMILY, OPENAI_CHAT_COMPLETIONS_VERSION } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { withConfiguredSiwc, type SiwcBrowserPresentation } from './connection.js';

/** One witnessed connect, followed by the existing governed catalog/profile/activation owners. */
export function configuredSiwcConnect(root: string, command: ModelConnectCommand, options: ConfigLoadOptions, presentation: SiwcBrowserPresentation = {}) {
  let session: { connectionId: string; owner: { issuer: string; subject: string } } | null = null;
  const ensure = async () => {
    if (session) return session;
    return withConfiguredSiwc(root, command.scopeId, options, 'connect', async (app, caller) => {
      const records = await app.list();
      const requested = command.subscription?.connectionId, fresh = command.subscription?.newAccount === true;
      if (fresh && (requested || records.some(row => row.state !== 'disconnected' && row.state !== 'registration'))) throw new OAuthConnectionError('SIWC_ACCOUNT_STILL_CONNECTED');
      if (!fresh && !requested && records.length > 1) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const current = fresh ? undefined : requested ? records.find(record => record.connectionId === requested) : records[0];
      if (requested && !current) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const connected = current?.state === 'connected' && current.planUse ? current
        : await app.connect({ ...(current ? { connectionId: current.connectionId, enablePlanUse: true } : {}), planUse: true }, presentation.signal);
      if (!connected.planUse) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
      return session = { connectionId: connected.connectionId, owner: { issuer: caller.principal.issuer, subject: caller.principal.subject } };
    }, presentation);
  };
  return {
    async models() {
      const selected = await ensure();
      return withConfiguredSiwc(root, command.scopeId, options, 'lease', (app, caller) => listSiwcModels(signal => app.lease(selected.connectionId, caller, signal)));
    },
    async adapter(existing?: JsonObject | null): Promise<ConnectedAdapter> {
      const selected = await ensure(), delegatedUse = prepareSubscriptionConsent(existing, command.delegate ?? [], selected.owner, Date.now());
      let apiContinuation: unknown = existing?.['apiContinuation'] ?? null;
      if (command.subscription?.apiContinuation !== undefined) {
        const reference = command.subscription.apiContinuation;
        if (reference === null) apiContinuation = null;
        else {
          const config = await loadComposedConfig(root, { ...options, heal: false });
          const profiles = (config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [];
          const target = profiles.map(value => modelInvocationProfileSchema.parse(value)).find(profile => profile.scopeId === command.scopeId
            && JSON.stringify(profile.reference) === JSON.stringify(reference));
          if (!target || modelInvocationBillingAxis(target) !== 'metered') throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
          apiContinuation = { reference, profileDigest: modelInvocationProfileDigest(target) };
        }
      }
      const definition = siwcResponsesDefinitionSchema.parse({ schemaVersion: 2, ...selected, rawUse: 'person', delegatedUse,
        apiContinuation });
      return { adapter: { ...SIWC_INFERENCE.adapter, definition: definition as unknown as JsonObject },
        protocol: { family: OPENAI_CHAT_COMPLETIONS_FAMILY, version: OPENAI_CHAT_COMPLETIONS_VERSION }, billingAxis: 'subscription', tariff: 'unmetered' };
    },
  };
}
