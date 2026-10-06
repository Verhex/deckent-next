import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startConfiguredRuntimeService, prepareNativeCodingProfile } from '../../../src/index.js';
import { clearConfigCache } from '#platform/index.js';
import type { WorkerImageBuildRunner } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bounds = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const ok = (requestId: string) => ({ schemaVersion: 1 as const, requestId, started: true, reason: 'exit' as const, exitCode: 0, signal: null, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });

async function installation(update: Record<string, unknown>, docker = true) {
  const project = await mkdtemp(join(tmpdir(), 'deckent-service-refresh-')); roots.push(project);
  const profile = structuredClone(prepareNativeCodingProfile({ schemaVersion: 1, template: { id: 'codex-pinned', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...bounds, argv: ['unused'] } },
    invocation: { schemaVersion: 2, provider: 'codex', cliVersion: 'codex-cli 0.155.1', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'fixture task' } }).profile);
  await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'data') },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 }, cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 4096, responseMaxBytes: 4096, maxConnections: 2, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 100, shutdownGraceMs: 100 },
    execution: { docker: { executable: 'docker', imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 2147483648, pids: 128, cpus: 2, logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 } },
    toolchains: { currency: { registryEndpoint: 'http://127.0.0.1:1' }, update },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'r', profiles: [profile],
      kinds: [{ kind: 'codex-pinned', profile: { id: 'codex-pinned', version: 1 } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } }));
  if (!docker) { // the same installation without Docker execution (and so without the Docker-bound registry)
    const config = JSON.parse(await readFile(join(project, '.deckent/config.json'), 'utf8')) as Record<string, unknown>;
    delete config['execution']; delete config['admission']; await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config));
  }
  let builds = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let honorStop = false, hangPreflight = false;
  const runner: WorkerImageBuildRunner = async (command, signal) => {
    // A daemon check that never answers by itself (a hung Docker daemon): only the stopping service's signal ends it, like the real runner.
    if (command.args[1] === '--check-version' && hangPreflight) {
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { ...ok(command.requestId), reason: 'cancelled' as const, exitCode: null };
    }
    if (command.args[1] === '--check-version') return ok(command.requestId);
    builds++;
    // The real runner ends the builder process on the signal; this one takes a while to do so, like a process that exits on SIGTERM.
    if (honorStop) await new Promise<never>((_, reject) => signal?.addEventListener('abort', () => { setTimeout(() => reject(Object.assign(new Error('stopped'), { code: 'PROCESS_ABORTED' })), 300); }, { once: true }));
    await gate;
    const recipe = JSON.parse(await readFile(join(command.cwd, 'recipe.json'), 'utf8')) as { imageVersion: string; repository: string };
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 2, imageId: 'sha256:' + 'b'.repeat(64), imageVersion: recipe.imageVersion, tag: `${recipe.repository}:${recipe.imageVersion}`,
      manifest: { providers: [{ id: 'codex', version: 'codex-cli 0.156.0' }, { id: 'claude', version: '2.1.278 (Claude Code)' }, { id: 'cursor', version: '2026.09.18-9a7762b' }] } }));
    return ok(command.requestId);
  };
  const fetcher = async (request: { package: string }) => ({ version: request.package === '@openai/codex' ? '0.156.0' : '2.1.278', source: 'fixture', observedAt: new Date().toISOString() });
  return { project, env: { HOME: join(project, 'home') }, runner, fetcher, release, builds: () => builds, honorStop: () => { honorStop = true; }, hangPreflight: () => { hangPreflight = true; } };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); expect(check()).toBe(true); };

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a stale install starts, is ready, and refreshes in the background; stopping the service cancels what is left', async () => {
  const f = await installation({});
  const events: string[] = [];
  const observer = { async onPage() {}, async onError() {}, onToolchainRefresh: (event: { phase: string; code: string | null }) => { events.push(`${event.phase}${event.code ? ':' + event.code : ''}`); } };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }, { toolchainRefresh: { fetcher: f.fetcher, runner: f.runner } });
  try {
    // The service is up while the (gated) build has not finished: readiness never waits for it.
    await until(() => f.builds() === 1); expect(events).toEqual(['started']);
  } finally { await service.stop().catch(() => undefined); f.release(); await service.done.catch(() => undefined); }
  await until(() => events.length === 2);
  expect(events[1]).toBe('failed:REFRESH_STOPPED'); // stopped before the revision: the registry is untouched
  expect(JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).admission.registry.profiles).toHaveLength(1);
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] mode propose starts the service without any background build', async () => {
  const f = await installation({ mode: 'propose' });
  const events: string[] = [];
  const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {}, onToolchainRefresh: event => { events.push(event.phase); } }, { env: f.env },
    { toolchainRefresh: { fetcher: f.fetcher, runner: f.runner } });
  try { await new Promise(resolve => setTimeout(resolve, 300)); expect(f.builds()).toBe(0); expect(events).toEqual([]); }
  finally { await service.stop().catch(() => undefined); f.release(); await service.done.catch(() => undefined); }
  // A refused trigger leaves no trace: not even the product's workspaces directory is created (the gate precedes every write).
  expect(existsSync(join(f.project, 'data', 'workspaces'))).toBe(false);
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] an installation without Docker execution: start and stop leave no refresh trace and no workspaces directory', async () => {
  const f = await installation({}, false);
  const events: string[] = [];
  const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {}, onToolchainRefresh: event => { events.push(event.phase); } }, { env: f.env },
    { toolchainRefresh: { fetcher: f.fetcher, runner: f.runner } });
  await new Promise(resolve => setTimeout(resolve, 300)); // the startup trigger has been evaluated (skipped: no Docker)
  await service.stop(); await service.done;
  expect({ builds: f.builds(), events, workspaces: existsSync(join(f.project, 'data', 'workspaces')) }).toEqual({ builds: 0, events: [], workspaces: false });
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] the service stop waits for the refresh it started: its stopped outcome is recorded before the service is done', async () => {
  const f = await installation({}); f.honorStop();
  const events: string[] = [];
  const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {}, onToolchainRefresh: event => { events.push(`${event.phase}${event.code ? ':' + event.code : ''}`); } },
    { env: f.env }, { toolchainRefresh: { fetcher: f.fetcher, runner: f.runner } });
  try { await until(() => f.builds() === 1); expect(events).toEqual(['started']); }
  finally { await service.stop().catch(() => undefined); await service.done; }
  // No polling: once the service is done (its custody released), the refresh has already settled and written its outcome.
  expect(events).toEqual(['started', 'failed:REFRESH_STOPPED']);
  const state = JSON.parse(await readFile(join(f.project, 'data', 'workspaces', 'toolchains', 'refresh-state.json'), 'utf8')) as { phase: string; reason: string };
  expect({ phase: state.phase, reason: state.reason }).toEqual({ phase: 'failed', reason: 'REFRESH_STOPPED' });
  f.release();
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] a stop during the daemon check ends it too: the service is done without waiting for the check\'s own bound', async () => {
  const f = await installation({}); f.hangPreflight();
  const events: string[] = [];
  const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {}, onToolchainRefresh: event => { events.push(`${event.phase}${event.code ? ':' + event.code : ''}`); } },
    { env: f.env }, { toolchainRefresh: { fetcher: f.fetcher, runner: f.runner } });
  await new Promise(resolve => setTimeout(resolve, 300)); // the startup refresh is waiting on the daemon check (no build was admitted)
  const stoppedAt = Date.now();
  await service.stop().catch(() => undefined); await service.done;
  // Bounded by the stop, not by `buildTimeoutMs` (30 min by default): no `started` (the build was never certain), one stopped outcome.
  expect(Date.now() - stoppedAt).toBeLessThan(5_000);
  expect({ builds: f.builds(), events }).toEqual({ builds: 0, events: ['failed:REFRESH_STOPPED'] });
  f.release();
});
