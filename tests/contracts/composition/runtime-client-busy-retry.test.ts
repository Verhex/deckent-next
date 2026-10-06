import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ busy: 0, calls: 0, retryAfterMs: 5 }));
vi.mock('#adapters/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#adapters/index.js')>();
  return { ...actual, requestLocalRuntime: async (...args: Parameters<typeof actual.requestLocalRuntime>) => {
    mocked.calls++;
    if (mocked.busy > 0) {
      mocked.busy--;
      return { schemaVersion: args[1].schemaVersion, requestId: args[1].requestId, ok: false,
        error: { code: 'RUNTIME_SERVICE_BUSY', category: 'error', params: { retryAfterMs: mocked.retryAfterMs } } } as never;
    }
    return actual.requestLocalRuntime(...args);
  } };
});
const { createConfiguredRuntimeClient, startConfiguredRuntimeService } = await import('../../../src/index.js');
const { clearConfigCache } = await import('#platform/index.js');

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); mocked.busy = 0; mocked.calls = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(busyRetryLimit: number) {
  const project = await mkdtemp(join(tmpdir(), 'dk-busy-')); roots.push(project);
  await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'd') },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 }, service: {
    inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000,
    shutdownGraceMs: 1000, admissionWaitMs: 10, busyRetryLimit } }));
  return { project, env: { HOME: join(project, 'h'), USERPROFILE: join(project, 'h') } };
}
const observer = { async onPage() {}, async onError() {} };

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a BUSY answer is retried a bounded number of times and then succeeds', async () => {
  const f = await fixture(2), service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    mocked.busy = 2; mocked.calls = 0;
    await expect(createConfiguredRuntimeClient(f.project, { env: f.env }).describeService()).resolves.toMatchObject({ schemaVersion: 1 });
    expect(mocked.calls).toBe(3);
  } finally { await service.stop(); await service.done; }
}, 10000);

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a persistent BUSY stops after the configured retries with the typed BUSY and its retryAfterMs; limit 0 never retries', async () => {
  const f = await fixture(2), service = await startConfiguredRuntimeService(f.project, observer, { env: f.env });
  try {
    mocked.busy = 100; mocked.calls = 0;
    await expect(createConfiguredRuntimeClient(f.project, { env: f.env }).describeService()).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_BUSY', params: { retryAfterMs: 5 } });
    expect(mocked.calls).toBe(3);
  } finally { await service.stop(); await service.done; }
  clearConfigCache();
  const none = await fixture(0), second = await startConfiguredRuntimeService(none.project, observer, { env: none.env });
  try {
    mocked.busy = 100; mocked.calls = 0;
    await expect(createConfiguredRuntimeClient(none.project, { env: none.env }).describeService()).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_BUSY' });
    expect(mocked.calls).toBe(1);
  } finally { await second.stop(); await second.done; }
}, 10000);
