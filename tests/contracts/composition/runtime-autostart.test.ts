import { prepareRuntimeSocket, runtimeSocketLocation } from '#adapters/core/local-runtime-socket/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { chmod, lstat, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ensureConfiguredRuntimeService, openConfiguredTerminalHistory, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from '../../../src/composition/core/cli/index.js';
import { encodeServiceFrame, ServiceFrameDecoder } from '#adapters/index.js';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { awaitRuntimeServiceRestart, runtimeMonotonicDeadline, RUNTIME_SERVICE_AUTOSTART_ENV } from '#engine/index.js';
import { startConfiguredRuntimeService } from '../../../src/index.js';

const roots: string[] = [], peers: Server[] = [], sockets: Socket[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(peers.splice(0).map(peer => new Promise<void>(resolve => peer.close(() => resolve()))));
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(terminal: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-autostart-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, terminal, ...extra }), { mode: 0o600 });
  return { project, data, options: { env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global') } } };
}

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] treats a fresh project without a state directory as no service, launches once and fails typed with the private log path when none becomes ready in time', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  const launches: Array<{ entry: string; cwd: string; logPath: string }> = [];
  const started = Date.now();
  const error = await ensureConfiguredRuntimeService(f.project, f.options, async input => { launches.push(input); return { pid: 1 }; },
    fileURLToPath(import.meta.url)).catch(value => value);
  expect(error).toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED', params: { log: join(f.data, 'state/runtime-service.log') } });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ cwd: f.project, logPath: join(f.data, 'state/runtime-service.log') });
  expect((await stat(launches[0]!.logPath)).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] never starts a service over an endpoint that fails ownership checks', async () => {
  const f = await fixture();
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: f.project, root: f.data })); roots.push(join(endpoint, '..'));
  await writeFile(endpoint, 'not a socket', { mode: 0o600 });
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; })).rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE/) });
  expect(launched).toBe(0);
});

it.skipIf(process.platform === 'win32')('requires POSIX managed storage; MANAGED_FILE_UNSUPPORTED — keeps composer history per project unless disabled, and never stores an entry that carried pasted content', async () => {
  const f = await fixture();
  const history = await openConfiguredTerminalHistory(f.project, f.options);
  await history!.append({ text: 'visible line', pastes: [] });
  await history!.append({ text: 'see [Pasted 40 lines]', pastes: [{ chip: '[Pasted 40 lines]' }] });
  expect((await (await openConfiguredTerminalHistory(f.project, f.options))!.load()).map(entry => entry.text)).toEqual(['visible line']);
  const off = await fixture({ persistHistory: false });
  expect(await openConfiguredTerminalHistory(off.project, off.options)).toBeNull();
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] treats an accepting but silent endpoint as a present service: bounded by the start deadline, reported, never replaced (Astra 2054 R2)', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: f.project, root: f.data })); roots.push(join(endpoint, '..'));
  const peer = createServer(socket => { socket.on('error', () => undefined); sockets.push(socket); }); peers.push(peer);
  await new Promise<void>(resolve => peer.listen(endpoint, () => resolve())); await chmod(endpoint, 0o600);
  let launched = 0; const started = performance.now();
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }))
    .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
  expect(performance.now() - started).toBeLessThan(3_000);
  expect(launched).toBe(0);
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] BeUser M-09: restart of a service that is not running starts it (one launch, marked automatic), never LOCAL_RUNTIME_UNAVAILABLE', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  const launches: Array<{ env: Record<string, string> }> = [];
  await expect(restartConfiguredRuntimeService(f.project, f.options, async input => { launches.push(input); return { pid: 1 }; }, fileURLToPath(import.meta.url)))
    .rejects.toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED' });
  expect(launches).toHaveLength(1); expect(launches[0]!.env[RUNTIME_SERVICE_AUTOSTART_ENV]).toBe('1');
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] treats a crashed host\'s stale socket (nothing listening) as no service and launches once', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: f.project, root: f.data })); roots.push(join(endpoint, '..'));
  // A killed host leaves its socket file behind; nothing accepts on it any more.
  try { execFileSync(process.execPath, ['-e', `const p=${JSON.stringify(endpoint)};require('net').createServer().listen(p,()=>{require('fs').chmodSync(p,0o600);process.kill(process.pid,'SIGKILL')})`], { stdio: 'ignore' }); }
  catch (error) { expect(error).toMatchObject({ signal: 'SIGKILL' }); }
  expect((await stat(endpoint)).isSocket()).toBe(true);
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url)))
    .rejects.toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED' });
  expect(launched).toBe(1);
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] reports a launch as its own only when the answering service runs in the launched process', async () => {
  const service = { cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 100, shutdownGraceMs: 100 } };
  for (const [launchedPid, mode] of [[process.pid + 1_000_000, 'connected'], [process.pid, 'started']] as const) {
    const f = await fixture({ serviceStartTimeoutMs: 5_000 }, service);
    // The launch "wins" in-process; the reported pid decides whether the answering service is the launched one.
    const ready = await ensureConfiguredRuntimeService(f.project, f.options, async () => {
      services.push(await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options)); return { pid: launchedPid };
    }, fileURLToPath(import.meta.url));
    expect(ready).toMatchObject({ mode, pid: mode === 'started' ? process.pid : null });
    for (const running of services.splice(0)) { await running.stop(); await running.done; }
  }
});

/** A peer on the endpoint that answers describe with a stoppable descriptor, or nothing, and never answers shutdown. */
async function stubbornPeer(data: string, answerDescribe: boolean) {
  await mkdir(join(data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = await prepareRuntimeSocket(resolveProductLayout({ projectRoot: data, root: data }));
  roots.push(join(endpoint, '..'));
  const seen: string[] = [];
  // A request is one frame followed by half-close; the answer (if any) is one frame, like the real host.
  const peer = createServer({ allowHalfOpen: true }, socket => {
    socket.on('error', () => undefined); // the client may give up (deadline) before the answer is written: EPIPE/ECONNRESET is not a test failure
    sockets.push(socket);
    const decoder = new ServiceFrameDecoder(65_536);
    socket.on('data', chunk => decoder.push(chunk));
    socket.on('end', () => {
      const frame = decoder.finish() as { schemaVersion: number; requestId: string; operation: string };
      seen.push(frame.operation);
      if (frame.operation === 'describeService' && answerDescribe) socket.end(encodeServiceFrame({ schemaVersion: frame.schemaVersion, requestId: frame.requestId, ok: true,
        result: { schemaVersion: 1, instanceId: 'instance-1', shutdownAvailable: true, identity: { scopeId: 'scope', serviceId: 'runtime' } } }, 65_536));
    });
  });
  peers.push(peer);
  await new Promise<void>(resolve => peer.listen(endpoint, () => resolve())); await chmod(endpoint, 0o600);
  return seen;
}

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] bounds /service-restart and flagless stop by one budget when describe or the shutdown answer never comes, and launches nothing (Astra 2054 R2)', async () => {
  for (const answerDescribe of [false, true]) {
    const f = await fixture({ serviceStartTimeoutMs: 1_000 });
    const seen = await stubbornPeer(f.data, answerDescribe);
    let launched = 0; const started = performance.now();
    await expect(restartConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url)))
      .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(launched).toBe(0);
    await expect(stopConfiguredRuntimeService(f.project, f.options)).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
    expect(performance.now() - started).toBeLessThan(6_000);
    // With a stoppable descriptor the governed shutdown was sent; its unanswered outcome stays unknown, never a restart.
    expect(seen.includes('shutdownService')).toBe(answerDescribe);
  }
});

// RESTART-HUNT option B (LAW-AUDIT-2 K1–K6, Jev ed1f54d8): describe keeps refusing an own empty directory whose only fault is the mode, but the
// terminal autostart launches the ordinary start for exactly that state once (the start re-creates it 0700); any other unsafe state launches nothing.
const SERVICE = { cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
  service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 100, shutdownGraceMs: 100 } };
async function modeOnlyParent(terminal: Record<string, unknown> = {}) {
  const f = await fixture({ serviceStartTimeoutMs: 5_000, ...terminal }, SERVICE);
  const parent = dirname(runtimeSocketLocation(resolveProductLayout({ projectRoot: f.project, root: f.data }))); roots.push(parent);
  await mkdir(parent, { mode: 0o700 }); await chmod(parent, 0o755); // what an open-view bwrap mask leaves on the host
  return { ...f, parent };
}
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT: the autostart launches the start once for its own empty mode-only directory; the start heals it and only then connects', async () => {
  const f = await modeOnlyParent();
  await expect(prepareRuntimeSocket(resolveProductLayout({ projectRoot: f.project, root: f.data }), false)).rejects.toMatchObject({ reason: 'parent-mode' }); // K1
  let launched = 0;
  const ready = await ensureConfiguredRuntimeService(f.project, f.options, async () => {
    launched++; services.push(await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options)); return { pid: process.pid };
  }, fileURLToPath(import.meta.url));
  expect(ready).toMatchObject({ mode: 'started' }); expect(launched).toBe(1);
  expect((await lstat(f.parent)).mode & 0o777).toBe(0o700);
});
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT: a non-empty, linked or non-directory parent stays UNSAFE and launches nothing', async () => {
  for (const spoil of [async (parent: string) => { await chmod(parent, 0o700); await writeFile(join(parent, 'keep'), 'x', { mode: 0o600 }); await chmod(parent, 0o755); },
    async (parent: string) => { const other = `${parent}-target`; roots.push(other); await mkdir(other, { mode: 0o755 }); await rm(parent, { recursive: true }); await symlink(other, parent); },
    async (parent: string) => { await rm(parent, { recursive: true }); await writeFile(parent, 'x', { mode: 0o600 }); }]) {
    const f = await modeOnlyParent(); await spoil(f.parent);
    let launched = 0;
    await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url)))
      .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE' });
    expect(launched).toBe(0);
  }
});
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] RESTART-HUNT TOCTOU: a state that changes after the decision ends typed (UNSAFE or RUNTIME_AUTOSTART_FAILED), never a connection', async () => {
  const changed = await modeOnlyParent();
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(changed.project, changed.options, async () => {
    launched++; await chmod(changed.parent, 0o700); await writeFile(join(changed.parent, 'planted'), 'x', { mode: 0o600 }); await chmod(changed.parent, 0o755); return { pid: 1 };
  }, fileURLToPath(import.meta.url))).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ENDPOINT_UNSAFE', params: { reason: 'parent-mode' } });
  expect(launched).toBe(1);
  // The launched start never heals it (it died): one launch, bounded by the deadline, typed.
  const silent = await modeOnlyParent({ serviceStartTimeoutMs: 1_000 });
  launched = 0;
  await expect(ensureConfiguredRuntimeService(silent.project, silent.options, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url)))
    .rejects.toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED' });
  expect(launched).toBe(1);
});
it('RESTART-HUNT: the restart loop launches once only for the startable refusal; any other unsafe refusal throws without a launch', async () => {
  const unsafe = ErrorRegistry.createError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { params: { reason: 'parent-mode' } });
  const ready = { mode: 'started', instanceId: 'i', pid: 1, logPath: null, shutdownAvailable: true, build: null, configDigest: undefined, idleStopMs: null } as const;
  for (const healable of [true, false]) {
    let starts = 0;
    const result = awaitRuntimeServiceRestart(runtimeMonotonicDeadline(1_000), { describe: async () => { throw unsafe; }, start: async () => { starts++; return ready; },
      startable: async error => error === unsafe && healable, wait: async () => undefined, pollMs: 1 });
    if (healable) await expect(result).resolves.toBe(ready); else await expect(result).rejects.toBe(unsafe);
    expect(starts).toBe(healable ? 1 : 0);
  }
});
