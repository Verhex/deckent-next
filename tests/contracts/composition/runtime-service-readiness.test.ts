import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startConfiguredRuntimeService } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function config(root: string, scopeIds: string[]) {
  return { layout: { root }, cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1,
    retryDelayMs: 1, claimTtlMs: 10 }, cancellationRuntime: { scopeIds, pollIntervalMs: 1000,
    failureBackoffMs: 1000 }, service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2,
    maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 100, shutdownGraceMs: 100 } };
}

it('rejects invalid recovery configuration before binding and starts after the configuration is corrected', async () => {
  const project = await mkdtemp(join(tmpdir(), 'deckent-service-ready-'));
  roots.push(project);
  const data = join(project, 'data');
  const configPath = join(project, '.deckent/config.json');
  const endpoint = join(data, 'state/runtime.sock');
  const env = { HOME: join(project, 'home') };
  await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(configPath, JSON.stringify(config(data, ['scope', 'scope'])));
  const observer = { async onPage() {}, async onError() {} };

  await expect(startConfiguredRuntimeService(project, observer, { env })).rejects
    .toMatchObject({ code: 'CANCELLATION_RUNTIME_LOOP_OPTIONS' });
  await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });

  await writeFile(configPath, JSON.stringify(config(data, ['scope'])));
  clearConfigCache();
  const service = await startConfiguredRuntimeService(project, observer, { env });
  try { expect((await lstat(endpoint)).isSocket()).toBe(true); }
  finally { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
});
