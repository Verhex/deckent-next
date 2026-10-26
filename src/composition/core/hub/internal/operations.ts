import { userInfo } from 'node:os';
import { HubApplication, HubPolicyAuthorization, HubClientError, assertAuthorityWitness, hubOperationWrites, hubPersonOnlyOperation, parseHubOperation,
  type AuthorityWitness, type HubOperation, type HubOperationPorts, type HubClientDependencies } from '#engine/index.js';
import { HubError } from '#domain/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, HubNetworkError } from '#adapters/index.js';
import { ErrorRegistry, resolveLocale, getConfigKnownSecrets, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredHubClient } from './application.js';

/** H9 may bind its first-use/trust/governed network ports here. No caller wire field can supply these trusted services. */
export interface ConfiguredHubPorts {
  readonly witness?: AuthorityWitness;
  readonly resolveTrust?: HubClientDependencies['resolveTrust'];
  readonly remote?: HubOperationPorts['remote'];
}
/** SDK/CLI/terminal/MCP use exactly this scope, policy and witness boundary. No reads create an identity, key, ledger or source. */
export async function executeConfiguredHub(root: string, input: HubOperation, options: ConfigLoadOptions = {}, ports: ConfiguredHubPorts = {}, signal?: AbortSignal): Promise<unknown> {
  try {
    const request = parseHubOperation(input), channel = localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined);
    if (hubPersonOnlyOperation(request.operation) || hubOperationWrites(request.operation) && channel !== 'mcp')
      await assertAuthorityWitness(request.operation, channel, ports.witness ?? { attest: () => attestLocalInteractiveTerminal() });
    const context = await loadConfiguredScopeContext(root, request.input.scopeId, { ...options, heal: false }, hubOperationWrites(request.operation) ? 'write' : 'read');
    const policy = createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes);
    const authority = new HubPolicyAuthorization(policy);
    const client = configuredHubClient(context, { authorize: authority.authorize.bind(authority), ...(ports.resolveTrust ? { resolveTrust: ports.resolveTrust } : {}) });
    return await new HubApplication({ client, knownSecrets: () => getConfigKnownSecrets(context.config), locale: resolveLocale(undefined, options.env, context.config.language), ...(ports.remote ? { remote: ports.remote } : {}) }).execute(request, signal);
  } catch (error) {
    if (error instanceof HubError || error instanceof HubClientError || error instanceof HubNetworkError) throw ErrorRegistry.createError(error.code);
    throw queryFailure(error);
  }
}
