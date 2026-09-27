import { runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { attachPeerWorkspaceFile, findPeerWorkspaceFiles, type RuntimeWorkspaceFileHost } from '#composition/core/agent-turn/index.js';

/** v15 composer `@file` operations: bounded single-frame answers; the peer identity is the socket's. */
export function executeConfiguredRuntimeWorkspaceFileOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions, host: RuntimeWorkspaceFileHost, signal: AbortSignal) {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const delivery = { maxResultBytes: runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes) };
  if (request.operation === 'findWorkspaceFiles') return findPeerWorkspaceFiles(projectRoot, request.input, peer, options, delivery, host);
  if (request.operation === 'attachWorkspaceFile') return attachPeerWorkspaceFile(projectRoot, request.input, peer, options, delivery, signal);
  throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
}
