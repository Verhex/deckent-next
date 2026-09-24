import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerEvent } from '#domain/index.js';
import { observationDirectory } from './files.js';

/** Live, append-only projection of validated worker events next to the attempt's other sidecars (`worker.events`, NDJSON, 0600).
 * Each line is `{receivedAt, event}`: the host clock is the only time used for liveness (worker clocks drift; legacy lesson). 
 * Appends are serialized off the gateway request path; a write failure only stops the projection, never execution. The in-memory
 * list is bounded by the gateway caps and is sealed into durable retention when the attempt ends. */
export async function openWorkerEventSink(directory: string) {
  await observationDirectory(directory);
  const path = join(directory, 'worker.events');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const events: WorkerEvent[] = [];
  let writes: Promise<void> = Promise.resolve(), healthy = true;
  return {
    accept(batch: readonly WorkerEvent[], receivedAt = Date.now()) {
      events.push(...batch);
      const bytes = batch.map(event => JSON.stringify({ receivedAt, event })).join('\n') + '\n';
      writes = writes.then(async () => { if (healthy) await handle.write(bytes).then(() => undefined, () => { healthy = false; }); });
    },
    /** The received events and whether the live `worker.events` projection holds all of them (a write failure stops it). */
    async close(): Promise<{ readonly events: readonly WorkerEvent[]; readonly projectionComplete: boolean }> {
      await writes; await handle.close().catch(() => undefined);
      return Object.freeze({ events: Object.freeze([...events]), projectionComplete: healthy });
    },
  };
}
