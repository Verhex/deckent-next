import { providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema, providerSpendManagementCommandInputSchema,
  type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import { ProviderSpendError, runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import { DeckentError, type ConfigLoadOptions } from '#platform/index.js';
import { managePeerConfiguredProviderSpend, auditPeerConfiguredProviderSpendAccount, inspectPeerConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';

/** The socket-authenticated peer is the sole principal input; result delivery remains caller and service bounded. */
export async function executeConfiguredRuntimeProviderSpendOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  if ((request.operation !== 'inspectProviderSpendAccount' && request.operation !== 'auditProviderSpendAccount' && request.operation !== 'manageProviderSpend') || !request.delivery) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  }
  const capacity = runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes);
  // A result over the delivery bound is the protocol's response limit, never a partial money result.
  const limited = (error: unknown): never => {
    if ((error instanceof ProviderSpendError || error instanceof DeckentError) && error.code === 'PROVIDER_SPEND_RESULT_LIMIT') throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
    throw error;
  };
  const result = request.operation === 'manageProviderSpend'
    ? await managePeerConfiguredProviderSpend(projectRoot, providerSpendManagementCommandInputSchema.parse(request.input), peer, options, capacity).catch(limited)
    : request.operation === 'auditProviderSpendAccount'
      ? await auditPeerConfiguredProviderSpendAccount(projectRoot, providerSpendAuditCommandInputSchema.parse(request.input) as ProviderSpendAuditCommand, peer, capacity, options).catch(limited)
      : await inspectPeerConfiguredProviderSpendAccount(projectRoot, providerSpendAccountQueryInputSchema.parse(request.input) as ProviderSpendAccountQuery, peer, options);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  return result;
}
