import { SystemTrustedClock } from '#platform/index.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerEvent, WorkerModelVerification } from '#domain/index.js';
import { observationDirectory } from './files.js';

/** Live, append-only projection of validated worker events next to the attempt's other sidecars (`worker.events`, NDJSON, 0600).
 * Each line is `{receivedAt, event}`: the host clock is the only time used for liveness (worker clocks drift; legacy lesson). 
 * Appends are serialized off the gateway request path; a write, short-write or close failure only marks the projection partial,
 * never fails execution. The in-memory list is bounded by the gateway caps and is sealed into durable retention when the attempt ends. */
export async function openWorkerEventSink(directory: string, openFile: EventFileOpener = open) {
  await observationDirectory(directory);
  const clock = new SystemTrustedClock();
  const path = join(directory, 'worker.events');
  const handle = await openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  const events: WorkerEvent[] = [];
  let writes: Promise<void> = Promise.resolve(), healthy = true;
  return {
    accept(batch: readonly WorkerEvent[], receivedAt = clock.sample().wallMs) {
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

/**
 * The retained event log of an ended attempt, as JSON lines: the received events, then the host's model verdict when there is one and one
 * `event-cap` marker for batches refused after the gateway's budget was spent (never silent); then as many lines as fit the artifact limit
 * (less 256 bytes), the rest as one `byte-cap` marker. No lines when there is nothing to seal.
 */
export function sealWorkerEventLog(events: readonly WorkerEvent[], verification: WorkerModelVerification | null, unreported: number, maxBytes: number): string[] {
  const received = verification ? [...events, { schemaVersion: 1 as const, sequence: (events.at(-1)?.sequence ?? 0) + 1,
    atMs: events.at(-1)?.atMs ?? 0, kind: 'model.verification' as const, ...verification }] : events;
  const sealed = unreported > 0 ? [...received, { schemaVersion: 1 as const, sequence: (received.at(-1)?.sequence ?? 0) + 1, atMs: received.at(-1)?.atMs ?? 0,
    kind: 'dropped' as const, reason: 'event-cap' as const, count: unreported }] : received;
  const lines: string[] = []; let bytes = 0, kept = 0;
  for (const event of sealed) { const line = JSON.stringify(event) + '\n'; if (bytes + Buffer.byteLength(line) > maxBytes - 256) break; lines.push(line); bytes += Buffer.byteLength(line); kept++; }
  if (kept < sealed.length) lines.push(JSON.stringify({ schemaVersion: 1, sequence: (sealed[kept - 1]?.sequence ?? 0) + 1, atMs: sealed[kept - 1]?.atMs ?? 0,
    kind: 'dropped', reason: 'byte-cap', count: sealed.length - kept }) + '\n');
  return lines;
}
