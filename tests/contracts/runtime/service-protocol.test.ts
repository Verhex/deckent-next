import { describe, expect, it } from 'vitest';
import { RuntimeServiceProtocolError, classifyRuntimeServiceOperation, isRuntimeServiceStreamingOperation, parseRuntimeServiceResponse, runtimeServiceOperationSchema,
  runtimeServiceRequestSchema, runtimeServiceResponseSchema, runtimeServiceResultCapacity, runtimeServiceStreamFrameSchema, runtimeServiceEventFrameSchema,
  isRuntimeServiceTurnOperation } from '../../../src/engine/core/runtime/index.js';

const operations = ['renewApproval', 'listApprovals', 'inspectApproval', 'decideApproval', 'createRun', 'reserveRunTasks', 'executeTask', 'evaluateTask', 'inspectRun', 'inspectInventory',
  'requestRunCancellation', 'deliverRunCancellation', 'reconcileAttempt', 'recoverCancellations', 'describeService', 'shutdownService',
  'invokeModel', 'inspectModelInvocation', 'purgeModelInvocationContent', 'cancelModelInvocation', 'inspectProviderSpendAccount', 'auditProviderSpendAccount',
  'invokeModelStream', 'chatTurn', 'cancelChatTurn'] as const;
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const binding = { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) };
const invocation = {
  schemaVersion: 1, commandId: 'command-1', scopeId: 'scope-1', reference, catalogRevision: 'catalog-1', expectedBinding: binding,
  nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: 'bounded' }] },
};
const inspection = { schemaVersion: 2, scopeId: 'scope-1', invocationId: 'invocation-1', reference };
const cancellation = { schemaVersion: 1, commandId: 'cancel-1', scopeId: 'scope-1', targetCommandId: 'command-1', reference,
  expectedRequestDigest: 'a'.repeat(64) };
const spendAudit = { schemaVersion: 1, commandId: 'audit-1', scopeId: 'scope-1', budgetId: 'budget-1', budgetRevision: 1,
  expectedCheckpointDigest: 'b'.repeat(64) };
function expectProtocolError(call: () => void, code: RuntimeServiceProtocolError['code']): void {
  try { call(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ${code}`);
}

describe('runtime service protocol', () => {
  it('accepts exactly the current v13 operation allowlist', () => {
    for (const operation of operations) expect(runtimeServiceOperationSchema.parse(operation)).toBe(operation);
    expect(() => runtimeServiceOperationSchema.parse('shutdown')).toThrow();
    expect(classifyRuntimeServiceOperation('invokeModel')).toBe('execution');
    expect(classifyRuntimeServiceOperation('invokeModelStream')).toBe('execution');
    expect(operations.filter(isRuntimeServiceStreamingOperation)).toEqual(['invokeModelStream']);
    expect(operations.filter(isRuntimeServiceTurnOperation)).toEqual(['chatTurn']);
    expect(classifyRuntimeServiceOperation('chatTurn')).toBe('execution');
    expect(classifyRuntimeServiceOperation('cancelChatTurn')).toBe('control');
    expect(classifyRuntimeServiceOperation('inspectModelInvocation')).toBe('control');
    expect(classifyRuntimeServiceOperation('purgeModelInvocationContent')).toBe('control');
    expect(classifyRuntimeServiceOperation('cancelModelInvocation')).toBe('control');
    expect(classifyRuntimeServiceOperation('inspectProviderSpendAccount')).toBe('control');
    expect(classifyRuntimeServiceOperation('auditProviderSpendAccount')).toBe('control');
    expect(runtimeServiceOperationSchema.options).toEqual(operations);
  });

  it('streams an invocation with bounded delivery and strict ordered delta frames', () => {
    const stream = { schemaVersion: 13, requestId: 'request-1', operation: 'invokeModelStream', input: invocation, delivery: { maxResultBytes: 1 } };
    expect(runtimeServiceRequestSchema.parse(stream)).toEqual(stream);
    expect(() => runtimeServiceRequestSchema.parse({ ...stream, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...stream, input: { ...invocation, extra: true } })).toThrow();
    const frame = { schemaVersion: 13, requestId: 'request-1', kind: 'delta', sequence: 0, deltas: [{ kind: 'reasoning', text: 'a' }, { kind: 'text', text: 'b' }] };
    expect(runtimeServiceStreamFrameSchema.parse(frame)).toEqual(frame);
    for (const invalid of [{ ...frame, deltas: [] }, { ...frame, deltas: [{ kind: 'text', text: '' }] }, { ...frame, deltas: [{ kind: 'tool', text: 'x' }] },
      { ...frame, sequence: -1 }, { ...frame, extra: 1 }, { ...frame, schemaVersion: 12 },
      { ...frame, deltas: Array.from({ length: 257 }, () => ({ kind: 'text', text: 'x' })) }]) {
      expect(runtimeServiceStreamFrameSchema.safeParse(invalid).success).toBe(false);
    }
    // A delta frame is never a response.
    expect(runtimeServiceResponseSchema.safeParse(frame).success).toBe(false);
  });

  it('admits a chat turn only with bounded delivery and a history that ends with the user, and carries its events in strict event frames', () => {
    const turn = { schemaVersion: 13, requestId: 'request-1', operation: 'chatTurn', delivery: { maxResultBytes: 4096 },
      input: { schemaVersion: 1, scopeId: 'scope-1', turnId: 'turn-1', messages: [{ role: 'user', content: 'what does a.ts export?' }] } };
    expect(runtimeServiceRequestSchema.parse(turn)).toEqual(turn);
    for (const input of [{ ...turn.input, messages: [] }, { ...turn.input, messages: [{ role: 'assistant', content: 'x', toolCalls: [] }] },
      { ...turn.input, principal: 'someone' }, { ...turn.input, turnId: ' padded' }, { ...turn.input, tools: [] }]) {
      expect(runtimeServiceRequestSchema.safeParse({ ...turn, input }).success).toBe(false);
    }
    expect(runtimeServiceRequestSchema.safeParse({ ...turn, delivery: undefined }).success).toBe(false);
    const cancel = { schemaVersion: 13, requestId: 'request-2', operation: 'cancelChatTurn', delivery: { maxResultBytes: 256 },
      input: { schemaVersion: 1, scopeId: 'scope-1', turnId: 'turn-1' } };
    expect(runtimeServiceRequestSchema.parse(cancel)).toEqual(cancel);
    expect(runtimeServiceRequestSchema.safeParse({ ...cancel, input: { ...cancel.input, principal: 'someone' } }).success).toBe(false);
    const frame = { schemaVersion: 13, requestId: 'request-1', kind: 'event', sequence: 0, events: [
      { kind: 'tool.started', callId: 'c1', name: 'read_file', target: 'src/a.ts' },
      { kind: 'tool.finished', callId: 'c1', name: 'read_file', status: 'ok', ms: 3, bytes: 10 },
      { kind: 'message', message: { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'export const a = 1;' } },
      { kind: 'text', text: 'It exports a.' }] };
    expect(runtimeServiceEventFrameSchema.parse(frame)).toEqual(frame);
    // `done` is the response, never an event; a delta frame is not an event frame and neither is a response.
    for (const invalid of [{ ...frame, events: [{ kind: 'done', finish: 'stop', note: null }] }, { ...frame, events: [] }, { ...frame, kind: 'delta' },
      { ...frame, events: [{ kind: 'tool.finished', callId: 'c1', name: 'read_file', status: 'maybe', ms: 1, bytes: 1 }] }, { ...frame, schemaVersion: 12 }]) {
      expect(runtimeServiceEventFrameSchema.safeParse(invalid).success).toBe(false);
    }
    expect(runtimeServiceStreamFrameSchema.safeParse(frame).success).toBe(false);
    expect(runtimeServiceResponseSchema.safeParse(frame).success).toBe(false);
  });

  it('requires input to be present and rejects old or extra request fields', () => {
    const request = { schemaVersion: 13, requestId: 'request-1', operation: 'inspectRun', input: null };
    expect(runtimeServiceRequestSchema.parse(request)).toEqual(request);
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 2 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 4 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 5 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 6 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 7 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 8 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 9 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, schemaVersion: 12 })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, input: undefined })).not.toThrow();
    const withoutInput = { schemaVersion: 13, requestId: 'request-1', operation: 'inspectRun' };
    expect(() => runtimeServiceRequestSchema.parse(withoutInput)).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...request, requestId: '' })).toThrow();
  });

  it('requires bounded delivery only for model invocation operations and validates descriptor-safe inputs', () => {
    const invoke = { schemaVersion: 13, requestId: 'request-1', operation: 'invokeModel', input: invocation,
      delivery: { maxResultBytes: 1 } };
    expect(runtimeServiceRequestSchema.parse(invoke)).toEqual(invoke);
    expect(runtimeServiceRequestSchema.parse({ schemaVersion: 13, requestId: 'request-2', operation: 'inspectModelInvocation',
      input: inspection, delivery: { maxResultBytes: 2 } })).toMatchObject({ operation: 'inspectModelInvocation' });
    const purge = { ...invoke, operation: 'purgeModelInvocationContent', input: { schemaVersion: 1,
      commandId: 'purge', scopeId: 'scope-1', invocationId: 'invocation-1', reference, expectedContentDigest: 'a'.repeat(64) } };
    expect(runtimeServiceRequestSchema.parse(purge)).toEqual(purge);
    const cancel = { ...invoke, operation: 'cancelModelInvocation', input: cancellation };
    expect(runtimeServiceRequestSchema.parse(cancel)).toEqual(cancel);
    const account = { ...invoke, operation: 'inspectProviderSpendAccount', input: {
      schemaVersion: 1, scopeId: 'scope-1', budgetId: 'budget-1', budgetRevision: 1 } };
    expect(runtimeServiceRequestSchema.parse(account)).toEqual(account);
    expect(() => runtimeServiceRequestSchema.parse({ ...account, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...account, input: { ...account.input, actor: 'forged' } })).toThrow();
    const audit = { ...invoke, operation: 'auditProviderSpendAccount', input: spendAudit };
    expect(runtimeServiceRequestSchema.parse(audit)).toEqual(audit);
    expect(() => runtimeServiceRequestSchema.parse({ ...audit, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...audit, input: { ...spendAudit, principal: 'forged' } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...purge, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...purge, input: { ...purge.input, actor: 'forged' } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: undefined })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: 0 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: 1.5 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, delivery: { maxResultBytes: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ ...invoke, input: { ...invocation, nativeRequest: [] } })).toThrow();
    expect(() => runtimeServiceRequestSchema.parse({ schemaVersion: 13, requestId: 'request-3', operation: 'inspectRun',
      input: {}, delivery: { maxResultBytes: 1 } })).toThrow();
  });

  it('derives an exact v11 success-envelope result capacity and rejects impossible or invalid limits', () => {
    const requestId = 'request-1', responseMaxBytes = 512;
    const capacity = runtimeServiceResultCapacity(requestId, responseMaxBytes);
    const exact = { schemaVersion: 13, requestId, ok: true, result: 'x'.repeat(capacity - 2) };
    const overflow = { schemaVersion: 13, requestId, ok: true, result: 'x'.repeat(capacity - 1) };
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(responseMaxBytes);
    expect(Buffer.byteLength(JSON.stringify(overflow), 'utf8')).toBe(responseMaxBytes + 1);
    expect(runtimeServiceResultCapacity(requestId, responseMaxBytes, capacity + 1)).toBe(capacity);
    expect(runtimeServiceResultCapacity(requestId, responseMaxBytes, 1)).toBe(1);
    expectProtocolError(() => runtimeServiceResultCapacity(requestId, 1), 'RUNTIME_SERVICE_RESPONSE_LIMIT');
    expectProtocolError(() => runtimeServiceResultCapacity(requestId, responseMaxBytes, 0), 'RUNTIME_SERVICE_DELIVERY_INVALID');
    expectProtocolError(() => runtimeServiceResultCapacity('', responseMaxBytes), 'RUNTIME_SERVICE_DELIVERY_INVALID');
  });

  it('requires success results and keeps failures closed and message-free', () => {
    const success = { schemaVersion: 13, requestId: 'request-1', ok: true, result: null };
    expect(runtimeServiceResponseSchema.parse(success)).toEqual(success);
    const withoutResult = { schemaVersion: 13, requestId: 'request-1', ok: true };
    expect(() => runtimeServiceResponseSchema.parse(withoutResult)).toThrow();
    const failure = { schemaVersion: 13, requestId: 'request-1', ok: false,
      error: { code: 'RUN_NOT_FOUND', category: 'error' } };
    expect(runtimeServiceResponseSchema.parse(failure)).toEqual(failure);
    expect(() => runtimeServiceResponseSchema.parse({ ...failure,
      error: { ...failure.error, message: 'private detail' } })).toThrow();
  });

  it('validates response correlation after validating the response envelope', () => {
    const response = { schemaVersion: 13, requestId: 'request-1', ok: true, result: {} };
    expect(parseRuntimeServiceResponse('request-1', response)).toEqual(response);
    expect(() => parseRuntimeServiceResponse('request-2', response)).toThrowError(RuntimeServiceProtocolError);
    expect(() => parseRuntimeServiceResponse('request-1', { ...response, result: undefined, extra: true })).toThrow();
  });
});
