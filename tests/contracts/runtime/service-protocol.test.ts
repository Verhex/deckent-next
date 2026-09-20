import { describe, expect, it } from 'vitest';
import { RuntimeServiceProtocolError, classifyRuntimeServiceOperation, parseRuntimeServiceResponse, runtimeServiceOperationSchema,
  runtimeServiceRequestSchema, runtimeServiceResponseSchema, runtimeServiceResultCapacity } from '../../../src/engine/core/runtime/index.js';

const operations = ['createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun', 'inspectInventory',
  'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations', 'describeService', 'shutdownService',
  'invokeModel', 'inspectModelInvocation'] as const;
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const binding = { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) };
const invocation = {
  schemaVersion: 1, commandId: 'command-1', scopeId: 'scope-1', reference, catalogRevision: 'catalog-1', expectedBinding: binding,
  nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: 'bounded' }] },
};
const inspection = { schemaVersion: 2, scopeId: 'scope-1', invocationId: 'invocation-1', reference };
function expectProtocolError(call: () => void, code: RuntimeServiceProtocolError['code']): void {
  try { call(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}`);
}

describe('runtime service protocol', () => {
  it('accepts exactly the current v3 operation allowlist', () => {
    for (const operation of operations) expect(runtimeServiceOperationSchema.parse(operation)).toBe(operation);
    expect(() => runtimeServiceOperationSchema.parse('shutdown')).toThrow();
    expect(classifyRuntimeServiceOperation('invokeModel')).toBe('execution');
    expect(classifyRuntimeServiceOperation('inspectModelInvocation')).toBe('control');
  });

  it('requires input to be present and rejects old or extra request fields', () => {
    const request = { schemaVersion: 4, requestId: 'request-1', operation: 'inspectRun', input: null };
    expect(runtimeServiceRequestSchema.parse(request)).toEqual(request);
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 2 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 3 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, input: undefined })).not.toThrow();
    const withoutInput = { schemaVersion: 4, requestId: 'request-1', operation: 'inspectRun' };
    expect(() => runtimeServiceRequestSchema.parse(withoutInput)).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, requestId: '' })).toThrow();
  });

  it('requires bounded delivery only for model invocation operations and validates descriptor-safe inputs', () => {
    const invoke = { schemaVersion: 4, requestId: 'request-1', operation: 'invokeModel', input: invocation,
      delivery: { maxResultBytes: 1 } };
    expect(runtimeServiceRequestSchema.parse(invoke)).toEqual(invoke);
    expect(runtimeServiceRequestSchema.parse({ schemaVersion: 4, requestId: 'request-2', operation: 'inspectModelInvocation',
      input: inspection, delivery: { maxResultBytes: 2 } })).toMatchObject({ operation: 'inspectModelInvocation' });
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: 0 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: 1.5 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, input: { ...invocation, nativeRequest: [] } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ schemaVersion: 4, requestId: 'request-3', operation: 'inspectRun',
      input: {}, delivery: { maxResultBytes: 1 } })).toThrow();
  });

  it('derives an exact v3 success-envelope result capacity and rejects impossible or invalid limits', () => {
    const requestId = 'request-1', responseMaxBytes = 512;
    const capacity = runtimeServiceResultCapacity(requestId, responseMaxBytes);
    const exact = { schemaVersion: 4, requestId, ok: true, result: 'x'.repeat(capacity - 2) };
    const overflow = { schemaVersion: 4, requestId, ok: true, result: 'x'.repeat(capacity - 1) };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(responseMaxBytes);
    expect(Buffer.byteLength(JSON.stringify(overflow), 'utf8')).toBe(responseMaxBytes + 1);
    expect(runtimeServiceResultCapacity(requestId, responseMaxBytes, capacity + 1)).toBe(capacity);
    expect(runtimeServiceResultCapacity(requestId, responseMaxBytes, 1)).toBe(1);
    expectProtocolError(() => runtimeServiceResultCapacity(requestId, 1), 'RUNTIME_SERVICE_RESPONSE_LIMIT');
    expectProtocolError(() => runtimeServiceResultCapacity(requestId, responseMaxBytes, 0), 'RUNTIME_SERVICE_DELIVERY_INVALID');
    expectProtocolError(() => runtimeServiceResultCapacity('', responseMaxBytes), 'RUNTIME_SERVICE_DELIVERY_INVALID');
  });

  it('requires success results and keeps failures closed and message-free', () => {
    const success = { schemaVersion: 4, requestId: 'request-1', ok: true, result: null };
    expect(runtimeServiceResponseSchema.parse(success)).toEqual(success);
    const withoutResult = { schemaVersion: 4, requestId: 'request-1', ok: true };
    expect(() => runtimeServiceResponseSchema.parse(withoutResult)).toThrow();
    const failure = { schemaVersion: 4, requestId: 'request-1', ok: false,
      error: { code: 'RUN_NOT_FOUND', category: 'error' } };
    expect(runtimeServiceResponseSchema.parse(failure)).toEqual(failure);
    expect(() => runtimeServiceResponseSchema.parse({ ...failure,
      error: { ...failure.error, message: 'private detail' } })).toThrow();
  });

  it('validates response correlation after validating the response envelope', () => {
    const response = { schemaVersion: 4, requestId: 'request-1', ok: true, result: {} };
    expect(parseRuntimeServiceResponse('request-1', response)).toEqual(response);
    expect(() => parseRuntimeServiceResponse('request-2', response)).toThrowError(RuntimeServiceProtocolError);
    expect(() => parseRuntimeServiceResponse('request-1', { ...response, result: undefined, extra: true })).toThrow();
  });
});
