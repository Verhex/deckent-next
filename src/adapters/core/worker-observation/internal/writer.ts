import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkerActivity } from '#engine/index.js';
import { observationDirectory } from './files.js';
/** Best-effort host projection. Failure never changes dispatch ownership, cancellation or terminal truth. */
export async function startWorkerObservation(directory: string, intervalMs: number, maxBytes: number,
  sample: () => Promise<WorkerActivity | null>) {
  let stopped = false; let pending = Promise.resolve(); let timer: ReturnType<typeof setTimeout> | undefined;
  const events: string[] = []; let last = ''; let sequence = 0;
  async function publish(suffix: string, bytes: string) {
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error('OBSERVATION_LIMIT');
    await observationDirectory(directory);
    const temporary = join(directory, `.worker-observation-${randomUUID()}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(directory, 'worker.' + suffix));
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async function tick() {
    try {
      const observation = await sample(); if (!observation) return;
      await publish('hb', JSON.stringify(observation) + '\n');
      const signature = JSON.stringify([observation.process, observation.terminal, observation.outputRecorded]);
      if (signature !== last) {
        last = signature;
        events.push(JSON.stringify({ schemaVersion: 1, sequence: ++sequence, observedAt: observation.observedAt,
          process: observation.process, terminal: observation.terminal, outputRecorded: observation.outputRecorded }) + '\n');
        while (events.length > 1 && Buffer.byteLength(events.join('')) > maxBytes) events.shift();
        await publish('log', events.join(''));
      }
      if (observation.terminal) await publish('result', JSON.stringify(observation) + '\n');
    } catch { /* Missing/stale observation is reported by the reader; execution remains authoritative. */ }
  }
  const schedule = () => { timer = setTimeout(() => { pending = tick().finally(() => { if (!stopped) schedule(); }); }, intervalMs); timer.unref(); };
  await tick(); schedule();
  return { async close() { stopped = true; clearTimeout(timer); await pending; await tick(); } };
}
