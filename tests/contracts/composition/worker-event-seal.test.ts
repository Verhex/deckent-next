import { describe, expect, it } from 'vitest';
import { sealAttemptWorkerEvents } from '../../../src/composition/core/execution/index.js';
import { ErrorRegistry } from '#platform/index.js';

const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'l' };
const event = { schemaVersion: 1 as const, sequence: 1, atMs: 0, kind: 'message' as const, role: 'assistant' as const, textBytes: 1, thinking: false, excerpt: 'x' };
const receipt = { scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 };
const input = { events: [event], verification: null, unreported: 0, projectionComplete: true, maxBytes: 65536 };

describe('worker event log sealing after execution (EXEC-RELEASE C3)', () => {
  it('returns a typed failure instead of swallowing it; the execution outcome is never touched', async () => {
    const saved: unknown[] = []; const store = { async saveWorkerEventLog(record: never) { saved.push(record); return record; } };
    expect(await sealAttemptWorkerEvents(identity, { async put() { return receipt; } }, store, input)).toEqual({ status: 'sealed', eventCount: 1 });
    expect(saved).toHaveLength(1);
    expect(await sealAttemptWorkerEvents(identity, { async put() { return receipt; } }, store, { ...input, events: [] })).toEqual({ status: 'nothing-to-seal' });
    // Negative: the artifact write or the ledger record fails → typed, with the underlying code; nothing claims a sealed log.
    const full = { async put(): Promise<never> { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } };
    expect(await sealAttemptWorkerEvents(identity, full, store, input)).toEqual({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: 'ENOSPC' });
    const busy = { async saveWorkerEventLog(): Promise<never> { throw new Error('busy'); } };
    expect(await sealAttemptWorkerEvents(identity, { async put() { return receipt; } }, busy, input)).toEqual({ status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: null });
    expect(saved).toHaveLength(1);
    for (const locale of ['en', 'tr'] as const) expect(ErrorRegistry.createError('WORKER_EVENTS_SEAL_FAILED', { locale }).message).not.toContain('WORKER_EVENTS_SEAL_FAILED');
  });
});
