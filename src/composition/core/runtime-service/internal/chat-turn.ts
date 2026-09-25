import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity, RuntimeServiceTurnChannel } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { cancelPeerConfiguredChatTurn, runPeerConfiguredChatTurn, type RuntimeChatTurnHost } from '#composition/core/agent-turn/index.js';

/** `chatTurn` needs the connection's turn channel; `cancelChatTurn` is a single-frame control operation. Peer identity is the socket's. */
export function executeConfiguredRuntimeChatTurnOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions, host: RuntimeChatTurnHost, turn?: RuntimeServiceTurnChannel) {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const delivery = { maxResultBytes: runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes) };
  if (request.operation === 'cancelChatTurn') return cancelPeerConfiguredChatTurn(projectRoot, request.input, peer, options, host);
  if (request.operation === 'chatTurn' && turn) return runPeerConfiguredChatTurn(projectRoot, request.input, peer, options, delivery, host, turn);
  throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
}
