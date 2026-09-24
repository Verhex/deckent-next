import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerEvent } from '#domain/index.js';
import { observationDirectory } from './files.js';

/** Live, append-only projection of validated worker events next to the attempt's other sidecars (`worker.events`, NDJSON, 0600).
 * Each line is `{receivedAt, event}`: the host clock is the only time used for liveness (worker clocks drift; legacy lesson). 
 * Appends are serialized off the gateway request path; a write, short-write or close failure only marks the projection partial,
 * never fails execution. The in-memory list is bounded by the gateway caps and is sealed into durable retention when the attempt ends. */
export async function openWorkerEventSink(directory: string, openFile: EventFileOpener = open) {
  await observationDirectory(directory);
  const path = join(directory, 'worker.events');
  const handle = await openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const events: WorkerEvent[] = [];
  let writes: Promise<void> = Promise.resolve(), healthy = true;
  return {
    accept(batch: readonly WorkerEvent[], receivedAt = Date.now()) {
      events.push(...batch);
      const bytes = Buffer.from(batch.map(event => JSON.stringify({ receivedAt, event })).join('\n') + '\n');
      writes = writes.then(async () => { if (healthy) healthy = await writeAll(handle, bytes).catch(() => false); });
    },
    /** The received events and whether the live `worker.events` projection holds all of them (any write or close failure marks it partial). */
    async close(): Promise<{ readonly events: readonly WorkerEvent[]; readonly projectionComplete: boolean }> {
      await writes; await handle.close().catch(() => { healthy = false; });
      return Object.freeze({ events: Object.freeze([...events]), projectionComplete: healthy });
    },
  };
}

/** The file surface the sink needs; injectable so a short write or close fault is provable without a faulty disk. */
export interface EventFile { write(bytes: Buffer, offset: number, length: number): Promise<{ readonly bytesWritten: number }>; close(): Promise<void> }
export type EventFileOpener = (path: string, flags: number, mode: number) => Promise<EventFile>;

/** A successful write may be short (a full disk, a signal); continue from the written offset, bounded so a stalled file cannot hold the queue. */
const writeAttempts = 8;
async function writeAll(handle: EventFile, bytes: Buffer) {
  let offset = 0;
  for (let attempt = 0; attempt < writeAttempts && offset < bytes.length; attempt++) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += Math.max(0, bytesWritten);
  }
  return offset === bytes.length;
}
