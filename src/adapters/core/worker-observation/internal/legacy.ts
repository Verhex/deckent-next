import { opendir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ObservationLimits, WorkerObservation, WorkerProcessState } from '#engine/index.js';
import { observationDirectory, readWorkerSidecars } from './files.js';
export async function inspectLegacyWorkers(directory: string, limits: ObservationLimits, limit: number, after: string | null) {
  await observationDirectory(directory);
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const tasks = new Set<string>(); let scanned = 0; let truncated = false;
  try {
    const entries = await opendir(`/proc/self/fd/${root.fd}`);
    for await (const entry of entries) {
      if (++scanned > limits.maxEntries) { truncated = true; break; }
      const match = /^task-([a-zA-Z0-9_.:-]{1,128})\.(?:hb|log|result)$/u.exec(entry.name);
      if (match && (!after || match[1]! > after)) tasks.add(match[1]!);
    }
  } finally { await root.close(); }
  const ids = [...tasks].sort(); const workers: WorkerObservation[] = [];
  for (const taskId of ids.slice(0, limit)) {
    const files = await readWorkerSidecars(directory, 'task-' + taskId, limits);
    let processState: WorkerProcessState = 'unknown';
    if (files.pid !== null) {
      try { process.kill(files.pid, 0); processState = 'present-unverified'; }
      catch (error) { const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        processState = code === 'ESRCH' ? 'absent-unverified' : code === 'EPERM' ? 'denied' : 'unknown'; }
    }
    workers.push({ taskId, identity: null, authority: 'legacy-activity', provider: 'unknown', workspace: null,
      process: processState, handle: null, terminal: null, outputRecorded: false, patchRecorded: false, files,
      diagnostics: ['legacy-identity-unverified', ...(files.result.state === 'available' ? ['reported-result-not-acceptance'] : []), ...files.log.diagnostics] });
  }
  return { workers, nextAfter: ids.length > limit ? ids[limit - 1]! : null, truncated: truncated || ids.length > limit };
}
