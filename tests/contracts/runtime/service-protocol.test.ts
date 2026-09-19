import { describe, expect, it } from 'vitest';
import { RuntimeServiceProtocolError, parseRuntimeServiceResponse, runtimeServiceOperationSchema,
  runtimeServiceRequestSchema, runtimeServiceResponseSchema } from '../../../src/engine/core/runtime/index.js';

const operations = ['createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun', 'inspectInventory',
  'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations', 'describeService', 'shutdownService'] as const;

describe('runtime service protocol', () => {
  it('accepts exactly the current v2 operation allowlist', () => {
    for (const operation of operations) expect(runtimeServiceOperationSchema.parse(operation)).toBe(operation);
    expect(() => runtimeServiceOperationSchema.parse('shutdown')).toThrow();
  });

  it('requires input to be present and rejects extra request fields', () => {
    const request = { schemaVersion: 2, requestId: 'request-1', operation: 'inspectRun', input: null };
    expect(runtimeServiceRequestSchema.parse(request)).toEqual(request);
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 1 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, input: undefined })).not.toThrow();
    const withoutInput = { schemaVersion: 2, requestId: 'request-1', operation: 'inspectRun' };
    expect(() => runtimeServiceRequestSchema.parse(withoutInput)).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, requestId: '' })).toThrow();
  });

  it('requires success results and keeps failures closed and message-free', () => {
    const success = { schemaVersion: 2, requestId: 'request-1', ok: true, result: null };
    expect(runtimeServiceResponseSchema.parse(success)).toEqual(success);
    const withoutResult = { schemaVersion: 2, requestId: 'request-1', ok: true };
    expect(() => runtimeServiceResponseSchema.parse(withoutResult)).toThrow();
    const failure = { schemaVersion: 2, requestId: 'request-1', ok: false,
      error: { code: 'RUN_NOT_FOUND', category: 'error' } };
    expect(runtimeServiceResponseSchema.parse(failure)).toEqual(failure);
    expect(() => runtimeServiceResponseSchema.parse({ ...failure,
      error: { ...failure.error, message: 'private detail' } })).toThrow();
  });

  it('validates response correlation after validating the response envelope', () => {
    const response = { schemaVersion: 2, requestId: 'request-1', ok: true, result: {} };
    expect(parseRuntimeServiceResponse('request-1', response)).toEqual(response);
    expect(() => parseRuntimeServiceResponse('request-2', response)).toThrowError(RuntimeServiceProtocolError);
    expect(() => parseRuntimeServiceResponse('request-1', { ...response, result: undefined, extra: true })).toThrow();
  });
});
