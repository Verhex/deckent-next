import { z } from 'zod';
import { HUB_LIMITS, hubRevocationFeedSchema } from '#domain/index.js';
import type { HubClientDependencies } from '#engine/index.js';
import { createGovernedHubFetch, type HubFetchDependencies } from './client.js';
import { HubNetworkError } from './listener.js';

/** Same first-use/effect/token/DNS boundary as package fetch; the SDK is loaded only for an admitted refresh. */
export function governedHubRevocationReader(deps: HubFetchDependencies, extensionId: string): NonNullable<HubClientDependencies['fetchRevocations']> {
  return async (source, afterSequence, signal, cursor) => {
    signal.throwIfAborted();
    if (source.scopeId !== deps.scopeId || source.hubId !== deps.hubId || !/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(extensionId)) throw new HubNetworkError('HUB_NETWORK_INVALID');
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const governed = createGovernedHubFetch(deps), client = new Client({ name: 'deckent-hub-revocations', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { extensions: { [extensionId]: {} } } });
    const transport = new StreamableHTTPClientTransport(new URL(source.endpoint), { fetch: (input, init) => {
      const request = new Request(input, init);
      return governed(new Request(request, { signal: AbortSignal.any([signal, request.signal]) }));
    } });
    try {
      await client.connect(transport, { signal, timeout: HUB_LIMITS.fetchTimeoutMs });
      const response = await client.request({ method: 'hub/revocations/get', params: { input: { afterSequence, ...(cursor ? { continuation: cursor } : {}) } } }, z.object({ value: hubRevocationFeedSchema }),
        { signal, timeout: HUB_LIMITS.fetchTimeoutMs });
      return response.value;
    } finally { await client.close(); }
  };
}
