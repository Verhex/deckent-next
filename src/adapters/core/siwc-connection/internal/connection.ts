import { randomUUID, createHash } from 'node:crypto';
import { type VerifiedPrincipal, type policySchema } from '#domain/index.js';
import { subscriptionActor, oauthContextOwner, personalCustodyProfile, OAuthConnectionApplication, OAuthConnectionError, assertAuthorityWitness,
  policySecretChangeAuthorization, type OAuthConnectionOwner, type AuditApplication } from '#engine/index.js';
import { createInstallationSecretCustody, openConfiguredSecretStore } from '#adapters/core/contract/index.js';
import { SIWC_PROTOCOL, createSiwcOAuthTransport, siwcBrowserAuthorization, createSiwcConnectionLock } from '#adapters/core/provider-siwc/index.js';
import { localInstallationBindingSource } from '#adapters/core/installation-files/index.js';
import { localPrincipalChannel, localPrincipalPeer, withLocalPrincipalChannel, attestLocalInteractiveTerminal } from '#adapters/core/local-principal/index.js';
import { resolveGlobalConfigPaths, type ConfigLoadOptions, type ResolvedConfig, type ProductLayout } from '#platform/index.js';
type SiwcBrowserPresentation = Readonly<{ fallback?: (url: string) => void; signal?: AbortSignal }>;
interface SiwcConnectionContext { readonly installationId: string | null; readonly config: ResolvedConfig; readonly layout: ProductLayout;
  readonly principal: VerifiedPrincipal; readonly document: ReturnType<typeof policySchema.parse> }
/** Host OAuth owner; scoped context and audit remain the caller's existing application owners. */
export async function withSiwcConnection<T, C extends SiwcConnectionContext>(scopeId: string, options: ConfigLoadOptions,
  operation: 'connect' | 'logout' | 'lease' | 'inspect', work: (app: OAuthConnectionApplication, caller: OAuthConnectionOwner) => Promise<T>,
  ports: { context(access: 'read' | 'write'): Promise<C>; audit(context: C, work: (audit: AuditApplication) => Promise<T>): Promise<T> },
  presentation: SiwcBrowserPresentation = {}, actor?: VerifiedPrincipal): Promise<T> {
  const interactive = operation === 'connect' || operation === 'logout';
  if (interactive) await assertAuthorityWitness('models.login', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined),
    { attest: () => attestLocalInteractiveTerminal() });
  const callerContext = await ports.context(interactive ? 'write' : 'read');
  const invokingActor = actor ?? callerContext.principal;
  // The OAuth lifecycle owner is this verified OS account. The invoking actor stays separate and is never promoted to that person.
  const context = await withLocalPrincipalChannel(undefined, () => ports.context(interactive ? 'write' : 'read'), localPrincipalPeer());
  const { owner, caller } = oauthContextOwner(scopeId, interactive, invokingActor, subscriptionActor(invokingActor),
    { installationId: callerContext.installationId, companyId: callerContext.config.company.id, principal: callerContext.principal },
    { installationId: context.installationId, companyId: context.config.company.id, principal: subscriptionActor(context.principal).owner });
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const peer = localPrincipalPeer(), peerWitness = peer ? randomUUID() : null;
  const custody = createInstallationSecretCustody(env, platform, undefined, {
    reconnect: operation === 'connect', witness: () => interactive ? attestLocalInteractiveTerminal() : Promise.resolve(false),
    async snapshot() {
      if (peer && (peer.connection?.aborted || !peer.isConnectionActive?.() || peer.uid !== process.getuid?.())) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      const fresh = await withLocalPrincipalChannel(undefined, () => ports.context('read'), localPrincipalPeer());
      if (!fresh.installationId || fresh.installationId !== owner.installationId || fresh.config.company.id !== owner.companyId)
        throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      const profile = personalCustodyProfile(fresh.config['identity']);
      const location = await localInstallationBindingSource(fresh.layout, fresh.config.installation).capture();
      if ('status' in location) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      return { owner, actor: invokingActor, ...(peer && peerWitness ? { peer: { pid: peer.pid, uid: peer.uid, witness: peerWitness } } : {}), profile,
        locationDigest: createHash('sha256').update(JSON.stringify(location)).digest('hex') };
    },
  });
  return ports.audit(context, audit => {
    const app = new OAuthConnectionApplication({ owner, protocol: SIWC_PROTOCOL, store: openConfiguredSecretStore(context.config, env, platform), custody,
      connectionLock: createSiwcConnectionLock(`${resolveGlobalConfigPaths(env, platform).platformPath}.secret-custody`),
      authorize: policySecretChangeAuthorization(context.document, context.principal), audit: event => { audit.record(event); }, now: Date.now,
      ...createSiwcOAuthTransport(), browser: (makeUrl, signal) => siwcBrowserAuthorization(makeUrl, signal, presentation) });
    return work(app, caller);
  });
}
