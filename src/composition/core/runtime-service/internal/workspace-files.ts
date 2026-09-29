import { isRuntimeServiceScratchOperation, runtimeServiceResultCapacity, RuntimeServiceProtocolError, type RuntimeServiceRequest } from '#engine/index.js';
import type { LocalPeerIdentity, RuntimeWorkspaceFileHost } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { attachPeerWorkspaceFile, executePeerScratchOperation, findPeerWorkspaceFiles } from '#composition/core/agent-turn/index.js';

/** v15 composer `@file` and v16 `/scratch` operations: bounded single-frame answers; the peer identity is the socket's. */
export function executeConfiguredRuntimeWorkspaceFileOperation(projectRoot: string, request: RuntimeServiceRequest, peer: LocalPeerIdentity,
  responseMaxBytes: number, options: ConfigLoadOptions, host: RuntimeWorkspaceFileHost, signal: AbortSignal) {
  if (!request.delivery) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  const delivery = { maxResultBytes: runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes) };
  if (request.operation === 'findWorkspaceFiles') return findPeerWorkspaceFiles(projectRoot, request.input, peer, options, delivery, host);
  if (request.operation === 'attachWorkspaceFile') return attachPeerWorkspaceFile(projectRoot, request.input, peer, options, delivery, signal);
  if (isRuntimeServiceScratchOperation(request.operation)) return executePeerScratchOperation(projectRoot, request.operation, request.input, peer, options, delivery);
  throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
}
