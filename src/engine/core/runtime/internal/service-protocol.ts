import { z } from 'zod';
import { agentTurnStreamEventSchema, effectCommandSchema, effectRecordSchema, effectTargetRefSchema, identitySchema, modelInvocationDeltaSchema, operationRefSchema, parseChatTurnCancellation, parseChatTurnCommand, parseModelInvocationCancellationCommand, parseModelInvocationCommand, parseModelInvocationQuery,
  parseModelInvocationPurgeCommand, parsePermissionModeCommand, parsePermissionModeQuery, parseProviderSpendAccountQuery, parseProviderSpendAuditCommand, parseScratchQuery,
  parseWorkspaceAttachmentRequest, parseWorkspaceFileQuery } from '#domain/index.js';
import { clearSessionStandingSchema } from '#engine/core/approval/index.js';
import { secretDeleteCommandSchema, secretSetCommandSchema } from '#engine/core/secret-store/index.js';

export const RUNTIME_SERVICE_SCHEMA_VERSION = 20 as const;
export const RUNTIME_SERVICE_ERROR_PARAMS = 8;
export const RUNTIME_SERVICE_ERROR_PARAM_CHARS = 512;
/** Bounded, serializable message parameters for a typed error response (strings truncated, other values dropped). */
export function runtimeServiceErrorParams(params: Readonly<Record<string, unknown>> | undefined): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const entries = Object.entries(params).filter((entry): entry is [string, string | number] => typeof entry[1] === 'string'
    || (typeof entry[1] === 'number' && Number.isFinite(entry[1]))).slice(0, RUNTIME_SERVICE_ERROR_PARAMS)
    .map(([key, value]) => [key.slice(0, 64), typeof value === 'string' ? value.slice(0, RUNTIME_SERVICE_ERROR_PARAM_CHARS) : value] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const runtimeServiceOperationSchema = z.enum(['renewApproval', 'listApprovals', 'inspectApproval', 'decideApproval', 'createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun',
  'inspectInventory', 'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations', 'describeService', 'shutdownService',
  'invokeModel', 'inspectModelInvocation', 'purgeModelInvocationContent', 'cancelModelInvocation', 'inspectProviderSpendAccount', 'auditProviderSpendAccount',
  'invokeModelStream', 'chatTurn', 'cancelChatTurn', 'findWorkspaceFiles', 'attachWorkspaceFile', 'executeOperation', 'compensateOperation', 'inspectOperation',
  'inspectPermissionMode', 'setPermissionMode', 'inspectScratch', 'clearScratch', 'clearSessionStanding', 'setSecret', 'deleteSecret']);
export const runtimeServiceDescriptionInputSchema = z.object({}).strict().readonly();
export const runtimeServiceDeliverySchema = z.object({ maxResultBytes: z.number().int().positive().safe() }).strict().readonly();
const invocationOperation = (operation: RuntimeServiceOperation): boolean => operation === 'invokeModel' || operation === 'invokeModelStream' || operation === 'inspectModelInvocation'
  || operation === 'purgeModelInvocationContent' || operation === 'cancelModelInvocation';
/** Operations whose request carries a `delivery` result bound (the server requires it; the client always sends one). */
export const isRuntimeServiceBoundedResultOperation = (operation: RuntimeServiceOperation): boolean => invocationOperation(operation)
  || operation === 'renewApproval' || operation === 'listApprovals' || operation === 'inspectApproval' || operation === 'decideApproval'
  || operation === 'inspectProviderSpendAccount' || operation === 'auditProviderSpendAccount' || operation === 'chatTurn' || operation === 'cancelChatTurn'
  || isRuntimeServiceWorkspaceFileOperation(operation) || isRuntimeServiceEffectOperation(operation) || isRuntimeServicePermissionModeOperation(operation)
  || operation === 'clearSessionStanding' || isRuntimeServiceScratchOperation(operation) || isRuntimeServiceSecretOperation(operation);
/** v15 (T-L5 `@file`): candidate files and one file's bounded content for the composer, through the service's scoped read port. */
export function isRuntimeServiceWorkspaceFileOperation(operation: RuntimeServiceOperation): operation is 'findWorkspaceFiles' | 'attachWorkspaceFile' {
  return operation === 'findWorkspaceFiles' || operation === 'attachWorkspaceFile';
}
/** v15 (C12 G4): catalog operations on the service. Command input is the effect command (no actor field: the socket peer is the principal);
 * results are bounded (an inspected record carries the command input). Current version only, like every non-lifecycle operation. */
export function isRuntimeServiceEffectOperation(operation: RuntimeServiceOperation): operation is 'executeOperation' | 'compensateOperation' | 'inspectOperation' {
  return operation === 'executeOperation' || operation === 'compensateOperation' || operation === 'inspectOperation';
}
/** v15 (T-L4 slice 4c): the caller's own terminal permission mode — read, and set conditionally on the revision read. No actor field:
 * the socket peer is the principal; single bounded answers; current version only. v17 (MODES-3): the modes are `standart | full-auto |
 * full-access`, the view carries `askEdits` and `fullAccess`, the command an optional `askEdits`; `chatTurn` gains `fullAccess?: true`. */
export function isRuntimeServicePermissionModeOperation(operation: RuntimeServiceOperation): operation is 'inspectPermissionMode' | 'setPermissionMode' {
  return operation === 'inspectPermissionMode' || operation === 'setPermissionMode';
}
/** v16 (SCR-A `/scratch`): the caller's own scratch area of one conversation — its path and files, or emptied. No actor field: the
 * socket peer is the owner; single bounded answers; current version only (a v15 client can neither send nor read them). */
export function isRuntimeServiceScratchOperation(operation: RuntimeServiceOperation): operation is 'inspectScratch' | 'clearScratch' {
  return operation === 'inspectScratch' || operation === 'clearScratch';
}
/** v20 (S02): conditional session approval answers and own-conversation clear. Stored approval/receipt/ledger formats stay unchanged. */
/** v19 (B1 APPROVAL-ASSURANCE; v18 was pushed): `decideApproval` takes the declared `channel` and the turn's one-time `decisionCapability`, and a
 * turn's `approval.requested` carries that capability (only on the stream of the connection that started the turn) with the card's risk and
 * required assurance. A v18 client is outside the window: its decision is closed unanswered, never silently recorded as peer-session. */
/** v18 (SECRET-WRITE; v17 was already pushed, so the operations start a new version): a change of one stored secret of the installation's store. No actor field: the
 * socket peer is the principal; the `secret`/`set|delete` policy cell decides; single bounded answers; current version only. */
export function isRuntimeServiceSecretOperation(operation: RuntimeServiceOperation): operation is 'setSecret' | 'deleteSecret' {
  return operation === 'setSecret' || operation === 'deleteSecret';
}
export const runtimeOperationQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema }).strict().readonly();
export type RuntimeOperationQuery = z.infer<typeof runtimeOperationQuerySchema>;
/** Wire shapes of the effect outcomes (settled v1 unchanged; approval-pending v2) and of an inspection; the client validates and correlates. */
const operationOutcomeBase = { commandId: identitySchema, scopeId: identitySchema, operation: operationRefSchema, target: effectTargetRefSchema };
export const runtimeOperationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ schemaVersion: z.literal(1), status: z.literal('settled'), ...operationOutcomeBase, sequence: z.number().int().positive().safe(),
    version: z.string().min(1).max(256).nullable(), compensates: identitySchema.nullable(), evidence: z.enum(['idempotency-record', 'fence']) }).strict(),
  z.object({ schemaVersion: z.literal(2), status: z.literal('approval-pending'), ...operationOutcomeBase, approval: z.object({ approvalId: identitySchema,
    revision: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(), summary: z.string().min(1).max(2048) }).strict() }).strict(),
]).readonly();
export const runtimeOperationInspectionSchema = z.object({ schemaVersion: z.literal(1), record: effectRecordSchema.nullable() }).strict().readonly();
// Current local transport is same-OS-UID only. Requests never provide an actor; current peer policy supplies scope.
// Invocation results carry an advisory replay flag; it is not independent evidence of spend or permission to retry.
export const runtimeServiceRequestSchema = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema,
  operation: runtimeServiceOperationSchema, input: z.unknown(), delivery: runtimeServiceDeliverySchema.optional(),
}).strict().refine(value => Object.hasOwn(value, 'input'), { path: ['input'], message: 'RUNTIME_SERVICE_INPUT_REQUIRED' }).superRefine((value, context) => {
  if (isRuntimeServiceBoundedResultOperation(value.operation)) {
    if (!Object.hasOwn(value, 'delivery') || value.delivery === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['delivery'], message: 'RUNTIME_SERVICE_DELIVERY_REQUIRED' });
    }
    try {
      if (value.operation === 'clearSessionStanding') clearSessionStandingSchema.parse(value.input);
      else if (value.operation === 'inspectProviderSpendAccount') parseProviderSpendAccountQuery(value.input);
      else if (value.operation === 'auditProviderSpendAccount') parseProviderSpendAuditCommand(value.input);
      else if (value.operation === 'invokeModel' || value.operation === 'invokeModelStream') parseModelInvocationCommand(value.input);
      else if (value.operation === 'inspectModelInvocation') parseModelInvocationQuery(value.input);
      else if (value.operation === 'purgeModelInvocationContent') parseModelInvocationPurgeCommand(value.input);
      else if (value.operation === 'cancelModelInvocation') parseModelInvocationCancellationCommand(value.input);
      else if (value.operation === 'chatTurn') parseChatTurnCommand(value.input);
      else if (value.operation === 'cancelChatTurn') parseChatTurnCancellation(value.input);
      else if (value.operation === 'findWorkspaceFiles') parseWorkspaceFileQuery(value.input);
      else if (value.operation === 'attachWorkspaceFile') parseWorkspaceAttachmentRequest(value.input);
      else if (value.operation === 'executeOperation' || value.operation === 'compensateOperation') effectCommandSchema.parse(value.input);
      else if (value.operation === 'inspectOperation') runtimeOperationQuerySchema.parse(value.input);
      else if (value.operation === 'inspectPermissionMode') parsePermissionModeQuery(value.input);
      else if (value.operation === 'setPermissionMode') parsePermissionModeCommand(value.input);
      else if (value.operation === 'inspectScratch' || value.operation === 'clearScratch') parseScratchQuery(value.input);
      else if (value.operation === 'setSecret') secretSetCommandSchema.parse(value.input);
      else if (value.operation === 'deleteSecret') secretDeleteCommandSchema.parse(value.input);
      // Approval input is validated by its shared application before I/O, like the existing Run operations.
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ['input'], message: 'RUNTIME_SERVICE_INPUT_INVALID' }); }
  } else if (Object.hasOwn(value, 'delivery')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['delivery'], message: 'RUNTIME_SERVICE_DELIVERY_FORBIDDEN' });
  }
}).readonly();
const success = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema, ok: z.literal(true), result: z.unknown() })
  .strict().refine(value => Object.hasOwn(value, 'result'), { path: ['result'], message: 'RUNTIME_SERVICE_RESULT_REQUIRED' }).readonly();
const failure = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema, ok: z.literal(false),
  error: z.object({ code: identitySchema, category: z.enum(['error', 'usage', 'config']),
    /** Message parameters of the typed error (same text the caller would see locally); bounded, never raw causes. */
    params: z.record(z.string().max(64), z.union([z.string().max(RUNTIME_SERVICE_ERROR_PARAM_CHARS), z.number().finite()]))
      .refine(value => Object.keys(value).length <= RUNTIME_SERVICE_ERROR_PARAMS).optional() }).strict().readonly(),
}).strict().readonly();
export const runtimeServiceResponseSchema = z.union([success, failure]).readonly();
/** Largest number of deltas one stream frame carries; the producer coalesces and splits within it. */
export const RUNTIME_SERVICE_STREAM_FRAME_DELTAS = 256;
/**
 * v11 streamed operations (`invokeModelStream`) answer with zero or more ordered delta frames, then exactly one
 * ordinary response frame carrying the same result as the non-streamed operation. Delta frames are presentation data;
 * a replayed command sends none. Every other operation keeps exactly one response frame.
 */
export const runtimeServiceStreamFrameSchema = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema,
  kind: z.literal('delta'), sequence: z.number().int().nonnegative().safe(),
  deltas: z.array(modelInvocationDeltaSchema).min(1).max(RUNTIME_SERVICE_STREAM_FRAME_DELTAS) }).strict().readonly();
export type RuntimeServiceStreamFrame = z.infer<typeof runtimeServiceStreamFrameSchema>;
export function isRuntimeServiceStreamingOperation(operation: RuntimeServiceOperation): boolean { return operation === 'invokeModelStream'; }
/** Largest number of turn events one event frame carries. */
export const RUNTIME_SERVICE_EVENT_FRAME_EVENTS = 256;
/**
 * `chatTurn` (v12; v13 adds `context` and `compacted`; v14 adds `approval.requested`, `approval.settled` and `tool.output`; v15
 * adds `tool.finished`'s optional `cleanup`, host shell calls only, added within v15 without a further version bump — CLEANUP-MARK)
 * answers with zero or more ordered event frames, then exactly one response frame carrying the turn result. Unlike
 * delta frames, event frames carry required data (the turn's `message` events are the client's history): each frame is bounded,
 * the stream as a whole is not (a turn has no budget), and the producer waits for the peer to drain instead of dropping. A peer
 * that disconnects before the response cancels the turn. A replayed turn sends at most its stored answer as a text event.
 */
export const runtimeServiceEventFrameSchema = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema,
  kind: z.literal('event'), sequence: z.number().int().nonnegative().safe(),
  events: z.array(agentTurnStreamEventSchema).min(1).max(RUNTIME_SERVICE_EVENT_FRAME_EVENTS) }).strict().readonly();
export type RuntimeServiceEventFrame = z.infer<typeof runtimeServiceEventFrameSchema>;
export function isRuntimeServiceTurnOperation(operation: RuntimeServiceOperation): boolean { return operation === 'chatTurn'; }
export class RuntimeServiceProtocolError extends Error {
  constructor(readonly code: 'RUNTIME_SERVICE_CORRELATION' | 'RUNTIME_SERVICE_RESPONSE_LIMIT' | 'RUNTIME_SERVICE_DELIVERY_INVALID') {
    super(code);
    this.name = 'RuntimeServiceProtocolError';
  }
}
/**
 * Lifecycle compatibility window (Jev 898c8af3): `describeService` and `shutdownService` stay reachable across protocol
 * bumps so an upgraded terminal can see (build skew) and stop (governed shutdown) a service started from an older build.
 * The server accepts them in these versions and answers in the request's version; every other operation is current-only.
 * A mismatched non-lifecycle envelope is closed unanswered (the client's typed `LOCAL_RUNTIME_TRANSPORT`); a v18 client's describe of a v17
 * service retries at v17 and the terminal shows the build skew. v18 (SECRET-WRITE) kept [18, 17]; v20 (S02) keeps [20, 19]: a v18 service is outside.
 */
export const RUNTIME_SERVICE_LIFECYCLE_VERSIONS = Object.freeze([RUNTIME_SERVICE_SCHEMA_VERSION, 19] as const);
export type RuntimeServiceLifecycleVersion = typeof RUNTIME_SERVICE_LIFECYCLE_VERSIONS[number];
const lifecycleVersionSchema = z.union([z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), z.literal(19)]);
export const runtimeServiceLifecycleRequestSchema = z.object({ schemaVersion: lifecycleVersionSchema, requestId: identitySchema,
  operation: z.enum(['describeService', 'shutdownService']), input: z.unknown() }).strict()
  .refine(value => Object.hasOwn(value, 'input'), { path: ['input'], message: 'RUNTIME_SERVICE_INPUT_REQUIRED' }).readonly();
export type RuntimeServiceLifecycleRequest = z.infer<typeof runtimeServiceLifecycleRequestSchema>;
/** Parses a lifecycle answer from a service speaking `version`; the envelope is otherwise identical across the window. */
export function parseRuntimeServiceLifecycleResponse(requestId: string, version: RuntimeServiceLifecycleVersion, value: unknown): RuntimeServiceResponse {
  const envelope = z.object({ schemaVersion: z.literal(version) }).passthrough().parse(value);
  return parseRuntimeServiceResponse(requestId, { ...envelope, schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION });
}
export function parseRuntimeServiceResponse(requestId: string, value: unknown): RuntimeServiceResponse {
  const expected = identitySchema.parse(requestId);
  const response = runtimeServiceResponseSchema.parse(value);
  if (response.requestId !== expected) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
  return response;
}
/** Maximum serialized result bytes that still fit the current success envelope and an optional caller cap. */
export function runtimeServiceResultCapacity(requestId: string, responseMaxBytes: number, requestedMaxResultBytes?: number): number {
  let id: string;
  try { id = identitySchema.parse(requestId); }
  catch { throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID'); }
  if (!Number.isSafeInteger(responseMaxBytes) || responseMaxBytes <= 0) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  }
  if (requestedMaxResultBytes !== undefined && (!Number.isSafeInteger(requestedMaxResultBytes) || requestedMaxResultBytes <= 0)) {
    throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_DELIVERY_INVALID');
  }
  const nullBytes = BigInt(Buffer.byteLength('null', 'utf8'));
  const envelopeBytes = BigInt(Buffer.byteLength(JSON.stringify({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: id, ok: true, result: null }), 'utf8'));
  const wireCapacity = BigInt(responseMaxBytes) - envelopeBytes + nullBytes;
  if (wireCapacity <= 0n) throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_RESPONSE_LIMIT');
  const capacity = requestedMaxResultBytes === undefined ? wireCapacity : wireCapacity < BigInt(requestedMaxResultBytes)
    ? wireCapacity : BigInt(requestedMaxResultBytes);
  return Number(capacity);
}
export type RuntimeServiceOperation = z.infer<typeof runtimeServiceOperationSchema>;
export type RuntimeServiceDelivery = z.infer<typeof runtimeServiceDeliverySchema>;
export function classifyRuntimeServiceOperation(operation: RuntimeServiceOperation): 'execution' | 'control' {
  return operation === 'executeTask' || operation === 'invokeModel' || operation === 'invokeModelStream' || operation === 'chatTurn' ? 'execution' : 'control';
}
export type RuntimeServiceRequest = z.infer<typeof runtimeServiceRequestSchema>;
export type RuntimeServiceResponse = z.infer<typeof runtimeServiceResponseSchema>;
