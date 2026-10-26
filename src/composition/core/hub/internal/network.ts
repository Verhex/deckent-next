import type { HubServerApplication } from '#engine/index.js';
import { HubNetworkError, startHubHttpListener, type HubListenerOptions } from '#adapters/index.js';
import { loadHubHttpSurface, type HubHttpAuth, type HubMcpOptions } from '#surfaces/index.js';
export { createGovernedHubFetch, type HubFetchDependencies, type HubFirstUseReceipt } from '#adapters/index.js';

/** Called only by the separate hub process. H7/H9 load protected config/TLS files and bind the real IdP and H3 authority ports. */
export async function startHubService(app: HubServerApplication, listener: Omit<HubListenerOptions, 'fetch'>, auth: HubHttpAuth, options: HubMcpOptions) {
  if (!listener.enabled) return null;
  if (listener.endpoint !== auth.endpoint) throw new HubNetworkError('HUB_NETWORK_INVALID');
  const { createHubHttpHandler } = await loadHubHttpSurface();
  const handler = createHubHttpHandler(app, auth, options);
  try {
    const server = await startHubHttpListener({ ...listener, fetch: handler.fetch });
    return { address: server!.address, close: async () => { try { await server!.close(); } finally { await handler.close(); } } };
  } catch (error) { await handler.close(); throw error; }
}
