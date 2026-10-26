import { z } from 'zod';
import { HUB_LIMITS, canonicalHubJson, requireBoundedHubJson } from '#domain/index.js';
import { DeckentJsonSchemaValidator } from '#platform/index.js';
import { type HubOperationPorts } from '#engine/index.js';
import { createGovernedHubFetch, type HubFetchDependencies } from './client.js';
import { HubNetworkError } from './listener.js';

/** H7 bridge to H3/H5 over H4. Extension identity is registry input; connecting still requires the exact durable first-use person decision. */
export function governedHubOperations(deps: HubFetchDependencies, extensionId: string): NonNullable<HubOperationPorts['remote']> {
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(extensionId) || extensionId === 'io.modelcontextprotocol/skills') throw new HubNetworkError('HUB_NETWORK_INVALID');
  return async (request, source, signal) => {
    signal.throwIfAborted();
    if (source.scopeId !== deps.scopeId || source.hubId !== deps.hubId || request.input.scopeId !== deps.scopeId || request.input.hubId !== deps.hubId)
      throw new HubNetworkError('HUB_NETWORK_INVALID');
    requireBoundedHubJson(request);
    const snapshot = JSON.parse(canonicalHubJson(request.input)) as typeof request.input;
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]), fetch = createGovernedHubFetch(deps);
    const client = new Client({ name: 'deckent-hub', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { extensions: { [extensionId]: {} } }, jsonSchemaValidator: new DeckentJsonSchemaValidator() });
    let endpoint: URL;
    try { endpoint = new URL(source.endpoint); } catch { throw new HubNetworkError('HUB_NETWORK_INVALID'); }
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: (input, init) => {
      const request = new Request(input, init); return fetch(new Request(request, { signal: AbortSignal.any([bounded, request.signal]) }));
    } });
    try {
      await client.connect(transport, { signal: bounded, timeout: HUB_LIMITS.fetchTimeoutMs });
      if (request.operation === 'hub.search') {
        return (await client.request({ method: 'hub/packages/list', params: { after: request.input.after, limit: request.input.limit } }, z.object({ value: z.unknown() }),
          { signal: bounded, timeout: HUB_LIMITS.fetchTimeoutMs })).value;
      }
      if (request.operation === 'hub.inspect') {
        return (await client.request({ method: 'hub/packages/get', params: { packageId: request.input.packageId, version: request.input.version } }, z.object({ value: z.unknown() }),
          { signal: bounded, timeout: HUB_LIMITS.fetchTimeoutMs })).value;
      }
      const toolInput = 'input' in snapshot ? snapshot.input : {};
      const args = request.operation === 'hub.publish' ? toolInput : { input: toolInput };
      const result = await client.callTool({ name: request.operation.replace('.', '_'), arguments: args }, { signal: bounded, timeout: HUB_LIMITS.fetchTimeoutMs });
      if (result.isError) throw new HubNetworkError('HUB_NETWORK_FAILED');
      return result.structuredContent ?? result.content;
    } finally { await client.close(); }
  };
}
