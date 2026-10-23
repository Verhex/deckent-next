import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache, inspectProductFile, jsonRecordDirectory, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { DockerCommandFailure, DockerSupervisor, identifyDockerRequest, type DockerCommandRunner } from '#adapters/index.js';
import { DispatchPreparationGuard, type ReconciliationRecoveryPage } from '#engine/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { registerConfiguredScopesAtStart } from '../../../src/composition/core/scoped-request/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

// S6R-2 shadow mode over the real reconciliation loop (simulated Docker command boundary; real config, policy, inventory, SQLite and audit):
// the detector reads existing signals and seals `recovery-detection` rows; nothing else changes and no worker is touched. Default off.
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
/** A process id that existed and has ended (the launcher that died). */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

async function fixture(nervous: Record<string, unknown> | undefined, status: string, launcherPid = deadPid()) {
  const root = await mkdtemp(join(tmpdir(), 'dk-nervous-')); roots.push(root);
  const project = join(root, 'p'), data = join(root, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4 },
    runRuntime: { pageSize: 4, pollIntervalMs: 10, failureBackoffMs: 20, ...(nervous ? { nervous } : {}) }, toolchains: { update: { atStartup: false, intervalMs: 0 } } }));
  const options = { env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') } };
  const opened = await openConfiguredAttemptStore(project, options); stores.push(opened.store);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), workspace = join(workspaceRoot, 'worker');
  await mkdir(workspace, { mode: 0o700 }); await prepareProductDirectory(opened.layout, 'artifacts');
  const os = userInfo(), request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', 'worker.js'] };
  const docker = { executable: '/usr/bin/docker', workspaceRoot, imageId: 'sha256:' + 'a'.repeat(64), uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
  const commands: string[] = [], { handle, digest } = identifyDockerRequest(request, docker);
  const runner: DockerCommandRunner = async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args, operation = args[0]!; commands.push(operation);
    if (operation === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    if (operation === 'info') return { stdout: 'fixture-daemon', stderr: '' };
    if (operation !== 'inspect') throw new Error('unexpected worker mutation: ' + operation);
    if (status === 'missing') throw new DockerCommandFailure('', 'Error: No such object: ' + handle, 1, false);
    return { stdout: JSON.stringify([{ Id: 'b'.repeat(64), Image: docker.imageId, Config: { Labels: { 'deckent.request': digest } }, State: { Status: status, ExitCode: 0 } }]), stderr: '' };
  };
  const supervisor = new DockerSupervisor(docker, runner), profile = await supervisor.captureProfile();
  const restore = DockerSupervisor.restoreProfile.bind(DockerSupervisor);
  vi.spyOn(DockerSupervisor, 'restoreProfile').mockImplementation(input => restore(input, runner));
  await admitRunAttempts(opened.store, [identity]);
  const claim = { request, owner: 'original-controller' };
  await opened.store.claimDispatch({ ...claim, profile });
  await opened.store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
  // The launcher's preparation record, left at `dispatch` by a process that died while its worker ran (S6R-1 F6 evidence).
  const crashes = await prepareProductDirectory(opened.layout, 'crashes');
  const guard = new DispatchPreparationGuard(jsonRecordDirectory(join(crashes, 'dispatch-preparation')), { identity, principal: { issuer: 'host', subject: '1' }, policyRevision: 'p',
    bound: 2, now: () => 5, instance: { id: '00000000-0000-4000-8000-000000000001', pid: launcherPid, startedAt: 1 }, launchers: jsonRecordDirectory(join(crashes, 'dispatch-launcher')),
    record: async () => undefined, parked: async () => false, loadRun: async () => null, park: async () => undefined });
  await guard.begin((await opened.store.loadRun('s', 'r'))!); await guard.enter('dispatch');
  const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'attempt', effect: 'allow', actions: ['reconcile', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
  ] }), { mode: 0o600 });
  const scopes = await registerConfiguredScopesAtStart(await loadConfig(project, options));
  const pages: ReconciliationRecoveryPage[] = [], errors: string[] = [];
  const prepared = await prepareConfiguredReconciliationRuntime(project, { onPage(_command, page) { pages.push(page); }, onError(_command, error) { errors.push(error.code); } },
    options, scopes!.policyScopeIds);
  const controller = new AbortController(), done = prepared.run(controller.signal); loops.push({ controller, done });
  const ledger = await inspectProductFile(opened.layout, 'ledger', ['-wal', '-shm', '-journal']);
  const detections = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return (db.prepare("SELECT record FROM audit_events WHERE kind='recovery-detection' ORDER BY sequence").all() as { record: string }[]).map(row => JSON.parse(row.record).event);
  } finally { db.close(); } };
  const state = async () => ({ dispatch: await opened.store.readDispatch(request), attempt: await opened.store.load('s', 'a'), run: await opened.store.loadRun('s', 'r') });
  return { pages, errors, commands, detections, state, before: await state(), async stop() { controller.abort(); await done; } };
}

it.skipIf(process.platform === 'win32')('is off by default: reconciliation pages run and no detection is recorded', async () => {
  const f = await fixture(undefined, 'running');
  await poll(async () => f.pages.length >= 3 ? true : undefined, 'PAGES_TIMEOUT'); await f.stop();
  expect(f.detections()).toEqual([]); expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32').each([
  ['running', 'launcher-dead-orphan', 'stop-orphan'],
  ['missing', 'launcher-dead-gone', 'fence-attempt'],
])('shadow: a %s worker of a dead launcher is sealed once as %s (%s) and nothing else changes', async (status, ruleId, action) => {
  const f = await fixture({ mode: 'shadow' }, status);
  await poll(async () => f.detections().length && f.pages.length >= 4 ? true : undefined, 'DETECTION_TIMEOUT'); await f.stop();
  const rows = f.detections();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scopeId: 's', principal: { issuer: `${hostname()}/nervous` },
    subject: { kind: 'recovery-detection', rule: { id: ruleId, status: 'provisional' }, action, disposition: 'shadow-only',
      target: { runId: 'r', taskId: 't', attemptId: 'a', generation: 1 }, evidence: { launcher: 'dead', launcherPhase: 'dispatch' } } });
  // No fence, release, new Attempt or cancellation: the ledger state is exactly as before and Docker saw reads only.
  expect(await f.state()).toEqual(f.before);
  expect(f.commands.every(command => ['context', 'info', 'inspect'].includes(command))).toBe(true);
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('shadow: a running worker whose launcher (another instance) is alive is never a case', async () => {
  const f = await fixture({ mode: 'shadow' }, 'running', process.ppid);
  await poll(async () => f.pages.length >= 6 ? true : undefined, 'PAGES_TIMEOUT'); await f.stop();
  expect(f.detections()).toEqual([]); expect(f.errors).toEqual([]); expect(await f.state()).toEqual(f.before);
});
