import { z } from 'zod';
import { identitySchema } from '#domain/index.js';

export const runtimeServiceOperationSchema = z.enum(['createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun',
  'inspectInventory', 'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations']);
export const runtimeServiceRequestSchema = z.object({ schemaVersion: z.literal(1), requestId: identitySchema,
  operation: runtimeServiceOperationSchema, input: z.unknown(),
}).strict().refine(value => Object.hasOwn(value, 'input'), { path: ['input'], message: 'RUNTIME_SERVICE_INPUT_REQUIRED' }).readonly();
const success = z.object({ schemaVersion: z.literal(1), requestId: identitySchema, ok: z.literal(true), result: z.unknown() })
  .strict().refine(value => Object.hasOwn(value, 'result'), { path: ['result'], message: 'RUNTIME_SERVICE_RESULT_REQUIRED' }).readonly();
const failure = z.object({ schemaVersion: z.literal(1), requestId: identitySchema, ok: z.literal(false),
  error: z.object({ code: identitySchema, category: z.enum(['error', 'usage', 'config']) }).strict().readonly(),
}).strict().readonly();
export const runtimeServiceResponseSchema = z.union([success, failure]).readonly();
export class RuntimeServiceProtocolError extends Error {
  constructor(readonly code: 'RUNTIME_SERVICE_CORRELATION') {
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
export type RuntimeServiceOperation = z.infer<typeof runtimeServiceOperationSchema>;
export type RuntimeServiceRequest = z.infer<typeof runtimeServiceRequestSchema>;
export type RuntimeServiceResponse = z.infer<typeof runtimeServiceResponseSchema>;
