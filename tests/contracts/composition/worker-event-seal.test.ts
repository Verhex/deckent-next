import { describe, expect, it, vi } from 'vitest';
import { closeAndSealAttemptWorkerEvents, sealAttemptWorkerEvents } from '#adapters/index.js';
import { workerEventSchema, type WorkerEvent } from '#domain/index.js';
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
    expect(ErrorRegistry.createError('WORKER_EVENTS_SEAL_FAILED', { locale: 'en' }).message).toBe('The worker event log could not be sealed; the live event file stays in the attempt directory and its custody is held until it is sealed. The execution result is unchanged.');
    expect(ErrorRegistry.createError('WORKER_EVENTS_SEAL_FAILED', { locale: 'tr' }).message).toBe('İşçi olay günlüğü mühürlenemedi; canlı olay dosyası deneme dizininde kalır ve mühürlenene kadar sorumluluk tutulur. Yürütme sonucu değişmedi.');
    // N0 close owner: a required observation is sealed only when the stored bytes read back equal and the ledger row is written; the deadline fences
    // every stage before that write and never the write itself (performance.now is moved forward inside a stage instead of waiting).
    const failed = { status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: null }, stored: Uint8Array[] = [];
    const observation = workerEventSchema.parse({ schemaVersion: 1, sequence: 2, atMs: 1, kind: 'cli.observation',
      observation: { schemaVersion: 1, cliVersion: '1.0.0', builtinPlugins: { names: [], omitted: 2 }, paidExtraUsage: null } }) as Extract<WorkerEvent, { kind: 'cli.observation' }>;
    const sink = (projectionComplete: boolean) => ({ close: vi.fn<(remainingMs?: number) => Promise<{ events: (typeof event)[]; projectionComplete: boolean }>>(async () => ({ events: [event], projectionComplete })) });
    const files = { async put(_scope: string, bytes: Uint8Array) { stored.push(bytes); return receipt; }, async read() { return stored.at(-1)!; } };
    const later = () => vi.spyOn(performance, 'now').mockReturnValue(Number.MAX_VALUE), base = { maxBytes: 65536, deadlineMs: 60_000 };
    const plain = sink(true); saved.length = 0;
    expect(await closeAndSealAttemptWorkerEvents(identity, files, store, plain, base)).toEqual({ status: 'sealed', eventCount: 1 });
    expect(plain.close).toHaveBeenCalledWith(); saved.length = 0; stored.length = 0;
    expect(await closeAndSealAttemptWorkerEvents(identity, files, store, sink(true), { ...base, offered: true })).toEqual(failed); expect(stored).toEqual([]);
    expect(await closeAndSealAttemptWorkerEvents(identity, { ...files, async read() { return Buffer.from('other'); } }, store, sink(true), { ...base, offered: true, held: () => observation })).toEqual(failed);
    expect(await closeAndSealAttemptWorkerEvents(identity, { put: () => new Promise<never>(() => {}) }, store, sink(true), { ...base, offered: true, held: () => observation, deadlineMs: 1 })).toEqual(failed);
    expect(await closeAndSealAttemptWorkerEvents(identity, { ...files, async put(scope: string, bytes: Uint8Array) { later(); return files.put(scope, bytes); } },
      store, sink(true), { ...base, offered: true, held: () => observation })).toEqual(failed);
    vi.restoreAllMocks(); expect(saved).toEqual([]);
    const slow = { async saveWorkerEventLog(record: never) { later(); saved.push(record); return record; } }, partial = sink(false);
    expect(await closeAndSealAttemptWorkerEvents(identity, files, slow, partial, { ...base, offered: true, held: () => observation })).toEqual({ status: 'sealed', eventCount: 2 });
    vi.restoreAllMocks(); expect(partial.close).toHaveBeenCalledWith(60_000); expect(saved).toEqual([expect.objectContaining({ projection: 'partial' })]);
    expect(Buffer.from(stored.at(-1)!).toString().trim().split('\n').map(line => JSON.parse(line) as unknown).at(-1)).toEqual({ ...observation, sequence: 2 });
    // R3: with NO offered observation a rejecting sink close or a throwing source rejects exactly as at HEAD; with one offered the same faults,
    // a throwing held() (after the sink drained) and a synchronously throwing read-back map to the existing failure with `cause: null`.
    const verdict = { status: 'unverified' as const, admitted: null, observed: [], unexpected: [] }, source = { modelVerification: () => verdict, statistics: () => ({ eventsUnreported: 0 }) };
    const rejecting = { close: async () => { throw Object.assign(new Error('close'), { code: 'EIO' }); } }, throwing = { ...source, statistics: () => { throw new Error('statistics'); } };
    saved.length = 0;
    await expect(closeAndSealAttemptWorkerEvents(identity, files, store, rejecting, base)).rejects.toThrow('close');
    await expect(closeAndSealAttemptWorkerEvents(identity, files, store, sink(true), { ...base, source: throwing })).rejects.toThrow('statistics');
    expect(await closeAndSealAttemptWorkerEvents(identity, files, store, rejecting, { ...base, offered: true, held: () => observation })).toEqual(failed);
    expect(await closeAndSealAttemptWorkerEvents(identity, files, store, sink(true), { ...base, offered: true, source: throwing, held: () => observation })).toEqual(failed);
    const drained = sink(true);
    expect(await closeAndSealAttemptWorkerEvents(identity, files, store, drained, { ...base, offered: true, held: () => { throw new Error('held'); } })).toEqual(failed);
    expect(drained.close).toHaveBeenCalledWith(60_000);
    expect(await closeAndSealAttemptWorkerEvents(identity, { ...files, read(): never { throw Object.assign(new Error('corrupt'), { code: 'ARTIFACT_CORRUPT' }); } },
      store, sink(true), { ...base, offered: true, held: () => observation })).toEqual(failed);
    expect(saved).toEqual([]); expect(await closeAndSealAttemptWorkerEvents(identity, files, store, null, { ...base, source })).toEqual({ status: 'sealed', eventCount: 1 });
    expect(saved).toEqual([expect.objectContaining({ projection: 'partial' })]);
  });
});
