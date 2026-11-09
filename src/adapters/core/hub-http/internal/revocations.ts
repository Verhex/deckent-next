import { z } from 'zod';
import { HUB_LIMITS, hubExtensionId, hubRevocationFeedSchema } from '#domain/index.js';
import type { HubClientDependencies } from '#engine/index.js';
import type { Client } from '@modelcontextprotocol/client';
import { DeckentJsonSchemaValidator, INPUT_VALIDATION_LIMITS, inputWithinValidationLimit } from '#platform/index.js';
import { createGovernedHubFetch, type HubFetchDependencies } from './client.js';
import { HubNetworkError } from './listener.js';

/** Same first-use/effect/token/DNS boundary as package fetch; the SDK is loaded only for an admitted refresh. */
export function governedHubRevocationReader(deps: HubFetchDependencies, extensionId: string): NonNullable<HubClientDependencies['fetchRevocations']> {
  type Session = { endpoint: string; revision: number; client: Client; signal: AbortSignal; stop: () => void; ready: Promise<void> };
  const sessions = new WeakMap<AbortSignal, Session>();
  const close = async (current: Session | undefined) => {
    if (!current || sessions.get(current.signal) !== current) return;
    sessions.delete(current.signal);
    current.signal.removeEventListener('abort', current.stop);
    await current.client.close();
  };
  return async (source, afterSequence, signal, cursor) => {
    let current = sessions.get(signal);
    try {
      signal.throwIfAborted();
      if (source.scopeId !== deps.scopeId || source.hubId !== deps.hubId || !hubExtensionId(extensionId)) throw new HubNetworkError('HUB_NETWORK_INVALID');
      if (current && (current.endpoint !== source.endpoint || current.revision !== source.revision)) {
        await close(current); current = undefined;
      }
      if (!current) {
        const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
        signal.throwIfAborted();
        current = sessions.get(signal);
        if (!current) {
          const governed = createGovernedHubFetch(deps), client = new Client({ name: 'deckent-hub-revocations', version: '1' },
            { versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: { extensions: { [extensionId]: {} } }, jsonSchemaValidator: new DeckentJsonSchemaValidator() });
          const opened: Session = { endpoint: source.endpoint, revision: source.revision, client, signal, stop: () => { void close(opened).catch(() => undefined); }, ready: Promise.resolve() };
          current = opened; sessions.set(signal, opened);
          // The refresh signal stays owned between pages, including while the engine verifies and persists a page.
          signal.addEventListener('abort', opened.stop, { once: true });
          const transport = new StreamableHTTPClientTransport(new URL(source.endpoint), { fetch: (input, init) => {
            const request = new Request(input, init);
            return governed(new Request(request, { signal: AbortSignal.any([opened.signal, request.signal]) }));
          } });
          opened.ready = client.connect(transport, { signal, timeout: HUB_LIMITS.fetchTimeoutMs });
        }
      }
      await current.ready;
      const response = await current.client.request({ method: 'hub/revocations/get', params: { input: { afterSequence, ...(cursor ? { continuation: cursor } : {}) } } }, z.object({ value: z.unknown().optional() }),
        { signal, timeout: HUB_LIMITS.fetchTimeoutMs });
      signal.throwIfAborted();
      if (!inputWithinValidationLimit(response.value, INPUT_VALIDATION_LIMITS.revocations)) throw new HubNetworkError('HUB_NETWORK_INVALID');
      const feed = hubRevocationFeedSchema.parse(response.value);
      if (!feed.catchup || feed.catchup.complete) await close(current);
      return feed;
    } catch (error) { await close(current); throw error; }
  };
}
