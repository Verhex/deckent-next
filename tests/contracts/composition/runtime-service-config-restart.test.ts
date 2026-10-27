import { hostname, tmpdir, userInfo } from 'node:os';
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '../../../src/index.js';
import { restartConfiguredRuntimeService } from '../../../src/composition/core/cli/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { RUNTIME_SERVICE_AUTOSTART_ENV, restartConfigDigest, configServiceState } from '#engine/index.js';
import { clearConfigCache, loadConfig, productResourcePath } from '#platform/index.js';
import { encodeServiceFrame, prepareRuntimeSocket, runtimeSocketLocation, ServiceFrameDecoder } from '#adapters/index.js';
import { createServer } from 'node:net';

const roots: string[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
const observer = { async onPage() {}, async onError() {} };
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); await service.settled; }
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

it('a model connection (provider catalog, invocation profiles) never makes the running service stale: every request reads them fresh (FIX8c)', () => {
  const base = { language: 'en', service: { maxConnections: 4 } };
  expect(restartConfigDigest({ ...base, provider_catalog: { schemaVersion: 1, providers: [] }, provider_invocation_profiles: { schemaVersion: 1, profiles: [{ id: 'p' }] } }))
    .toBe(restartConfigDigest(base));
  expect(restartConfigDigest({ ...base, service: { maxConnections: 5 } })).not.toBe(restartConfigDigest(base));
});

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

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a service run by a service manager is never stopped or doubled by a restart: typed refusal naming the manager command, nothing launched', async () => {
  const f = await fixture(); await start(f.project, f.env); let launched = 0; const before = (await describeOf(f.project, f.env)).instanceId;
  const managed = async () => ({ manager: 'systemd' as const, scope: 'user' as const, unit: 'proje-wsl.service' });
  const error = await restartConfiguredRuntimeService(f.project, { env: f.env }, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url), managed).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'RUNTIME_SERVICE_EXTERNALLY_MANAGED', params: { command: 'systemctl --user restart proje-wsl.service' } });
  expect(launched).toBe(0);
  expect((await describeOf(f.project, f.env)).instanceId).toBe(before);
});

// RESTART-HUNT option B on the restart path with the real composition and the real shared predicate (Astra delta 4/5 M1). Below: (1) the shape
// exists BEFORE the restart decides (a stand-in old service leaves it while answering its shutdown) - mode-only gives exactly one start, every
// other shape none; (2) a mask that appears only after a real service's stop: the one start follows genuine absence (the old rule) and the
// started service heals or refuses the shape, never connecting to a bad one; (3) a state changed after the decision ends typed.
// Like the bwrap mask, the shape appears right after the stopping service removed its directory (polled each millisecond; bounded by the service's end).
const maskAfterStop = (parent: string, shape: (parent: string) => Promise<void>) => new Promise<void>((done, fail) => {
  const tick = setInterval(() => { void lstat(parent).catch(async () => { clearInterval(tick); try { await shape(parent); done(); } catch (error) { fail(error); } }); }, 1);
  void services.at(-1)!.settled.then(() => setTimeout(() => { clearInterval(tick); done(); }, 2_000));
});
const shapes = {
  modeOnly: async (parent: string) => { await mkdir(parent, { mode: 0o700 }); await chmod(parent, 0o755); },
  nonEmpty: async (parent: string) => { await mkdir(parent, { mode: 0o700 }); await writeFile(join(parent, 'keep'), 'x', { mode: 0o600 }); await chmod(parent, 0o755); },
  link: async (parent: string) => { await mkdir(`${parent}-target`, { recursive: true, mode: 0o755 }); await symlink(`${parent}-target`, parent); },
  file: async (parent: string) => { await writeFile(parent, 'x', { mode: 0o600 }); },
};
/** A stand-in old service on the real endpoint: answers describe with a stoppable descriptor and, when its shutdown arrives, removes its socket
 * and directory, leaves `shape` there, and only then answers the admission - so the restart's next describe meets the shape. */
async function shapingOldService(project: string, env: Record<string, string | undefined>, shape: (parent: string) => Promise<void>) {
  const endpoint = await prepareRuntimeSocket((await loadConfig(project, { env, heal: false, force: true })).productLayout), parent = dirname(endpoint);
  const peer = createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => undefined); const decoder = new ServiceFrameDecoder(65_536);
    socket.on('data', chunk => decoder.push(chunk));
    socket.on('end', async () => {
      const frame = decoder.finish() as { schemaVersion: number; requestId: string; operation: string; input: Record<string, unknown> };
      const reply = (result: unknown) => socket.end(encodeServiceFrame({ schemaVersion: frame.schemaVersion, requestId: frame.requestId, ok: true, result }, 65_536));
      if (frame.operation === 'describeService') return reply({ schemaVersion: 1, instanceId: 'old-instance', shutdownAvailable: true, identity: { scopeId: 'service-scope', serviceId: 'runtime' } });
      if (frame.operation !== 'shutdownService') return socket.destroy();
      peer.close(); await rm(endpoint, { force: true }); await rm(parent, { recursive: true, force: true }); await shape(parent);
      const principal = { id: 'owner', issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user', scopeIds: ['service-scope'] };
      reply({ replayed: false, admission: { schemaVersion: 1, scopeId: 'service-scope', command: frame.input, actor: { principal, evidence: { method: 'os-peer', pid: process.pid,
        uid: userInfo().uid, gid: userInfo().gid } }, authorization: { revision: 'grant', ruleId: 'shutdown' }, admittedAtMs: 1 } });
    });
  });
  await new Promise<void>(done => peer.listen(endpoint, () => done())); await chmod(endpoint, 0o600);
  return parent;
}
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT: a shape present before the restart decides - mode-only starts exactly once and heals; non-empty, linked or non-directory start nothing', async () => {
  for (const [name, shape] of Object.entries(shapes)) {
    const f = await fixture(), parent = await shapingOldService(f.project, f.env, shape); roots.push(parent, `${parent}-target`);
    let launched = 0;
    const result = await restartConfiguredRuntimeService(f.project, { env: f.env }, async input => { launched++; await start(f.project, input.env); return { pid: process.pid }; },
      fileURLToPath(import.meta.url)).catch((error: unknown) => error);
    if (name === 'modeOnly') {
      expect(result, name).toMatchObject({ mode: 'started' }); expect(launched, name).toBe(1);
      expect((await lstat(parent)).mode & 0o777).toBe(0o700); await expect(describeOf(f.project, f.env)).resolves.toMatchObject({ instanceId: expect.any(String) });
    } else {
      // Non-empty carries the same `parent-mode` reason as mode-only: only the real predicate (emptiness) separates one start from none.
      expect(result, name).toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE', params: { reason: name === 'nonEmpty' ? 'parent-mode' : name === 'link' ? 'parent-link' : 'parent-type' } });
      expect(launched, name).toBe(0);
    }
    await rm(parent, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT: a mask appearing only after a real stop - the one start follows genuine absence; the started service heals mode-only and never heals or connects to the other shapes', async () => {
  for (const [name, shape] of Object.entries(shapes)) {
    const f = await fixture(); await start(f.project, f.env);
    const parent = dirname(runtimeSocketLocation((await loadConfig(f.project, { env: f.env, heal: false, force: true })).productLayout)); roots.push(parent, `${parent}-target`);
    const masked = maskAfterStop(parent, shape); let launched = 0;
    const result = await restartConfiguredRuntimeService(f.project, { env: f.env }, async input => { launched++; await masked; await start(f.project, input.env); return { pid: process.pid }; },
      fileURLToPath(import.meta.url)).catch((error: unknown) => error);
    await masked;
    if (name === 'modeOnly') {
      expect(result, name).toMatchObject({ mode: 'started' }); expect(launched).toBe(1);
      expect((await lstat(parent)).mode & 0o777).toBe(0o700); await expect(describeOf(f.project, f.env)).resolves.toMatchObject({ instanceId: expect.any(String) });
    } else {
      // The stop removed the socket first, so the one launch follows genuine absence (the old rule); the started service refuses the shape.
      expect(result, name).toMatchObject({ code: expect.stringMatching(/^(LOCAL_RUNTIME_ENDPOINT_UNSAFE|RUNTIME_AUTOSTART_FAILED)$/u) }); expect(launched, name).toBeLessThanOrEqual(1);
      await expect(describeOf(f.project, f.env), name).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
      const now = await lstat(parent);
      expect(name === 'link' ? now.isSymbolicLink() : name === 'file' ? now.isFile() : now.isDirectory() && (now.mode & 0o777) === 0o755, name).toBe(true);
    }
    await rm(parent, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT TOCTOU on the restart: content planted after the decision ends typed UNSAFE, one launch, never a connection', async () => {
  const f = await fixture(); await start(f.project, f.env);
  const parent = dirname(runtimeSocketLocation((await loadConfig(f.project, { env: f.env, heal: false, force: true })).productLayout)); roots.push(parent);
  const masked = maskAfterStop(parent, shapes.modeOnly); let launched = 0;
  const result = await restartConfiguredRuntimeService(f.project, { env: f.env }, async () => {
    launched++; await masked; await rm(parent, { recursive: true, force: true }); await shapes.nonEmpty(parent); return { pid: 1 }; // changed after the decision
  }, fileURLToPath(import.meta.url)).catch((error: unknown) => error);
  expect(result).toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE', params: { reason: 'parent-mode' } }); expect(launched).toBe(1);
  await rm(parent, { recursive: true, force: true });
});
