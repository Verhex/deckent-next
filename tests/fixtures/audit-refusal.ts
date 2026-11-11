import type { AuditEvent } from '#domain/index.js';
export const refusalCall = { turnId: 'turn', round: 1, index: 0, callId: 'call' };
export const refusalSubject: Extract<AuditEvent['subject'], { kind: 'access-refusal-summary' }> = { kind: 'access-refusal-summary', schemaVersion: 1, operationClass: 'read',
      operation: { id: 'erp:invoice.read', version: 3 }, tool: { name: 'read_file', version: 1 }, decisionSource: 'adapter-reported',
      reasonCode: 'ERP:ACCESS_DENIED', evidenceBasis: 'adapter:structured-v3', target: { role: 'outside-workspace', identity: null },
      firstObservedAtMs: 10, lastObservedAtMs: 20, count: 2, countBasis: 'at-least', samples: [refusalCall], overflow: true,
      turnId: 'turn', runId: 'run', taskId: 'task', attemptId: 'attempt', generation: 2, invocationId: 'invocation', commandId: 'command', call: refusalCall };
