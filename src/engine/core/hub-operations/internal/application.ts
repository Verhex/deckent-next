import { HubError, requireBoundedHubJson, canonicalHubJson, isAiPrincipal } from '#domain/index.js';
import { ErrorRegistry, hasSecret, REDACTION_GATE_PATTERNS, EMPTY_KNOWN_SECRETS } from '#platform/index.js';
import { HubClientError, decodeHubBundle } from '#engine/core/hub-client/index.js';
import { parseHubOperation, type HubOperationPorts, type HubRemoteOperation } from './contract.js';

/** One installation-side dispatcher. Local state changes remain owned by HubClientApplication. */
export class HubApplication {
  constructor(private readonly ports: HubOperationPorts) {}
  async execute(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    signal.throwIfAborted();
    const request = parseHubOperation(input), client = this.ports.client;
    switch (request.operation) {
      case 'hub.sources.list': return client.listSources(request.input);
      case 'hub.sources.add': return client.addSource(request.input);
      case 'hub.sources.remove': return client.removeSource(request.input);
      case 'hub.inspect': {
        const { location, ...query } = request.input;
        return location === 'installed' ? client.inspect(query) : this.remote(request, signal);
      }
      case 'hub.install': case 'hub.update': {
        const command = { ...request.input, bundles: request.input.bundles.map(encoded => {
          const bytes = Buffer.from(encoded, 'base64');
          if (bytes.toString('base64') !== encoded) throw new HubError('HUB_PACKAGE_INVALID');
          return bytes;
        }) };
        return request.operation === 'hub.install' ? client.installFile(command) : client.updateFile(command);
      }
      case 'hub.uninstall': return client.uninstall(request.input);
      case 'hub.verify': return client.verify(request.input);
      case 'hub.export': return { encoding: 'base64', bundle: Buffer.from(await client.exportFile(request.input)).toString('base64') };
      case 'hub.refresh': return client.applyRevocations(request.input);
      case 'hub.cards': return client.revocationCards(request.input, undefined, this.ports.locale);
      default: return this.remote(request, signal);
    }
  }
  private async remote(request: HubRemoteOperation, signal: AbortSignal): Promise<unknown> {
    requireBoundedHubJson(request.input);
    request = parseHubOperation(JSON.parse(canonicalHubJson(request))) as HubRemoteOperation;
    const client = this.ports.client;
    const principal = await client.authorizeRemote(request.operation === 'hub.inspect' ? 'search' : request.operation.slice(4) as 'search' | 'publish' | 'yank' | 'revoke', request.input.scopeId);
    const known = this.ports.knownSecrets?.() ?? EMPTY_KNOWN_SECRETS;
    const secret = (text: string) => hasSecret(text, known) || REDACTION_GATE_PATTERNS.some(pattern => new RegExp(pattern.source, pattern.flags).test(text));
    // Every remote input leaves the scope, not only a publish bundle: the outbound gate sees the exact canonical input that is sent.
    if (secret(canonicalHubJson(request.input))) throw ErrorRegistry.createError('HUB_SECRET_REFUSED');
    if (request.operation === 'hub.publish') {
      const bundle = decodeHubBundle(Buffer.from(canonicalHubJson(request.input.input.bundle)));
      if (bundle.manifest.provenance.origin === 'lessons(derived)' && isAiPrincipal(principal)) throw new HubClientError('HUB_AUTHORITY_REFUSED');
      if (secret(canonicalHubJson(bundle.manifest)) || bundle.files.some(file => secret(Buffer.from(file.bytes).toString('utf8')))) throw ErrorRegistry.createError('HUB_SECRET_REFUSED');
    }
    if ((request.operation === 'hub.yank' || request.operation === 'hub.revoke') && request.input.input.authority === 'operator' && isAiPrincipal(principal))
      throw new HubClientError('HUB_AUTHORITY_REFUSED');
    if ((request.operation === 'hub.yank' || request.operation === 'hub.revoke') && request.input.commandId !== request.input.input.commandId)
      throw new HubClientError('HUB_INSTALL_CONFLICT');
    const source = (await client.listSources({ schemaVersion: 1, scopeId: request.input.scopeId })).find(row => row.hubId === request.input.hubId && row.state === 'active');
    if (!source) throw new HubClientError('HUB_SOURCE_NOT_FOUND');
    if (!this.ports.remote) throw ErrorRegistry.createError('HUB_CONNECTION_UNAVAILABLE');
    signal.throwIfAborted();
    return this.ports.remote(request, source, signal);
  }
}
