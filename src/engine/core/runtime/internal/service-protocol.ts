import { z } from 'zod';
import { identitySchema, parseModelInvocationCancellationCommand, parseModelInvocationCommand, parseModelInvocationQuery,
  parseModelInvocationPurgeCommand, parseProviderSpendAccountQuery, parseProviderSpendAuditCommand } from '#domain/index.js';

export const RUNTIME_SERVICE_SCHEMA_VERSION = 10 as const;

export const runtimeServiceOperationSchema = z.enum(['renewApproval', 'listApprovals', 'inspectApproval', 'decideApproval', 'createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun',
  'inspectInventory', 'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations', 'describeService', 'shutdownService',
  'invokeModel', 'inspectModelInvocation', 'purgeModelInvocationContent', 'cancelModelInvocation', 'inspectProviderSpendAccount', 'auditProviderSpendAccount']);
export const runtimeServiceDescriptionInputSchema = z.object({}).strict().readonly();
export const runtimeServiceDeliverySchema = z.object({ maxResultBytes: z.number().int().positive().safe() }).strict().readonly();
const invocationOperation = (operation: RuntimeServiceOperation): boolean => operation === 'invokeModel' || operation === 'inspectModelInvocation'
  || operation === 'purgeModelInvocationContent' || operation === 'cancelModelInvocation';
const boundedResultOperation = (operation: RuntimeServiceOperation): boolean => invocationOperation(operation)
  || operation === 'renewApproval' || operation === 'listApprovals' || operation === 'inspectApproval' || operation === 'decideApproval'
  || operation === 'inspectProviderSpendAccount' || operation === 'auditProviderSpendAccount';
// Current local transport is same-OS-UID only. Requests never provide an actor; current peer policy supplies scope.
// Invocation results carry an advisory replay flag; it is not independent evidence of spend or permission to retry.
export const runtimeServiceRequestSchema = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema,
  operation: runtimeServiceOperationSchema, input: z.unknown(), delivery: runtimeServiceDeliverySchema.optional(),
}).strict().refine(value => Object.hasOwn(value, 'input'), { path: ['input'], message: 'RUNTIME_SERVICE_INPUT_REQUIRED' }).superRefine((value, context) => {
  if (boundedResultOperation(value.operation)) {
    if (!Object.hasOwn(value, 'delivery') || value.delivery === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['delivery'], message: 'RUNTIME_SERVICE_DELIVERY_REQUIRED' });
    }
    try {
      if (value.operation === 'inspectProviderSpendAccount') parseProviderSpendAccountQuery(value.input);
      else if (value.operation === 'auditProviderSpendAccount') parseProviderSpendAuditCommand(value.input);
      else if (value.operation === 'invokeModel') parseModelInvocationCommand(value.input);
      else if (value.operation === 'inspectModelInvocation') parseModelInvocationQuery(value.input);
      else if (value.operation === 'purgeModelInvocationContent') parseModelInvocationPurgeCommand(value.input);
      else if (value.operation === 'cancelModelInvocation') parseModelInvocationCancellationCommand(value.input);
      // Approval input is validated by its shared application before I/O, like the existing Run operations.
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ['input'], message: 'RUNTIME_SERVICE_INPUT_INVALID' }); }
  } else if (Object.hasOwn(value, 'delivery')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['delivery'], message: 'RUNTIME_SERVICE_DELIVERY_FORBIDDEN' });
  }
}).readonly();
const success = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema, ok: z.literal(true), result: z.unknown() })
  .strict().refine(value => Object.hasOwn(value, 'result'), { path: ['result'], message: 'RUNTIME_SERVICE_RESULT_REQUIRED' }).readonly();
const failure = z.object({ schemaVersion: z.literal(RUNTIME_SERVICE_SCHEMA_VERSION), requestId: identitySchema, ok: z.literal(false),
  error: z.object({ code: identitySchema, category: z.enum(['error', 'usage', 'config']) }).strict().readonly(),
}).strict().readonly();
export const runtimeServiceResponseSchema = z.union([success, failure]).readonly();
export class RuntimeServiceProtocolError extends Error {
  constructor(readonly code: 'RUNTIME_SERVICE_CORRELATION' | 'RUNTIME_SERVICE_RESPONSE_LIMIT' | 'RUNTIME_SERVICE_DELIVERY_INVALID') {
    super(code);
    this.name = 'RuntimeServiceProtocolError';
  }
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
  return operation === 'executeTask' || operation === 'invokeModel' ? 'execution' : 'control';
}
export type RuntimeServiceRequest = z.infer<typeof runtimeServiceRequestSchema>;
export type RuntimeServiceResponse = z.infer<typeof runtimeServiceResponseSchema>;
