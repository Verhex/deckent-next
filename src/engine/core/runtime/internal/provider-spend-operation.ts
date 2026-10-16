import { providerSpendAccountQueryInputSchema, providerSpendAuditCommandInputSchema, providerSpendManagementCommandInputSchema,
  type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from './service-protocol.js';
import { ProviderSpendError } from '#engine/core/provider-spend/index.js';
import { DeckentError } from '#platform/index.js';
/** Protocol dispatch and result bounds without access to a transport or configured identity. */
export async function executeRuntimeProviderSpendOperation(request: RuntimeServiceRequest, responseMaxBytes: number, operations: {
  manage(input: ReturnType<typeof providerSpendManagementCommandInputSchema.parse>, capacity: number): Promise<unknown>;
  audit(input: ProviderSpendAuditCommand, capacity: number): Promise<unknown>;
  inspect(input: ProviderSpendAccountQuery): Promise<unknown>;
}) {
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
    ? await operations.manage(providerSpendManagementCommandInputSchema.parse(request.input), capacity).catch(limited)
    : request.operation === 'auditProviderSpendAccount'
      ? await operations.audit(providerSpendAuditCommandInputSchema.parse(request.input) as ProviderSpendAuditCommand, capacity).catch(limited)
      : await operations.inspect(providerSpendAccountQueryInputSchema.parse(request.input) as ProviderSpendAccountQuery);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > capacity) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  return result;
}
