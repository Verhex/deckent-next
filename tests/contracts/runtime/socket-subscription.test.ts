import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalRuntimeSocketServer, subscribeLocalRuntime, requestLocalRuntime, type LocalRuntimeSocketOptions } from '#adapters/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, type RuntimeEventsItem } from '#engine/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<LocalRuntimeSocketOptions> {
  const root = await mkdtemp(join(tmpdir(), 'dk-events-socket-')); roots.push(root); const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
  return { endpoint: join(parent, 'runtime.sock'), maxConnections: 8, inputMaxBytes: 4096, responseMaxBytes: 4096,
    acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 1000, responseTimeoutMs: 1000 };
}
const query = { schemaVersion: 1, scopeId: 'scope', topics: ['run'], resume: null };
const request = { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'observe', operation: 'subscribeEvents' as const, input: query, delivery: { maxResultBytes: 2048 } };
const serviceEpoch = randomUUID(), viewId = randomUUID(), snapshotId = randomUUID(), resume = { serviceEpoch, viewId, sequence: 0 };
const ready: RuntimeEventsItem = { type: 'ready', scopeId: 'scope', topics: ['run'], serviceEpoch, viewId, mode: 'observation-order' };
/** Host-only verification: this sandbox does not admit native peer/socket execution. Keep the command in WORKER-PHASE2. */
describe.skipIf(process.platform !== 'linux')('runtime observation transport (lead host)', () => {
  it('delivers ordered correlated frames with complete capture, reasoned close, final response and EOF', async () => {
    const options = await fixture(); const sent: RuntimeEventsItem[] = [ready, { type: 'snapshot.begin', snapshotId }, { type: 'snapshot.end', snapshotId, resume },
      { type: 'close', reason: 'service-shutdown', resume }];
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, stream, turn, subscription) => {
      expect(stream).toBeUndefined(); expect(turn).toBeUndefined();
      for (const item of sent) await subscription!.send(item, 1000);
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: { closed: true } };
    });
    try {
      const received: RuntimeEventsItem[] = [];
      const final = await subscribeLocalRuntime(options, request, item => { received.push(item); }, 2000);
      expect(received).toEqual(sent); expect(final).toMatchObject({ ok: true, result: { closed: true } });
    } finally { await server.dispose(); }
  });
  it('cancelled observation leaves independent work and a control request usable', async () => {
    const options = await fixture(); let closed!: () => void; const gone = new Promise<void>(resolve => { closed = resolve; }); let runRevision = 1;
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, _stream, _turn, subscription) => {
      if (request.operation === 'subscribeEvents') {
        await subscription!.send(ready, 1000);
        await new Promise<void>(resolve => { subscription!.signal.addEventListener('abort', () => { closed(); resolve(); }, { once: true }); });
      }
      return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result: { runRevision } };
    });
    try {
      const controller = new AbortController(); let sawReady!: () => void; const seen = new Promise<void>(resolve => { sawReady = resolve; });
      const pending = subscribeLocalRuntime(options, request, () => { sawReady(); }, 2000, controller.signal); const rejected = expect(pending).rejects.toHaveProperty('code');
      await seen; runRevision++; controller.abort(); await rejected; await gone;
      expect(runRevision).toBe(2);
      expect(await requestLocalRuntime(options, { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'control', operation: 'describeService', input: {} })).toMatchObject({ ok: true, result: { runRevision: 2 } });
    } finally { await server.dispose(); }
  });
});
