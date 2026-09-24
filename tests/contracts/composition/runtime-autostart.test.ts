import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ensureConfiguredRuntimeService, openConfiguredTerminalHistory, restartConfiguredRuntimeService, stopConfiguredRuntimeService } from '../../../src/composition/core/cli/index.js';
import { encodeServiceFrame, ServiceFrameDecoder } from '#adapters/index.js';
import { clearConfigCache } from '#platform/index.js';
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
  return { project, data, options: { env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global') } } };
}

it('treats a fresh project without a state directory as no service, launches once and fails typed with the private log path when none becomes ready in time', async () => {
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

it('never starts a service over an endpoint that fails ownership checks', async () => {
  const f = await fixture();
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.data, 'state/runtime.sock'), 'not a socket', { mode: 0o600 });
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; })).rejects.toMatchObject({ code: expect.stringMatching(/UNSAFE/) });
  expect(launched).toBe(0);
});

it('keeps composer history per project unless disabled, and never stores an entry that carried pasted content', async () => {
  const f = await fixture();
  const history = await openConfiguredTerminalHistory(f.project, f.options);
  await history!.append({ text: 'visible line', pastes: [] });
  await history!.append({ text: 'see [Pasted 40 lines]', pastes: [{ chip: '[Pasted 40 lines]' }] });
  expect((await (await openConfiguredTerminalHistory(f.project, f.options))!.load()).map(entry => entry.text)).toEqual(['visible line']);
  const off = await fixture({ persistHistory: false });
  expect(await openConfiguredTerminalHistory(off.project, off.options)).toBeNull();
});

it('treats an accepting but silent endpoint as a present service: bounded by the start deadline, reported, never replaced (Astra 2054 R2)', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = join(f.data, 'state/runtime.sock');
  const peer = createServer(socket => { sockets.push(socket); }); peers.push(peer);
  await new Promise<void>(resolve => peer.listen(endpoint, () => resolve())); await chmod(endpoint, 0o600);
  let launched = 0; const started = performance.now();
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }))
    .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
  expect(performance.now() - started).toBeLessThan(3_000);
  expect(launched).toBe(0);
});

it('treats a crashed host\'s stale socket (nothing listening) as no service and launches once', async () => {
  const f = await fixture({ serviceStartTimeoutMs: 1_000 });
  await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
  const endpoint = join(f.data, 'state/runtime.sock');
  // A killed host leaves its socket file behind; nothing accepts on it any more.
  try { execFileSync(process.execPath, ['-e', `const p=${JSON.stringify(endpoint)};require('net').createServer().listen(p,()=>{require('fs').chmodSync(p,0o600);process.kill(process.pid,'SIGKILL')})`], { stdio: 'ignore' }); }
  catch (error) { expect(error).toMatchObject({ signal: 'SIGKILL' }); }
  expect((await stat(endpoint)).isSocket()).toBe(true);
  let launched = 0;
  await expect(ensureConfiguredRuntimeService(f.project, f.options, async () => { launched++; return { pid: 1 }; }, fileURLToPath(import.meta.url)))
    .rejects.toMatchObject({ code: 'RUNTIME_AUTOSTART_FAILED' });
  expect(launched).toBe(1);
});

it('reports a launch as its own only when the answering service runs in the launched process', async () => {
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
  const endpoint = join(data, 'state/runtime.sock');
  const seen: string[] = [];
  // A request is one frame followed by half-close; the answer (if any) is one frame, like the real host.
  const peer = createServer({ allowHalfOpen: true }, socket => {
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

it('bounds /service-restart and flagless stop by one budget when describe or the shutdown answer never comes, and launches nothing (Astra 2054 R2)', async () => {
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
