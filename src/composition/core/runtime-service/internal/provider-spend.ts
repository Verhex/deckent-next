import { providerSpendAccountQueryInputSchema, type ProviderSpendAccountQuery } from '#domain/index.js';
import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { inspectPeerConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';

/** The socket-authenticated peer is the sole principal input; result delivery remains caller and service bounded. */
export async function executeConfiguredRuntimeProviderSpendOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  if (request.operation !== 'inspectProviderSpendAccount' || !request.delivery) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  }
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  const result = await inspectPeerConfiguredProviderSpendAccount(projectRoot,
    providerSpendAccountQueryInputSchema.parse(request.input) as ProviderSpendAccountQuery, peer, options);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  }
  return result;
}
