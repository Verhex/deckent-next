import { afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearConfigCache } from '#platform/index.js';
import { startConfiguredRuntimeService, type ConfiguredCancellationRuntimeObserver } from '../../../src/index.js';

type TestRuntimeService = Awaited<ReturnType<typeof startConfiguredRuntimeService>>;
const active: TestRuntimeService[] = [];

const observer: ConfiguredCancellationRuntimeObserver = {
  async onPage() {},
  async onError() {},
};

/** Start the public local runtime host used by shipped-process integration tests. */
export async function startTestRuntimeService(project: string, env: NodeJS.ProcessEnv): Promise<TestRuntimeService> {
  const configPath = join(project, '.deckent', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  // These fixtures exercise explicit surface commands. Dedicated automatic-runtime tests use the normal host directly.
  if (!config.runRuntime) config.runRuntime = { pollIntervalMs: 2147483647 };
  if (!config.cancellation) config.cancellation = { maxConcurrentDeliveries: 1 };
  if (!config.cancellationRuntime) config.cancellationRuntime = {
    scopeIds: ['runtime-test'], pollIntervalMs: 1000, failureBackoffMs: 1000,
  };
  // WORKER-AUTO-REFRESH is automatic-runtime work as well: its start and periodic triggers are off here unless a fixture sets them
  // (runtime-service-image-refresh and toolchain-refresh exercise them on the normal host).
  const toolchains = (config.toolchains ?? {}) as Record<string, unknown>;
  if (!toolchains.update) config.toolchains = { ...toolchains, update: { atStartup: false, intervalMs: 0 } };
  await writeFile(configPath, JSON.stringify(config));
  clearConfigCache();
  const service = await startConfiguredRuntimeService(project, observer, { env });
  active.push(service);
  return service;
}

export async function stopTestRuntimeService(service: TestRuntimeService | undefined): Promise<void> {
  if (!service) return;
  const index = active.indexOf(service);
  if (index >= 0) active.splice(index, 1);
  await service.stop();
  await service.done;
}

/** Fixture owners call this before closing stores or deleting roots. Imported afterEach hooks run after their local hooks (stack order),
 * so the fallback alone cannot stop background ledger/state writes before a caller removes its fixture. */
export async function stopTestRuntimeServices(): Promise<void> {
  for (const service of [...active]) await stopTestRuntimeService(service);
}

afterEach(stopTestRuntimeServices);
