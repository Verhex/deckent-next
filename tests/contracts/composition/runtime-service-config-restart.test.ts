import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '../../../src/index.js';
import { restartConfiguredRuntimeService } from '../../../src/composition/core/cli/index.js';
import { configServiceState } from '../../../src/surfaces/core/config/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { RUNTIME_SERVICE_AUTOSTART_ENV, restartConfigDigest } from '#engine/index.js';
import { clearConfigCache, loadConfig, productResourcePath } from '#platform/index.js';

const roots: string[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
const observer = { async onPage() {}, async onError() {} };
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'deckent-config-restart-')); roots.push(project); const data = join(project, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); const env = { HOME: join(project, 'home') };
  const write = (extra: Record<string, unknown> = {}, maxConnections = 4) => writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, ...extra,
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['service-scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'service-scope', serviceId: 'runtime' }, inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections, maxConcurrentRequests: 2,
      maxConcurrentExecutions: 1, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  await write();
  const opened = await openConfiguredAttemptStore(project, { env });
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'grant', restrictions: [], grants: [{ id: 'shutdown', effect: 'allow', actions: ['shutdown'],
    scopes: ['service-scope'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'service', ids: ['runtime'] } }] }), { mode: 0o600 });
  opened.store.close(); clearConfigCache();
  return { project, env, write };
}
// A launched process starts after the stopped one is gone; the in-process stand-in waits for its predecessor's completion the same way.
const start = async (project: string, env: Record<string, string | undefined>, ports = {}, seen = observer) => { const service = await startConfiguredRuntimeService(project, seen, { env }, ports); services.push(service); return service; };
const describeOf = (project: string, env: Record<string, string | undefined>) => createConfiguredRuntimeClient(project, { env }).describeService();

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] the descriptor names the configuration it started with and its origin: only a launch-marked service is idle-stoppable', async () => {
  const f = await fixture();
  const manual = await start(f.project, f.env); const d1 = await describeOf(f.project, f.env);
  expect(d1).toMatchObject({ autoStarted: false, idleStopMs: null });
  expect(d1.configDigest).toBe(restartConfigDigest(await loadConfig(f.project, { env: f.env, heal: false, force: true }) as never));
  await manual.stop(); await manual.done; clearConfigCache();
  const env = { ...f.env, [RUNTIME_SERVICE_AUTOSTART_ENV]: '1' }; await start(f.project, env);
  expect(await describeOf(f.project, env)).toMatchObject({ autoStarted: true, idleStopMs: 900_000 });
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a restart-apply change makes the running service stale; a live change does not; restart onto it makes it current again', async () => {
  const f = await fixture(); await start(f.project, f.env);
  expect(await configServiceState(f.project, { env: f.env }, (r, o) => createConfiguredRuntimeClient(r, o).describeService())).toBe('current');
  await f.write({ language: 'tr' }); clearConfigCache(); // live field
  expect(await configServiceState(f.project, { env: f.env }, (r, o) => createConfiguredRuntimeClient(r, o).describeService())).toBe('current');
  await f.write({}, 5); clearConfigCache(); // restart-apply field (service.maxConnections)
  const describe = (r: string, o: { env?: Record<string, string | undefined> }) => createConfiguredRuntimeClient(r, o).describeService();
  expect(await configServiceState(f.project, { env: f.env }, describe)).toBe('stale');
  const launched: Array<Record<string, string>> = [];
  const restarted = await restartConfiguredRuntimeService(f.project, { env: f.env }, async input => { launched.push(input.env); await services.at(-1)!.done; await start(f.project, input.env); return { pid: process.pid }; }, fileURLToPath(import.meta.url));
  expect(restarted.mode).toBe('started'); expect(launched).toHaveLength(1);
  expect(await configServiceState(f.project, { env: f.env }, describe)).toBe('current');
});

for (const autoStarted of [false, true]) {
  it.skipIf(process.platform !== 'linux')(`[requires Linux local runtime socket] a managed restart keeps the origin (autoStarted=${autoStarted}): only an automatic start is relaunched marked`, async () => {
    const f = await fixture(); const launched: Array<Record<string, string>> = [];
    const launch = async (input: { env: Record<string, string> }) => { launched.push(input.env); await services.at(-1)!.done; await start(f.project, input.env); return { pid: process.pid }; };
    const env = autoStarted ? { ...f.env, [RUNTIME_SERVICE_AUTOSTART_ENV]: '1' } : f.env; await start(f.project, env);
    await restartConfiguredRuntimeService(f.project, { env: f.env }, launch, fileURLToPath(import.meta.url));
    // Negative: a hand-started (live-style) service never becomes idle-stoppable through a restart.
    expect(launched[0]![RUNTIME_SERVICE_AUTOSTART_ENV]).toBe(autoStarted ? '1' : undefined);
    expect(await describeOf(f.project, f.env)).toMatchObject({ autoStarted, idleStopMs: autoStarted ? 900_000 : null });
  });
}

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] an automatically started service stops itself through the governed stop once idle; a hand-started one in the same state never does', async () => {
  const f = await fixture(); const events: number[] = [];
  let clock = 0; const idleClock = { now: () => clock, wait: async (milliseconds: number) => { await new Promise(resolve => setTimeout(resolve, 5)); clock += milliseconds; } }; // each wait elapses at once
  const manual = await start(f.project, f.env, { idleClock }, { ...observer, onIdleShutdown: async (event: { afterMs: number }) => { events.push(event.afterMs); } } as never);
  await new Promise(resolve => setTimeout(resolve, 300));
  await expect(describeOf(f.project, f.env)).resolves.toMatchObject({ autoStarted: false }); expect(events).toEqual([]); // negative: not stopped
  await manual.stop(); await manual.done; clearConfigCache();
  const env = { ...f.env, [RUNTIME_SERVICE_AUTOSTART_ENV]: '1' };
  const auto = await start(f.project, env, { idleClock }, { ...observer, onIdleShutdown: async (event: { afterMs: number }) => { events.push(event.afterMs); } } as never);
  await auto.done; // resolved by the service's own stop, no client command
  expect(events).toEqual([900_000]);
  await expect(describeOf(f.project, env)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_UNAVAILABLE' });
});
