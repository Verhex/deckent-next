import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkerEventSink } from '#adapters/index.js';
import type { WorkerEvent } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-event-sink-')); roots.push(root); return root; }
const event = (sequence: number): WorkerEvent => ({ schemaVersion: 1, sequence, atMs: sequence, kind: 'unmapped', nativeType: 'x', count: 1 });
const lines = (batch: readonly WorkerEvent[], receivedAt: number) => batch.map(item => JSON.stringify({ receivedAt, event: item }) + '\n').join('');

/** A real 0600 append handle whose writes are cut to `limit(call)` bytes and whose close can be made to reject: a controlled disk fault. */
function faulty(limit: (call: number) => number, closeFails = false) {
  return async (path: string, flags: number, mode: number) => {
    const real = await open(path, flags, mode); let calls = 0;
    return {
      write: (bytes: Buffer, offset: number, length: number) => real.write(bytes, offset, Math.min(length, limit(++calls))),
      close: async () => { await real.close(); if (closeFails) throw new Error('EIO on close'); },
    };
  };
}

describe.skipIf(process.platform !== 'linux')('live worker.events projection truth (Astra 2054 R4)', () => {
  it('continues a short write from the written offset so the projection holds every byte and stays complete', async () => {
    const root = await fixture();
    const sink = await openWorkerEventSink(root, faulty(call => call === 1 ? 7 : Number.MAX_SAFE_INTEGER));
    const batch = [event(1), event(2)];
    sink.accept(batch, 1_000);
    const closed = await sink.close();
    expect(closed).toMatchObject({ events: batch, projectionComplete: true });
    expect(await readFile(join(root, 'worker.events'), 'utf8')).toBe(lines(batch, 1_000));
  });

  it('marks the projection partial when writes stay short past the bounded attempts, stops projecting and still returns every received event', async () => {
    const root = await fixture();
    const sink = await openWorkerEventSink(root, faulty(() => 1));
    const first = [event(1)], second = [event(2)];
    // Neither accept nor close throws: observation loss never becomes an execution failure.
    expect(() => { sink.accept(first, 1_000); sink.accept(second, 2_000); }).not.toThrow();
    const closed = await sink.close();
    expect(closed).toMatchObject({ events: [...first, ...second], projectionComplete: false });
    const written = await readFile(join(root, 'worker.events'), 'utf8');
    expect(written.length).toBeLessThan(lines(first, 1_000).length);
    expect(lines(first, 1_000).startsWith(written)).toBe(true);
  });

  it('marks the projection partial when a zero-byte write makes no progress', async () => {
    const sink = await openWorkerEventSink(await fixture(), faulty(() => 0));
    sink.accept([event(1)], 1_000);
    expect(await sink.close()).toMatchObject({ projectionComplete: false });
  });

  it('marks the projection partial when close rejects after every write landed, without rejecting close', async () => {
    const root = await fixture();
    const sink = await openWorkerEventSink(root, faulty(() => Number.MAX_SAFE_INTEGER, true));
    sink.accept([event(1)], 1_000);
    await expect(sink.close()).resolves.toMatchObject({ events: [event(1)], projectionComplete: false });
    expect(await readFile(join(root, 'worker.events'), 'utf8')).toBe(lines([event(1)], 1_000));
  });

  it('marks the projection partial when a write rejects and keeps the sealed event list whole', async () => {
    const sink = await openWorkerEventSink(await fixture(), async () => ({ write: () => Promise.reject(new Error('ENOSPC')), close: () => Promise.resolve() }));
    sink.accept([event(1)], 1_000); sink.accept([event(2)], 2_000);
    await expect(sink.close()).resolves.toMatchObject({ events: [event(1), event(2)], projectionComplete: false });
  });

  it('keeps the default file projection complete with owner-only mode', async () => {
    const root = await fixture();
    const sink = await openWorkerEventSink(root);
    sink.accept([event(1)], 1_000); sink.accept([event(2)], 2_000);
    expect(await sink.close()).toMatchObject({ projectionComplete: true });
    expect(await readFile(join(root, 'worker.events'), 'utf8')).toBe(lines([event(1)], 1_000) + lines([event(2)], 2_000));
    const handle = await open(join(root, 'worker.events')); const mode = (await handle.stat()).mode & 0o777; await handle.close();
    expect(mode).toBe(0o600);
  });
});
