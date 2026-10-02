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

/** Covers the schema's largest host verdict (34 model entries, admitted model, JSON escaping) and two loss markers.
 * The config check adds this reserve to the gateway's registry event budget; it is an invariant, not mutable policy. */
export const WORKER_EVENT_SEAL_RESERVE_BYTES = 32768;

/** Retain a prefix of received events only after reserving the host verdict and all loss markers. Host evidence is never truncated.
 * The byte-cap marker precedes the host verdict when a received suffix was dropped; sequences remain strictly increasing. */
export function sealWorkerEventLog(events: readonly WorkerEvent[], verification: WorkerModelVerification | null, unreported: number, maxBytes: number): string[] {
  const serialize = (event: unknown) => JSON.stringify(event) + '\n';
  const suffix = (sequence: number, atMs: number, dropped: number): string[] => {
    const lines: string[] = [];
    if (dropped > 0) lines.push(serialize({ schemaVersion: 1, sequence: ++sequence, atMs, kind: 'dropped', reason: 'byte-cap', count: dropped }));
    if (verification) lines.push(serialize({ schemaVersion: 1, sequence: ++sequence, atMs, kind: 'model.verification', ...verification }));
    if (unreported > 0) lines.push(serialize({ schemaVersion: 1, sequence: sequence + 1, atMs, kind: 'dropped', reason: 'event-cap', count: unreported }));
    return lines;
  };
  const received = events.map(serialize), last = events.at(-1);
  const complete = [...received, ...suffix(last?.sequence ?? 0, last?.atMs ?? 0, 0)];
  if (Buffer.byteLength(complete.join('')) <= maxBytes) return complete;
  // The original last sequence/time bound every retained prefix; dropped count is bounded by the entire received list.
  const reserve = Buffer.byteLength(suffix(last?.sequence ?? 0, last?.atMs ?? 0, events.length).join(''));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < reserve) throw new RangeError('WORKER_EVENT_SEAL_BUDGET');
  const lines: string[] = []; let bytes = 0;
  for (const line of received) {
    const size = Buffer.byteLength(line);
    if (bytes + size > maxBytes - reserve) break;
    lines.push(line); bytes += size;
  }
  const tail = events[lines.length - 1];
  return [...lines, ...suffix(tail?.sequence ?? 0, last?.atMs ?? 0, events.length - lines.length)];
}
