import { recordConfiguredProviderFailure } from './diagnostic.js';
import { modelInvocationProfileSchema } from '#domain/index.js';
import { ModelInvocationPolicyAuthorization, openInvocationWorkspaceSelection } from '#engine/index.js';
import { listProviderWorkspaces, ProviderModelListError, providerProfileWorkspaceOffer, PROVIDER_CONNECT_KINDS } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { projectCredentialResolver } from '#composition/core/secrets/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** Wiring only: the engine owns choice custody; adapter owns free discovery; config owns governed publication. */
export async function openConfiguredProviderWorkspaces(root: string, scopeId: string, options: ConfigLoadOptions = {}) {
  return openInvocationWorkspaceSelection(scopeId, {
    async read() { const current = await loadConfiguredScopeContext(root, scopeId, { ...options, force: true, heal: false }, 'read');
      return { ...current, identity: JSON.stringify([current.layout, current.installationId, current.projectId]),
        profiles: ((current.config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value)) }; },
    eligible: profile => PROVIDER_CONNECT_KINDS.some(kind => kind.connect?.workspaceList && kind.connect.adapter === profile.adapter.id
      && kind.endpoint.default !== null && new URL(kind.connect.chatPath!, kind.endpoint.default).href === profile.adapter.definition['endpoint']),
    authorize: async (profile, current) => { await new ModelInvocationPolicyAuthorization({ async load() { return current.document; } }).authorize('invoke', { scopeId, reference: profile.reference }, current.principal); },
    async credential(profile, current) { const name = (profile.adapter.definition['authentication'] as { credentialRef?: string } | undefined)?.credentialRef;
      return name ? projectCredentialResolver(current, scopeId, options).resolve(name) : undefined; },
    async discover(profile, key) { try { return await listProviderWorkspaces(profile, key); }
      catch (error) { if (error instanceof ProviderModelListError) { await recordConfiguredProviderFailure(root, 'workspace-discovery', error, options);
        throw ErrorRegistry.createError(error.code, { params: { cause: error.cause, status: error.status ?? '', address: error.address ?? '' } }); } throw error; } }, offer: providerProfileWorkspaceOffer, snapshots: async () => [await snapshotConfiguredConfig(root, options, 'global'), await snapshotConfiguredConfig(root, options, 'project')],
  }); }
