import { modelInvocationProfileSchema, type SubscriptionConnectionInspection } from '#domain/index.js';
import { ModelInvocationPolicyAuthorization, OAuthConnectionError } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, SIWC_INFERENCE } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { siwcConnectionView, withConfiguredSiwc } from '#composition/core/siwc/index.js';
/** Doctor projection only: no browser, renewal, profile change or email. Each row retains the caller's inspect authority. */
export async function inspectConfiguredSiwcConnections(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<readonly SubscriptionConnectionInspection[]> {
  const config = await loadComposedConfig(root, { ...options, heal: false });
  const profiles = ((config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value))
    .filter(profile => profile.scopeId === scopeId && profile.adapter.id === SIWC_INFERENCE.adapter.id);
  if (!profiles.length) return [];
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  const authorization = new ModelInvocationPolicyAuthorization({ load: async () => context.document });
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(row => row.connect?.adapter === SIWC_INFERENCE.adapter.id);
  if (!kind) return [];
  const rows: SubscriptionConnectionInspection[] = [];
  for (const profile of profiles) {
    try { await authorization.authorize('inspect', profile, context.principal); } catch { continue; }
    const base = { reference: profile.reference, connection: kind.id };
    try {
      const view = await withConfiguredSiwc(root, scopeId, options, 'inspect', async app => {
        const connectionId = profile.adapter.definition['connectionId'];
        if (typeof connectionId !== 'string') throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
        return siwcConnectionView(await app.inspect(connectionId), 'json');
      }, {}, context.principal);
      rows.push({ ...base, state: view.state, planUse: view.planUse, generation: view.generation, remoteRevocation: view.remoteRevocation });
    } catch (error) {
      const known = error instanceof OAuthConnectionError;
      rows.push({ ...base, state: 'unavailable', planUse: false, code: known ? error.code : 'OAUTH_CONNECTION_UNAVAILABLE',
        ...(known && error.reason ? { reason: error.reason } : {}) });
    }
  }
  return Object.freeze(rows);
}
