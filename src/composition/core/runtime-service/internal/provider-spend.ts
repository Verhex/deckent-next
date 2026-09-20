import { providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema,
  type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import { ProviderSpendError, runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import { DeckentError, type ConfigLoadOptions } from '#platform/index.js';
import { auditPeerConfiguredProviderSpendAccount, inspectPeerConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';

/** The socket-authenticated peer is the sole principal input; result delivery remains caller and service bounded. */
export async function executeConfiguredRuntimeProviderSpendOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  if ((request.operation !== 'inspectProviderSpendAccount' && request.operation !== 'auditProviderSpendAccount') || !request.delivery) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  }
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  let result;
  if (request.operation === 'auditProviderSpendAccount') {
    try {
      result = await auditPeerConfiguredProviderSpendAccount(projectRoot,
        providerSpendAuditCommandInputSchema.parse(request.input) as ProviderSpendAuditCommand, peer, capacity, options);
    } catch (error) {
      if ((error instanceof ProviderSpendError || error instanceof DeckentError)
        && error.code === 'PROVIDER_SPEND_RESULT_LIMIT') {
        throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
      }
      throw error;
    }
  } else {
    result = await inspectPeerConfiguredProviderSpendAccount(projectRoot,
      providerSpendAccountQueryInputSchema.parse(request.input) as ProviderSpendAccountQuery, peer, options);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  }
  return result;
}
