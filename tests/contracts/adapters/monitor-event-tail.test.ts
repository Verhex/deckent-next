import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readWorkerEventTail } from '#adapters/index.js';

// MONITOR v1.1: the live worker.events tail keeps only schema-valid events with the host's receivedAt; a cut first line is skipped.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.skipIf(process.platform !== 'linux')('reads the validated tail of the live worker event projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-event-tail-')); roots.push(root); await chmod(root, 0o700);
  const event = (sequence: number) => ({ schemaVersion: 1, sequence, atMs: sequence, kind: 'tool.result', toolId: 't', status: 'ok', bytes: 1 });
  const lines = [JSON.stringify({ receivedAt: 100, event: event(1) }), 'not json', JSON.stringify({ receivedAt: 'x', event: event(2) }), JSON.stringify({ receivedAt: 300, event: { kind: 'bogus' } })];
  await writeFile(join(root, 'worker.events'), lines.join('\n') + '\n', { mode: 0o600 });
  expect(await readWorkerEventTail(root, 'worker', 65_536)).toEqual([{ receivedAt: 100, event: event(1) }, { receivedAt: null, event: event(2) }]);
  // A tail that cuts into the first line drops it rather than misreading it.
  expect((await readWorkerEventTail(root, 'worker', lines.slice(1).join('\n').length + 5)).map(line => line.event.sequence)).toEqual([2]);
  await expect(readWorkerEventTail(root, '../x', 10)).rejects.toMatchObject({ code: 'WORKER_OBSERVATION_INVALID' });
});
