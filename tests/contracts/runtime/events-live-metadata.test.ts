import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDefaultConfig } from '#platform/index.js';
import { readLiveWorkerMetadata } from '#adapters/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dk-events-live-')); roots.push(root); return root; }
const usage = (sequence: number) => JSON.stringify({ receivedAt: sequence, event: { schemaVersion: 1, sequence, atMs: sequence, kind: 'usage', tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, thinking: null } } }) + '\n';
it.skipIf(process.platform !== 'linux')('collects safe numeric metadata only, with explicit source loss for native caps and sequence gaps', async () => {
  const root = await fixture(); await writeFile(join(root, 'worker.events'), usage(1) + usage(3), { mode: 0o600 });
  await writeFile(join(root, 'worker.log'), 'CANARY_RAW_OUTPUT');
  const result = await readLiveWorkerMetadata(root, createDefaultConfig().service.events);
  expect(result).toMatchObject({ sourceLoss: true, eventCount: 2, inputTokens: 6, outputTokens: 8 }); expect(JSON.stringify(result)).not.toContain('CANARY');
  const capped = await readLiveWorkerMetadata(root, { ...createDefaultConfig().service.events, liveWorkerMaxEvents: 1 }); expect(capped.sourceLoss).toBe(true); expect(capped.eventCount).toBe(1);
});
it.skipIf(process.platform !== 'linux')('refuses a symlinked safe sidecar and a non-owned/writable directory without reading output files', async () => {
  const root = await fixture(); await writeFile(join(root, 'private'), usage(1), { mode: 0o600 }); await symlink(join(root, 'private'), join(root, 'worker.events'));
  await expect(readLiveWorkerMetadata(root, createDefaultConfig().service.events)).rejects.toThrow();
});

it.skipIf(process.platform === 'linux')('unsupported native platforms refuse before sidecar access', async () => {
  await expect(readLiveWorkerMetadata('unopened-path', createDefaultConfig().service.events)).rejects.toMatchObject({ code: 'WORKER_OBSERVATION_UNAVAILABLE' });
});
