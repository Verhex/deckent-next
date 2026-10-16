import type { LocalPeerIdentity } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { executeRuntimeApprovalOperation, RuntimeServiceProtocolError, runtimeServiceResultCapacity, type RuntimeServiceRequest,
  clearSessionStandingSchema, sessionStandingClearanceSchema, SessionStanding, type SessionApprovalAnswers, type TurnDecisionCapabilities } from '#engine/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';

/** Runtime approval operations, answered in the request's protocol shape (C12 G1/G2: a released client never receives a record it cannot parse). */
export async function executeRuntimeApproval(projectRoot: string, request: RuntimeServiceRequest,
  peer: LocalPeerIdentity, responseMaxBytes: number, options: ConfigLoadOptions, decisions?: TurnDecisionCapabilities, answers?: SessionApprovalAnswers) {
  if (request.operation === 'clearSessionStanding') {
    if (!request.delivery || !answers) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
    const input = clearSessionStandingSchema.parse(request.input);
    const context = await loadPeerInvocationContext(projectRoot, input.scopeId, options, peer, 'write');
    const result = sessionStandingClearanceSchema.parse({ ...input, cleared: true });
    if (Buffer.byteLength(JSON.stringify(result)) > runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery.maxResultBytes)) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
    answers.clear(SessionStanding.sessionKey(input.scopeId, context.principal, input.sessionId));
    return result;
  }
  return executeRuntimeApprovalOperation(request, responseMaxBytes, (action, input, capacity, view) =>
    configuredApproval(projectRoot, action, input, options, peer, capacity, view, decisions, answers));
}
