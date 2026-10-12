import { mkdtemp, rm, chmod, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileResourceTraceStore } from '#adapters/index.js';
import { resourceGap } from '#engine/index.js';
import { getConfigFieldDefault } from '#platform/index.js';
const roots: string[] = [], identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(maxStoreEntries = 2) { const root = await mkdtemp(join(tmpdir(), 'resource-trace-')); roots.push(root); await chmod(root, 0o700);
  const settings = { ...getConfigFieldDefault('resourceObservation'), maxStoreEntries }; return { root, settings, store: new FileResourceTraceStore(async () => root, settings, () => 1000) }; }
it.skipIf(process.platform !== 'linux')('bounds retention, serializes concurrent writers and deduplicates replay without crossing attempts', async () => {
  const { store } = await fixture(); const first = resourceGap(identity, 100, 'starting');
  await Promise.all([store.append(first), store.append(first)]);
  await store.append(resourceGap({ ...identity, generation: 2 }, 200, 'missing'));
  await store.append(resourceGap(identity, 300, 'timeout'));
  expect(await store.read(identity)).toMatchObject({ samples: [{ observedAtMs: 300 }], trimmedBeforeMs: 100 });
  expect((await store.read({ ...identity, generation: 2 })).trimmedBeforeMs).toBeNull();
  expect((await store.read({ ...identity, attemptId: 'other' })).samples).toEqual([]);
});
it.skipIf(process.platform !== 'linux')('refuses symlink and public-mode storage instead of exposing or overwriting it', async () => {
  const { root, settings, store } = await fixture(); const outside = join(root, 'outside'); await writeFile(outside, 'private', { mode: 0o600 });
  await symlink(outside, join(root, settings.fileName)); await expect(store.append(resourceGap(identity, 100, 'starting'))).rejects.toBeDefined();
  expect(await readFile(outside, 'utf8')).toBe('private'); await chmod(root, 0o755); await expect(store.read(identity)).rejects.toThrow('RESOURCE_TRACE_UNSAFE');
});
it.skipIf(process.platform !== 'linux')('reports an impossible byte budget as a failed write and creates no false zero measurement', async () => {
  const { root, settings } = await fixture(); const store = new FileResourceTraceStore(async () => root, { ...settings, maxStoreBytes: 1 }, () => 100);
  await expect(store.append(resourceGap(identity, 100, 'starting'))).rejects.toThrow('RESOURCE_TRACE_FULL');
});
it.skipIf(process.platform === 'linux')('refuses unsupported file custody before filesystem access', async () => {
  const { store } = await fixture(); await expect(store.read(identity)).rejects.toThrow('RESOURCE_TRACE_UNSUPPORTED');
});
