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

async function installation(update: Record<string, unknown>) {
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
  let builds = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const runner: WorkerImageBuildRunner = async command => {
    if (command.args[1] === '--check-version') return ok(command.requestId);
    builds++; await gate;
    const recipe = JSON.parse(await readFile(join(command.cwd, 'recipe.json'), 'utf8')) as { imageVersion: string; repository: string };
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 2, imageId: 'sha256:' + 'b'.repeat(64), imageVersion: recipe.imageVersion, tag: `${recipe.repository}:${recipe.imageVersion}`,
      manifest: { providers: [{ id: 'codex', version: 'codex-cli 0.156.0' }, { id: 'claude', version: '2.1.278 (Claude Code)' }, { id: 'cursor', version: '2026.09.18-9a7762b' }] } }));
    return ok(command.requestId);
  };
  const fetcher = async (request: { package: string }) => ({ version: request.package === '@openai/codex' ? '0.156.0' : '2.1.278', source: 'fixture', observedAt: new Date().toISOString() });
  return { project, env: { HOME: join(project, 'home') }, runner, fetcher, release, builds: () => builds };
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
});
