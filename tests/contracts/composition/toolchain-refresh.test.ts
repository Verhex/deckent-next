import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareNativeCodingProfile } from '../../../src/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { inspectToolchainRefresh, isToolchainRefreshInProgress, readToolchainRefreshState, refreshConfiguredToolchains, startToolchainRefresh,
  type ToolchainRefreshEvent } from '#composition/core/toolchains/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { clearConfigCache, getConfigFieldDefault, loadConfig, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import type { WorkerImageBuildRunner } from '#adapters/index.js';

beforeEach(context => { if (process.platform !== 'linux') context.skip('configured policy/integrity flows need a verified POSIX UID'); });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bounds = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const nativeProfile = (id: string, provider: 'codex' | 'claude', cliVersion: string) => structuredClone(prepareNativeCodingProfile({ schemaVersion: 1,
  template: { id, version: 1, adapter: { id: 'docker', version: 2 }, parameters: { ...bounds, argv: ['unused'] } },
  invocation: { schemaVersion: 2, provider, cliVersion, discovery: { schemaVersion: 1, mode: provider === 'claude' ? 'disabled' : 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'fixture task' } }).profile);
const ok = (requestId: string) => ({ schemaVersion: 1 as const, requestId, started: true, reason: 'exit' as const, exitCode: 0, signal: null, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 });

/** A real policy/ledger installation (config writes are governed), a stale codex pin, and a fake builder; Docker is never reached. */
async function fixture(update: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-refresh-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin' } };
  await applyPolicyTemplateInstallation(root, 'installation');
  openSqliteLedger(await prepareProductFile(resolveProductLayout({ projectRoot: root }), 'ledger', ['-wal', '-shm', '-journal']), getConfigFieldDefault('storage').sqlite).close();
  const profiles = [nativeProfile('codex-pinned', 'codex', 'codex-cli 0.155.1'), nativeProfile('claude-pinned', 'claude', '2.1.278 (Claude Code)')];
  const path = join(root, '.deckent/config.json'); await mkdir(join(root, '.deckent'), { recursive: true });
  const existing = (() => { try { return {}; } catch { return {}; } })();
  await writeFile(path, JSON.stringify({ ...existing, execution: { docker: { executable: 'docker', imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 2147483648, pids: 128, cpus: 2, logMaxSizeKiB: 1024, logMaxFiles: 2, tmpBytes: 1048576, deadlineMs: 60000, controlTimeoutMs: 5000, outputBytes: 65536 }, git: { gitExecutable: 'git', timeoutMs: 5000 } },
    service: { identity: { scopeId: 'installation', serviceId: 'refresh-service' } }, toolchains: { currency: { registryEndpoint: 'http://127.0.0.1:1' }, update },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'r', profiles,
      kinds: profiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: profile.version } })), evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } } }));
  const latest: Record<string, string> = { '@openai/codex': '0.156.0', '@anthropic-ai/claude-code': '2.1.278' };
  const fetcher = async (request: { package: string }) => ({ version: latest[request.package]!, source: `fixture/${request.package}`, observedAt: new Date().toISOString() });
  const state = { builds: 0, failFirst: 0, gate: null as Promise<void> | null };
  const runner: WorkerImageBuildRunner = async command => {
    if (command.args[1] === '--check-version') return ok(command.requestId);
    state.builds++;
    if (state.gate) await state.gate;
    if (state.failFirst > 0) { state.failFirst--; return { ...ok(command.requestId), exitCode: 1, stderrBase64: Buffer.from('Error: WORKER_IMAGE_BUILD_FAILED fixture').toString('base64') }; }
    const recipe = JSON.parse(await readFile(join(command.cwd, 'recipe.json'), 'utf8')) as { imageVersion: string; repository: string };
    await writeFile(command.args[1]!, JSON.stringify({ schemaVersion: 2, imageId: 'sha256:' + 'b'.repeat(64), imageVersion: recipe.imageVersion, tag: `${recipe.repository}:${recipe.imageVersion}`,
      manifest: { providers: [{ id: 'codex', version: 'codex-cli 0.156.0' }, { id: 'claude', version: '2.1.278 (Claude Code)' }, { id: 'cursor', version: '2026.09.18-9a7762b' }] } }));
    return ok(command.requestId);
  };
  const events: ToolchainRefreshEvent[] = [];
  const observer = { onToolchainRefresh: (event: ToolchainRefreshEvent) => { events.push(event); } };
  const registry = async () => JSON.parse(await readFile(path, 'utf8')).admission.registry as { revision: string; profiles: { id: string; version: number; parameters: { imageId: string; nativeSubscription: { preflight: { cliVersion: string } } } }[]; kinds: { kind: string; profile: { id: string; version: number } }[] };
  return { root, path, options, fetcher, runner, state, events, observer, latest, registry, deps: { fetcher, runner, now: () => new Date().toISOString() } };
}
const settle = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('condition not reached'); };

describe('autonomous worker image refresh (WORKER-AUTO-REFRESH)', () => {
  it('a stale install starts the refresh in the background without delaying the caller, then revises only the active profile version', async () => {
    const f = await fixture(); let release!: () => void; f.state.gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const before = Date.now();
    const handle = startToolchainRefresh(f.root, f.options, f.observer, controller.signal, f.deps);
    expect(Date.now() - before).toBeLessThan(500); // returns at once: the build is gated and has not finished
    await settle(() => f.state.builds === 1);
    expect(await isToolchainRefreshInProgress(f.root, f.options)).toBe(true);
    expect(await inspectToolchainRefresh(f.root, f.options)).toMatchObject({ status: 'updating' });
    expect((await f.registry()).profiles).toHaveLength(2); // nothing is revised while the build runs
    release(); await settle(() => f.events.some(event => event.phase === 'current')); controller.abort(); await handle.done;
    expect(f.events.map(event => event.phase)).toEqual(['started', 'current']);
    const registry = await f.registry();
    expect(registry.revision).toMatch(/^r@r5-/);
    expect(registry.profiles.map(profile => `${profile.id}@${profile.version}`).sort()).toEqual(['claude-pinned@1', 'codex-pinned@1', 'codex-pinned@2']);
    expect(registry.kinds.find(kind => kind.kind === 'codex-pinned')!.profile).toEqual({ id: 'codex-pinned', version: 2 });
    expect(registry.kinds.find(kind => kind.kind === 'claude-pinned')!.profile).toEqual({ id: 'claude-pinned', version: 1 });
    const v1 = registry.profiles.find(profile => profile.id === 'codex-pinned' && profile.version === 1)!, v2 = registry.profiles.find(profile => profile.id === 'codex-pinned' && profile.version === 2)!;
    expect(v1.parameters.imageId).toBe(bounds.imageId); // the admitted-Run version keeps its image
    expect(v2.parameters).toMatchObject({ imageId: 'sha256:' + 'b'.repeat(64), nativeSubscription: { preflight: { cliVersion: 'codex-cli 0.156.0' } } });
    expect(await isToolchainRefreshInProgress(f.root, f.options)).toBe(false);
    expect(await readToolchainRefreshState(f.root, f.options)).toMatchObject({ phase: 'current', appliedProfiles: 1, imageId: 'sha256:' + 'b'.repeat(64), reason: null });
    const home = join(f.root, '.deckent'); void home;
    const config = await loadConfig(f.root, f.options); expect(config.admission).not.toBeNull();
    // A receipt and an audit record exist for the build.
    const toolchains = (await readdir(join(f.root, '.deckent'), { recursive: true })).filter(name => name.includes('toolchains/'));
    expect(toolchains.some(name => name.includes('receipts/'))).toBe(true); expect(toolchains.some(name => name.includes('refreshes/'))).toBe(true);
  });

  it('a second refresh of an already refreshed install builds nothing new and leaves the registry unchanged', async () => {
    const f = await fixture();
    await refreshConfiguredToolchains(f.root, 'startup', f.options, f.deps, f.observer);
    const after = await f.registry(); f.state.builds = 0; f.latest['@openai/codex'] = '0.156.0';
    const second = await refreshConfiguredToolchains(f.root, 'interval', f.options, f.deps, f.observer);
    expect(second.outcome).toBe('current'); expect(f.state.builds).toBe(0); expect(await f.registry()).toEqual(after);
  });

  it('concurrent triggers join one build', async () => {
    const f = await fixture(); let release!: () => void; f.state.gate = new Promise<void>(resolve => { release = resolve; });
    const a = refreshConfiguredToolchains(f.root, 'startup', f.options, f.deps, f.observer), b = refreshConfiguredToolchains(f.root, 'interval', f.options, f.deps, f.observer);
    await settle(() => f.state.builds === 1); release(); await Promise.all([a, b]);
    expect(f.state.builds).toBe(1); expect(f.events.filter(event => event.phase === 'started')).toHaveLength(1);
  });

  it('a failed build keeps the previous registry and image, emits a typed failure with an audit record, and the next period retries', async () => {
    const f = await fixture({ intervalMs: 40 }); f.state.failFirst = 1;
    const registryBefore = await f.registry();
    const controller = new AbortController(); const handle = startToolchainRefresh(f.root, f.options, f.observer, controller.signal, f.deps);
    await settle(() => f.events.some(event => event.phase === 'failed'));
    const failed = f.events.find(event => event.phase === 'failed')!;
    expect(failed.code).toEqual(expect.any(String)); expect(failed.code).not.toBeNull();
    expect(await f.registry()).toEqual(registryBefore);
    expect((await readToolchainRefreshState(f.root, f.options))?.phase === 'failed' || f.events.some(event => event.phase === 'current')).toBe(true);
    await settle(() => f.events.some(event => event.phase === 'current')); // the next period retried and succeeded
    controller.abort(); await handle.done;
    expect(f.state.builds).toBeGreaterThanOrEqual(2);
    expect((await f.registry()).profiles).toHaveLength(3);
  });

  it('records the failed state while the failure stands', async () => {
    const f = await fixture(); f.state.failFirst = 1;
    const outcome = await refreshConfiguredToolchains(f.root, 'startup', f.options, f.deps, f.observer);
    expect(outcome.outcome).toBe('failed');
    expect(await inspectToolchainRefresh(f.root, f.options)).toMatchObject({ status: 'failed', reason: expect.any(String) });
    expect(await isToolchainRefreshInProgress(f.root, f.options)).toBe(false);
    const audits = (await readdir(join(f.root, '.deckent'), { recursive: true })).filter(name => name.includes('refreshes/'));
    expect(audits).toHaveLength(1);
  });

  it.each([['off', {}], ['propose', {}], ['auto', { atStartup: false, intervalMs: 0 }]])('mode %s with these settings never starts a build', async (mode, extra) => {
    const f = await fixture({ mode, ...extra });
    const controller = new AbortController(); const handle = startToolchainRefresh(f.root, f.options, f.observer, controller.signal, f.deps);
    await handle.done.then(() => undefined); controller.abort();
    expect(f.state.builds).toBe(0); expect(f.events).toEqual([]); expect(await readToolchainRefreshState(f.root, f.options)).toBeNull();
  });

  it('atStartup=false with a positive interval waits for the interval; stopping the service cancels the timer', async () => {
    const f = await fixture({ atStartup: false, intervalMs: 60_000 });
    const controller = new AbortController(); const handle = startToolchainRefresh(f.root, f.options, f.observer, controller.signal, f.deps);
    await new Promise(resolve => setTimeout(resolve, 100)); expect(f.state.builds).toBe(0);
    controller.abort(); await handle.done; // resolves at once: the 24h-class timer does not keep the loop alive
    expect(f.state.builds).toBe(0);
  });

  it('after the service stops, a refresh that was already building does not write the registry', async () => {
    const f = await fixture(); let release!: () => void; f.state.gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController(); const handle = startToolchainRefresh(f.root, f.options, f.observer, controller.signal, f.deps);
    const registryBefore = await f.registry();
    await settle(() => f.state.builds === 1); controller.abort(); release(); await handle.done;
    expect(await f.registry()).toEqual(registryBefore);
    expect(f.events.at(-1)).toMatchObject({ phase: 'failed', code: 'REFRESH_STOPPED' });
  });

  it('an updating marker past its bound no longer counts as in flight', async () => {
    const f = await fixture();
    const home = join(f.root, '.deckent'); void home;
    const outcome = await refreshConfiguredToolchains(f.root, 'startup', f.options, f.deps, f.observer); expect(outcome.outcome).toBe('current');
    const state = await readToolchainRefreshState(f.root, f.options); expect(state).not.toBeNull();
    const files = (await readdir(join(f.root, '.deckent'), { recursive: true })).filter(name => name.endsWith('refresh-state.json'));
    expect(files).toHaveLength(1);
    const path = join(f.root, '.deckent', files[0]!);
    await writeFile(path, JSON.stringify({ ...state, phase: 'updating', finishedAt: null, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(await isToolchainRefreshInProgress(f.root, f.options)).toBe(false);
    expect(await inspectToolchainRefresh(f.root, f.options)).toMatchObject({ status: 'failed', reason: 'REFRESH_EXPIRED' });
  });

  it('an unreachable registry is reported unverified, never current, and never marks an update in flight', async () => {
    const f = await fixture();
    const outcome = await refreshConfiguredToolchains(f.root, 'startup', f.options, { ...f.deps, fetcher: async () => { throw new Error('offline'); } }, f.observer);
    expect(outcome.outcome).toBe('unverified'); expect(f.state.builds).toBe(0);
    expect(f.events.map(event => event.phase)).toEqual(['unverified']); expect(f.events[0]!.code).toEqual(expect.any(String));
    expect(await isToolchainRefreshInProgress(f.root, f.options)).toBe(false);
    expect(await inspectToolchainRefresh(f.root, f.options)).toMatchObject({ status: 'unknown' });
  });
  it('an installation without Docker execution is never touched', async () => {
    const f = await fixture(); const config = JSON.parse(await readFile(f.path, 'utf8')); delete config.execution; await writeFile(f.path, JSON.stringify(config));
    expect((await refreshConfiguredToolchains(f.root, 'startup', f.options, f.deps, f.observer)).outcome).toBe('skipped');
    expect(f.state.builds).toBe(0); expect(await readToolchainRefreshState(f.root, f.options)).toBeNull();
  });
});
