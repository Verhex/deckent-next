import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeEventsSettings } from '#platform/index.js';
import { WorkerObservationError, projectLiveWorkerMetadata } from '#engine/index.js';
import { observationDirectory } from './files.js';
/** Only the safe event sidecar is opened. Logs, output, prompt, workspace contents and process control are never read. */
export async function readLiveWorkerMetadata(directory: string, limits: RuntimeEventsSettings) {
  if (process.platform !== 'linux' || !(constants.O_NOFOLLOW > 0) || !(constants.O_NONBLOCK > 0) || !(constants.O_DIRECTORY > 0)) throw new WorkerObservationError('WORKER_OBSERVATION_UNAVAILABLE');
  await observationDirectory(directory);
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const handle = await open(join(`/proc/self/fd/${root.fd}`, 'worker.events'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o022)) throw new Error('unsafe');
      const bytes = Buffer.alloc(Math.min(before.size, limits.liveWorkerMaxBytes));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, before.size - bytes.length);
      const after = await handle.stat();
      return projectLiveWorkerMetadata(bytes.subarray(0, bytesRead).toString('utf8'), limits.liveWorkerMaxEvents,
        `${before.dev}:${before.ino}:${before.size}`, before.size > bytes.length || before.size > after.size || bytesRead !== bytes.length);
    } finally { await handle.close(); }
  } finally { await root.close(); }
}
