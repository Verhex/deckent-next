import { executeRuntimeProviderSpendOperation, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { managePeerConfiguredProviderSpend, auditPeerConfiguredProviderSpendAccount, inspectPeerConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
/** The socket-authenticated peer is the sole principal input; result delivery remains caller and service bounded. */
export async function executeConfiguredRuntimeProviderSpendOperation(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions) {
  return executeRuntimeProviderSpendOperation(request, responseMaxBytes, {
    manage: (input, capacity) => managePeerConfiguredProviderSpend(projectRoot, input, peer, options, capacity),
    audit: (input, capacity) => auditPeerConfiguredProviderSpendAccount(projectRoot, input, peer, capacity, options),
    inspect: input => inspectPeerConfiguredProviderSpendAccount(projectRoot, input, peer, options),
  });
}
