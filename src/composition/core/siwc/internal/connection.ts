import { randomUUID, createHash } from 'node:crypto';
import { identityProfileConfigSchema, type VerifiedPrincipal } from '#domain/index.js';
import { subscriptionActor, PersonalCustodyError, IdentityProfileRegistry, OAuthConnectionApplication, OAuthConnectionError, assertAuthorityWitness,
  policySecretChangeAuthorization, type OAuthConnectionOwner, type OAuthConnectionView } from '#engine/index.js';
import { createInstallationSecretCustody, openConfiguredSecretStore,
  SIWC_PROTOCOL, createSiwcOAuthTransport, siwcBrowserAuthorization, createSiwcConnectionLock, localInstallationBindingSource,
  localPrincipalChannel, localPrincipalPeer, withLocalPrincipalChannel, attestLocalInteractiveTerminal } from '#adapters/index.js';
import { resolveGlobalConfigPaths, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';

export type SiwcBrowserPresentation = Readonly<{ fallback?: (url: string) => void; signal?: AbortSignal }>;
/** Private host lifecycle composition. The terminal process alone admits login, never the runtime service or MCP. */
export async function withConfiguredSiwc<T>(root: string, scopeId: string, options: ConfigLoadOptions,
  operation: 'connect' | 'logout' | 'lease' | 'inspect', work: (app: OAuthConnectionApplication, caller: OAuthConnectionOwner) => Promise<T>,
  presentation: SiwcBrowserPresentation = {}, actor?: VerifiedPrincipal): Promise<T> {
  const interactive = operation === 'connect' || operation === 'logout';
  if (interactive) await assertAuthorityWitness('models.login', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined),
    { attest: () => attestLocalInteractiveTerminal() });
  const callerContext = await loadConfiguredScopeContext(root, scopeId, options, interactive ? 'write' : 'read');
  const invokingActor = actor ?? callerContext.principal;
  // The OAuth lifecycle owner is this verified OS account. The invoking actor stays separate and is never promoted to that person.
  const context = await withLocalPrincipalChannel(undefined, () => loadConfiguredScopeContext(root, scopeId, options, interactive ? 'write' : 'read'), localPrincipalPeer());
  if (callerContext.installationId !== context.installationId || callerContext.config.company.id !== context.config.company.id) throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  const invokingOwner = subscriptionActor(invokingActor).owner;
  if (!invokingActor.scopeIds.includes(scopeId) || invokingOwner.issuer !== context.principal.issuer || invokingOwner.subject !== context.principal.subject)
    throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  if (interactive && subscriptionActor(invokingActor).principalClass !== 'person') throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  if (!context.installationId) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
  const owner = { installationId: context.installationId, companyId: context.config.company.id, scopeId, principal: subscriptionActor(context.principal).owner };
  const caller = { ...owner, principal: { issuer: invokingActor.issuer, subject: invokingActor.subject } }, env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const peer = localPrincipalPeer(), peerWitness = peer ? randomUUID() : null;
  const custody = createInstallationSecretCustody(env, platform, undefined, {
    reconnect: operation === 'connect', witness: () => interactive ? attestLocalInteractiveTerminal() : Promise.resolve(false),
    async snapshot() {
      if (peer && (peer.connection?.aborted || !peer.isConnectionActive?.() || peer.uid !== process.getuid?.())) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      const fresh = await withLocalPrincipalChannel(undefined, () => loadConfiguredScopeContext(root, scopeId, options, 'read'), localPrincipalPeer());
      if (!fresh.installationId || fresh.installationId !== owner.installationId || fresh.config.company.id !== owner.companyId)
        throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      const selected = identityProfileConfigSchema.safeParse(fresh.config['identity']);
      if (!selected.success) throw new PersonalCustodyError('profile-unresolved');
      const entry = new IdentityProfileRegistry(selected.data.packages).resolve(selected.data.profile);
      const location = await localInstallationBindingSource(fresh.layout, fresh.config.installation).capture();
      if ('status' in location) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      return { owner, actor: invokingActor, ...(peer && peerWitness ? { peer: { pid: peer.pid, uid: peer.uid, witness: peerWitness } } : {}), profile: { id: entry.definition.id, version: entry.definition.version, digest: entry.digest },
        locationDigest: createHash('sha256').update(JSON.stringify(location)).digest('hex') };
    },
  });
  return withScopeAudit(context, audit => {
    const app = new OAuthConnectionApplication({ owner, protocol: SIWC_PROTOCOL, store: openConfiguredSecretStore(context.config, env, platform), custody,
      connectionLock: createSiwcConnectionLock(`${resolveGlobalConfigPaths(env, platform).platformPath}.secret-custody`),
      authorize: policySecretChangeAuthorization(context.document, context.principal), audit: event => { audit.record(event); }, now: Date.now,
      ...createSiwcOAuthTransport(), browser: (makeUrl, signal) => siwcBrowserAuthorization(makeUrl, signal, presentation) });
    return work(app, caller);
  }, false);
}
/** The rich local terminal alone receives the optional account label. All JSON/MCP views omit the field entirely. */
export function siwcConnectionView(view: OAuthConnectionView, surface: 'terminal' | 'json' | 'mcp') {
  const { email, ...safe } = view;
  return surface === 'terminal' ? Object.freeze({ ...safe, email }) : Object.freeze(safe);
}
