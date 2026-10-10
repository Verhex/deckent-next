import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { DockerCommandFailure, DockerSupervisor, FileArtifactStore, identifyDockerRequest, type DockerCommandRunner } from '#adapters/index.js';
import { parseRetainedOutputEnvelope, type ReconciliationRecoveryPage } from '#engine/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks, inspectConfiguredRun, recoverConfiguredReconciliation } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { registerConfiguredScopesAtStart } from '../../../src/composition/core/scoped-request/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

const roots: string[] = [], stores: Awaited<ReturnType<typeof openConfiguredAttemptStore>>['store'][] = [];
const loops: { controller: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const loop of loops.splice(0)) { loop.controller.abort(); await loop.done; }
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks(); clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 3000;
  do { const value = await read(); if (value !== undefined) return value; await wait(10); } while (performance.now() < deadline);
  throw new Error(label);
}

/** Simulated Docker command boundary; real profile validation, policy, inventory, SQLite and artifact settlement. */
async function fixture(admit = true) {
  const root = await mkdtemp(join(tmpdir(), 'dk-restart-')); roots.push(root);
  const project = join(root, 'p'), data = join(root, 'd'), configPath = join(project, '.deckent/config.json');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configuration: Record<string, unknown> = { layout: { root: data }, inspection: { maxPageSize: 1 },
    runRuntime: { pageSize: 2, pollIntervalMs: 10, failureBackoffMs: 20 },
    toolchains: { update: { atStartup: false, intervalMs: 0 } } };
  await writeFile(configPath, JSON.stringify(configuration));
  const options = { env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') } };
  const opened = await openConfiguredAttemptStore(project, options); stores.push(opened.store);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), workspace = join(workspaceRoot, 'worker');
  await mkdir(workspace, { mode: 0o700 }); await prepareProductDirectory(opened.layout, 'artifacts');
  const os = userInfo(), request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', 'worker.js'] };
  const docker = { executable: '/usr/bin/docker', workspaceRoot, imageId: 'sha256:' + 'a'.repeat(64), uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
    deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
  const state = { status: 'running', exitCode: 130, daemonId: 'fixture-daemon' }, commands: string[] = [];
  const { handle, digest } = identifyDockerRequest(request, docker);
  const runner: DockerCommandRunner = async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args;
    const operation = args[0]!; commands.push(operation);
    if (operation === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    if (operation === 'info') return { stdout: state.daemonId, stderr: '' };
    if (operation === 'logs') return { stdout: 'retained-output', stderr: 'retained-error' };
    if (operation !== 'inspect') throw new Error('unexpected worker mutation: ' + operation);
    expect(args[1]).toBe(handle);
    if (state.status === 'missing') throw new DockerCommandFailure('', 'Error: No such object: ' + handle, 1, false);
    if (state.status === 'unavailable') throw new DockerCommandFailure('', 'permission denied', 1, false);
    return { stdout: JSON.stringify([{ Id: 'b'.repeat(64), Image: docker.imageId,
      Config: { Labels: { 'deckent.request': digest } }, State: { Status: state.status, ExitCode: state.exitCode } }]), stderr: '' };
  };
  const supervisor = new DockerSupervisor(docker, runner), profile = await supervisor.captureProfile();
  const restore = DockerSupervisor.restoreProfile.bind(DockerSupervisor);
  vi.spyOn(DockerSupervisor, 'restoreProfile').mockImplementation(input => restore(input, runner));
  if (admit) {
    await admitRunAttempts(opened.store, [identity]);
    const claim = { request, owner: 'original-controller' };
    await opened.store.claimDispatch({ ...claim, profile });
    await opened.store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
  }
  const policy = async (attemptActions: string[] = ['reconcile', 'recover-output']) => {
    const principals = [{ issuer: hostname(), subject: String(os.uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants: [
      { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
      { id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
    ] }), { mode: 0o600 });
  };
  await policy();
  const scopes = await registerConfiguredScopesAtStart(await loadConfig(project, options));
  return { ...opened, project, data, options, identity, request, state, commands, policy, configuration, configPath,
    scopeIds: scopes!.policyScopeIds, supervisor, profile, docker };
}

async function start(f: Awaited<ReturnType<typeof fixture>>, scopeIds = f.scopeIds) {
  const pages: ReconciliationRecoveryPage[] = [], errors: string[] = [], observedScopes: string[] = [];
  const prepared = await prepareConfiguredReconciliationRuntime(f.project, {
    onPage(command, page) { observedScopes.push(command.scopeId); pages.push(page); },
    onError(command, error) { observedScopes.push(command.scopeId); errors.push(error.code); },
  }, f.options, scopeIds);
  const controller = new AbortController(), done = prepared.run(controller.signal); loops.push({ controller, done });
  return { pages, errors, observedScopes, async stop() { controller.abort(); await done; } };
}

it.skipIf(process.platform === 'win32')('reconciles exit 130 within a bounded first page after restarting recovery without reconciliationRuntime', async () => {
  const f = await fixture(), before = await start(f);
  await poll(async () => before.pages.length ? true : undefined, 'FIRST_PAGE_TIMEOUT');
  expect(before.pages[0]!.outcomes[0]!.status).toBe('unresolved');
  await before.stop(); f.state.status = 'exited';
  const restartedAt = performance.now(), restarted = await start(f);
  await poll(async () => (await f.store.readDispatch(f.request))?.output ? true : undefined, 'RESTART_RECONCILIATION_TIMEOUT');
  expect(performance.now() - restartedAt).toBeLessThan(3000);
  await restarted.stop();
  const record = (await f.store.readDispatch(f.request))!;
  expect(record).toMatchObject({ owner: 'original-controller', launch: 'granted', terminal: { exitCode: 130, interrupted: null } });
  expect((await f.store.load('s', 'a'))?.lastObservation?.result).toEqual({ kind: 'exited', exitCode: 130 });
  expect((await f.store.loadRun('s', 'r'))?.progress[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
  const artifacts = new FileArtifactStore({ root: join(f.data, 'artifacts'), maxBytes: 16777216 });
  expect(parseRetainedOutputEnvelope(await artifacts.read('s', record.output!), f.identity)).toMatchObject({
    completeness: 'partial', stdout: 'retained-output', stderr: 'retained-error' });
  expect(restarted.errors).toEqual([]);
  expect(f.commands.every(command => ['context', 'info', 'inspect', 'logs'].includes(command))).toBe(true);
  const revision = (await f.store.load('s', 'a'))!.revision;
  await recoverConfiguredReconciliation(f.project, { schemaVersion: 1, scopeId: 's', after: null }, f.options, f.scopeIds);
  expect((await f.store.load('s', 'a'))!.revision).toBe(revision);
});

it.skipIf(process.platform === 'win32').each(['missing', 'unavailable', 'running', 'created'])('preserves uncertain effects, dispatch fence and occupied slot for %s without retry or guessed exit', async status => {
  const f = await fixture(); f.state.status = status;
  const before = { dispatch: await f.store.readDispatch(f.request), attempt: await f.store.load('s', 'a'), run: await f.store.loadRun('s', 'r') };
  const recovery = await start(f);
  await poll(async () => recovery.pages.length ? true : undefined, 'UNCERTAIN_PAGE_TIMEOUT'); await recovery.stop();
  expect({ dispatch: await f.store.readDispatch(f.request), attempt: await f.store.load('s', 'a'), run: await f.store.loadRun('s', 'r') }).toEqual(before);
  const view = await inspectConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
  expect(view.run?.pool?.occupancy).toEqual({ execution: 1, inFlight: 1 });
  expect(recovery.pages[0]!.outcomes[0]).toMatchObject(status === 'unavailable'
    ? { status: 'failed', reason: 'unavailable' } : { status: 'unresolved' });
  expect(f.commands).not.toContain('logs');
});

it.skipIf(process.platform === 'win32')('requires fresh reconcile policy before contacting the recorded worker', async () => {
  const f = await fixture(); f.state.status = 'exited'; await f.policy(['recover-output']);
  const before = await f.store.readDispatch(f.request), commands = [...f.commands], recovery = await start(f);
  await poll(async () => recovery.pages.length ? true : undefined, 'DENIED_PAGE_TIMEOUT'); await recovery.stop();
  expect(recovery.pages[0]!.outcomes[0]).toMatchObject({ status: 'failed', reason: 'denied' });
  expect(f.commands).toEqual(commands); expect(await f.store.readDispatch(f.request)).toEqual(before);
});

it.skipIf(process.platform === 'win32')('keeps terminal settlement when output recovery is denied and never invents complete output', async () => {
  const f = await fixture(); f.state.status = 'exited'; await f.policy(['reconcile']); const recovery = await start(f);
  await poll(async () => recovery.pages.length ? true : undefined, 'OUTPUT_DENIED_PAGE_TIMEOUT'); await recovery.stop();
  expect(recovery.pages[0]!.outcomes[0]).toMatchObject({ status: 'failed', reason: 'denied' });
  expect(await f.store.readDispatch(f.request)).toMatchObject({ terminal: { exitCode: 130 } });
  expect((await f.store.readDispatch(f.request))?.output).toBeUndefined(); expect(f.commands).not.toContain('logs');
});

it.skipIf(process.platform === 'win32')('keeps explicit reconciliation scopes ahead of service fallback and does not inherit cancellation scopes', async () => {
  const f = await fixture(); f.state.status = 'exited';
  f.configuration.reconciliationRuntime = { scopeIds: ['other'], pageSize: 1, maxConcurrentReconciliations: 1, pollIntervalMs: 10, failureBackoffMs: 20 };
  f.configuration.cancellationRuntime = { scopeIds: ['s'], pollIntervalMs: 10, failureBackoffMs: 20 };
  await writeFile(f.configPath, JSON.stringify(f.configuration)); clearConfigCache();
  const before = await f.store.readDispatch(f.request), commands = [...f.commands], recovery = await start(f);
  await poll(async () => recovery.errors.length ? true : undefined, 'SCOPE_DENIED_TIMEOUT'); await recovery.stop();
  expect(f.commands).toEqual(commands); expect(await f.store.readDispatch(f.request)).toEqual(before);
  await expect(recoverConfiguredReconciliation(f.project, { schemaVersion: 1, scopeId: 's', after: null }, f.options, f.scopeIds)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it.skipIf(process.platform === 'win32')('retains manual configuration refusal and performs no recovery for an installation with no owned scopes', async () => {
  const f = await fixture(), commands = [...f.commands];
  await expect(prepareConfiguredReconciliationRuntime(f.project, { onPage() {}, onError() {} }, f.options)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_CONFIGURED' });
  await expect(recoverConfiguredReconciliation(f.project, { schemaVersion: 1, scopeId: 's', after: null }, f.options)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_CONFIGURED' });
  const recovery = await start(f, []); await recovery.stop(); expect(recovery.pages).toEqual([]); expect(f.commands).toEqual(commands);
});

it.skipIf(process.platform === 'win32')('excludes cancellation-only registrations from automatic recovery unless trusted policy independently declares the scope', async () => {
  const f = await fixture();
  f.configuration.cancellationRuntime = { scopeIds: ['cancellation-only'], pollIntervalMs: 10, failureBackoffMs: 20 };
  await writeFile(f.configPath, JSON.stringify(f.configuration)); clearConfigCache();
  const scopes = await registerConfiguredScopesAtStart(await loadConfig(f.project, f.options));
  expect(scopes!.pins.has('cancellation-only')).toBe(true);
  const recovery = await start(f, scopes!.policyScopeIds);
  await poll(async () => recovery.pages.length ? true : undefined, 'DEFAULT_SCOPE_TIMEOUT'); await recovery.stop();
  expect(recovery.observedScopes).toEqual(['s']); expect(recovery.errors).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('settles a supervisor-observed exit while execute is still waiting, without a service recovery loop or a duplicate transition', async () => {
  const f = await fixture(false), exec = promisify(execFile);
  const git = (...args: string[]) => exec('/usr/bin/git', ['-C', f.project, ...args]);
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await writeFile(join(f.project, 'input'), 'base'); await git('add', 'input'); await git('commit', '-m', 'fixture');
  f.configuration.admission = { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: fixtureDockerRegistry(['observed']) };
  const dockerConfig = Object.fromEntries(Object.entries(f.docker).filter(([key]) => !['workspaceRoot', 'uid', 'gid'].includes(key)));
  f.configuration.execution = { docker: { ...dockerConfig, controlTimeoutMs: 10000, deadlineMs: 20000 },
    git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 } };
  f.configuration.inspection = { maxPageSize: 1, workers: { heartbeatMs: 100 } };
  await writeFile(f.configPath, JSON.stringify(f.configuration)); clearConfigCache();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(f.data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'observe-policy', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'reconcile'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  await f.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'observed', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Observe exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [130] } }] };
  await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, f.options);
  const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
  let release!: () => void, executed = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(DockerSupervisor.prototype, 'captureProfile').mockResolvedValue(f.profile);
  vi.spyOn(DockerSupervisor.prototype, 'inspectActivity').mockImplementation(async request => ({ handle: identifyDockerRequest(request, f.docker).handle, state: 'exited' }));
  const observe = vi.spyOn(DockerSupervisor.prototype, 'observe').mockImplementation(async request => ({ handle: identifyDockerRequest(request, f.docker).handle, result: { kind: 'exited', exitCode: 130 } }));
  const execute = vi.spyOn(DockerSupervisor.prototype, 'execute').mockImplementation(async request => {
    executed = true; await pending;
    return { handle: identifyDockerRequest(request, f.docker).handle, result: { kind: 'exited', exitCode: 130 },
      stdout: 'worker-output', stderr: '', interrupted: false, outputCompleteness: 'complete' };
  });
  const work = executeConfiguredTask(f.project, identity, f.options);
  try {
    await poll(async () => (await f.store.loadBoundDispatch(identity))?.terminal ? true : undefined, 'SUPERVISOR_SETTLEMENT_TIMEOUT');
    expect(executed).toBe(true); expect(observe).toHaveBeenCalledTimes(1);
    const revision = (await f.store.load('s', identity.attemptId))!.revision;
    expect((await f.store.loadRun('s', 'r'))?.progress[0]).toMatchObject({ phase: 'evaluating', unresolvedEffects: false });
    release(); expect((await work).execution.status).toBe('terminal');
    expect((await f.store.load('s', identity.attemptId))!.revision).toBe(revision); expect(execute).toHaveBeenCalledTimes(1);
  } finally { release(); await work; }
});
