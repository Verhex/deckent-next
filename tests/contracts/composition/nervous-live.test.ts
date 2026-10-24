import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { clearConfigCache, inspectProductFile, jsonRecordDirectory, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { DockerCommandFailure, DockerSupervisor, identifyDockerRequest, type DockerCommandRunner } from '#adapters/index.js';
import { AuditApplication, DispatchPreparationGuard, RecoveryApplication, nervousCaseId, recoveryContinuationApproval } from '#engine/index.js';
import { RECOVERY_POLICY_SEED, freezeRecoveryPolicy, loadRecoveryPolicy, recoveryPrincipal } from '#domain/index.js';
import { openLocalIntegrityAuthority, openSqliteAuditStore, openSqliteRecoveryStore } from '#adapters/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { prepareConfiguredReconciliationRuntime } from '../../../src/composition/core/runtime/index.js';
import { registerConfiguredScopesAtStart } from '../../../src/composition/core/scoped-request/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyPrincipal } from '../support/custody.js';

// S6R-3 live over the real reconciliation loop (simulated Docker command boundary; real config, policy, inventory, SQLite and audit). The
// seed registry is provisional; this file promotes every rule to `live` the way a measured registry would, so the live chain can be seen.
vi.mock('#engine/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#engine/index.js')>(), seed = actual.NERVOUS_RULES_SEED as { rules: object[] };
  return { ...actual, NERVOUS_RULES_SEED: { ...seed, rules: seed.rules.map(rule => ({ ...rule, status: 'live' })) } };
});
const roots: string[] = [], stores: Awaited<ReturnType<typeof openConfiguredAttemptStore>>['store'][] = [];
const loops: { controller: AbortController; done: Promise<void> }[] = [];
afterEach(async () => {
  for (const loop of loops.splice(0)) { loop.controller.abort(); await loop.done; }
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks(); clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function poll<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 5000;
  do { const value = await read(); if (value !== undefined) return value; await wait(10); } while (performance.now() < deadline);
  throw new Error(label);
}
const containerId = 'b'.repeat(64), startedAt = '2026-10-23T10:00:00.000000000Z';
type Retained = 'incarnation' | 'container' | 'none';

async function fixture(input: { status: 'running' | 'missing' | 'created'; retained: Retained; standing?: boolean; lostKills?: number; recovery?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'dk-nervous-live-')); roots.push(root);
  const project = join(root, 'p'), data = join(root, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, inspection: { maxPageSize: 4 },
    runRuntime: { pageSize: 4, pollIntervalMs: 10, failureBackoffMs: 20, nervous: { mode: 'live' } }, toolchains: { update: { atStartup: false, intervalMs: 0 } } }));
  const options = { env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') } };
  const opened = await openConfiguredAttemptStore(project, options); stores.push(opened.store);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const workspaceRoot = await prepareProductDirectory(opened.layout, 'workspaces'), workspace = join(workspaceRoot, 'worker');
  await mkdir(workspace, { mode: 0o700 }); await prepareProductDirectory(opened.layout, 'artifacts');
  const os = userInfo(), request = { protocolVersion: 1 as const, identity, workspace, argv: ['node', 'worker.js'] };
  const docker = { executable: '/usr/bin/docker', workspaceRoot, imageId: 'sha256:' + 'a'.repeat(64), uid: os.uid, gid: os.gid,
    memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 10000, controlTimeoutMs: 1000, outputBytes: 65536 };
  const commands: string[] = [], { handle, digest } = identifyDockerRequest(request, docker), container = { status: input.status as string, lostKills: input.lostKills ?? 0 };
  const runner: DockerCommandRunner = async command => {
    const args = command.args[0] === '--host' ? command.args.slice(2) : command.args, operation = args[0]!; commands.push(operation);
    if (operation === 'context') return { stdout: JSON.stringify({ Host: 'unix:///fixture.sock' }), stderr: '' };
    if (operation === 'info') return { stdout: 'fixture-daemon', stderr: '' };
    if (operation === 'kill' && container.status === 'running') { if (container.lostKills-- <= 0) container.status = 'exited'; return { stdout: handle, stderr: '' }; }
    // S6R-4 (lead on s6r3 Q3): only a never-started container, by its exact created id and never forced, may be removed.
    if (operation === 'rm' && container.status === 'created' && args.length === 2 && args[1] === containerId) { container.status = 'missing'; return { stdout: containerId, stderr: '' }; }
    if (operation !== 'inspect') throw new Error('unexpected worker mutation: ' + operation);
    if (container.status === 'missing' || ![handle, containerId].includes(args[1]!)) throw new DockerCommandFailure('', 'Error: No such object: ' + args[1], 1, false);
    return { stdout: JSON.stringify([{ Id: containerId, Image: docker.imageId, Config: { Labels: { 'deckent.request': digest } },
      State: { Status: container.status, ExitCode: container.status === 'exited' ? 137 : 0, StartedAt: container.status === 'created' ? '0001-01-01T00:00:00Z' : startedAt, FinishedAt: container.status === 'exited' ? '2026-10-23T10:01:00Z' : '0001-01-01T00:00:00Z' } }]), stderr: '' };
  };
  const supervisor = new DockerSupervisor(docker, runner), profile = await supervisor.captureProfile();
  const restore = DockerSupervisor.restoreProfile.bind(DockerSupervisor);
  vi.spyOn(DockerSupervisor, 'restoreProfile').mockImplementation(profileInput => restore(profileInput, runner));
  await admitRunAttempts(opened.store, [identity], input.recovery ? { recovery: freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), 'live', ['t']) } : {});
  const claim = { request, owner: 'original-controller' };
  await opened.store.claimDispatch({ ...claim, profile });
  await opened.store.grantLaunch({ claim, principal: custodyPrincipal, now: 1 });
  if (input.retained !== 'none') await opened.store.retainDispatchContainer(claim, containerId);
  if (input.retained === 'incarnation') await opened.store.retainDispatchWorker(claim, { kind: 'container', id: containerId, startedAt });
  const crashes = await prepareProductDirectory(opened.layout, 'crashes');
  const guard = new DispatchPreparationGuard(jsonRecordDirectory(join(crashes, 'dispatch-preparation')), { identity, principal: { issuer: 'host', subject: '1' }, policyRevision: 'p',
    bound: 2, now: () => 5, instance: { id: '00000000-0000-4000-8000-000000000001', pid: spawnSync(process.execPath, ['-e', '']).pid!, startedAt: 1 },
    launchers: jsonRecordDirectory(join(crashes, 'dispatch-launcher')), record: async () => undefined, parked: async () => false, loadRun: async () => null, park: async () => undefined });
  await guard.begin((await opened.store.loadRun('s', 'r'))!); await guard.enter('dispatch');
  const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['inspect', 'cancel'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'attempt', effect: 'allow', actions: ['reconcile', 'recover-output', 'cancel'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
    ...(input.standing === false ? [] : [{ id: 'nervous-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals, resource: { kind: 'recovery-action', ids: 'all' } }]),
  ] }), { mode: 0o600 });
  const scopes = await registerConfiguredScopesAtStart(await loadConfig(project, options));
  const errors: string[] = [], pages: unknown[] = [];
  // A service (re)start: a fresh runtime with fresh Nervous memory over the same installation.
  const start = async () => {
    const prepared = await prepareConfiguredReconciliationRuntime(project, { onPage(_command, page) { pages.push(page); }, onError(_command, error) { errors.push(error.code); } },
      options, scopes!.policyScopeIds);
    const controller = new AbortController(), done = prepared.run(controller.signal); loops.push({ controller, done });
    return async () => { controller.abort(); await done; };
  };
  const stop = await start();
  const ledger = await inspectProductFile(opened.layout, 'ledger', ['-wal', '-shm', '-journal']);
  const audit = (kind: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return (db.prepare('SELECT record FROM audit_events WHERE kind=? ORDER BY sequence').all(kind) as { record: string }[]).map(row => JSON.parse(row.record).event);
  } finally { db.close(); } };
  const counts = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return { attempts: (db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n, dispatches: (db.prepare('SELECT count(*) AS n FROM dispatches').get() as { n: number }).n };
  } finally { db.close(); } };
  const state = async () => ({ dispatch: await opened.store.readDispatch(request), attempt: await opened.store.load('s', 'a'), run: await opened.store.loadRun('s', 'r') });
  // The launcher's records of this Attempt (preparation left at `dispatch`, captured launcher evidence): pruned when its case ends in a release.
  const launcherRecords = async () => (await Promise.all(['dispatch-preparation', 'dispatch-launcher'].map(name => readdir(join(crashes, name)).catch(() => [])))).flat();
  return { errors, pages, commands, container, audit, counts, state, launcherRecords, before: await state(), stop, start, identity, project, options, layout: opened.layout, ledger };
}
const task = (run: unknown) => (run as { progress: { taskId: string; phase: string; unresolvedEffects: boolean; workerCustody?: { state: string } }[] }).progress[0]!;

it.skipIf(process.platform === 'win32')('orphan of a dead launcher: fence, authorized stop, then release with the exit proof; task stays reconciling, no new Attempt', async () => {
  const f = await fixture({ status: 'running', retained: 'none' });
  const released = await poll(async () => { const run = (await f.state()).run; return task(run).workerCustody?.state === 'released' ? run : undefined; }, 'RELEASE_TIMEOUT');
  await f.stop();
  expect(f.audit('recovery-detection').map(event => [event.subject.rule.id, event.subject.action, event.subject.disposition, event.subject.standingRef])).toEqual([
    ['launcher-dead-orphan', 'stop-orphan', 'execute', 'nervous-standing']]);
  expect(f.commands).toContain('kill');
  const after = await f.state();
  expect(after.attempt?.lastObservation?.result).toMatchObject({ kind: 'unknown' });
  expect(after.attempt?.cancelRequested).toBe(true);
  expect(after.dispatch?.terminal).toBeNull(); // the induced exit is not a clean exit (N20)
  expect(task(released)).toMatchObject({ phase: 'reconciling', unresolvedEffects: true, workerCustody: { state: 'released' } });
  expect(f.counts()).toEqual({ attempts: 1, dispatches: 1 });
  expect((released as { bindings: unknown[] }).bindings).toHaveLength(1);
  expect(f.audit('run-lifecycle').map(event => event.subject.action)).toEqual(['hold', 'release-worker-custody']);
  expect((released as { state: { kind: string } }).state.kind).not.toBe('parked');
  expect(await f.launcherRecords()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('a stop that did not take (the worker still runs after the kill) is re-applied from the sealed case on the next page, then released', async () => {
  const f = await fixture({ status: 'running', retained: 'none', lostKills: 1 });
  await poll(async () => task((await f.state()).run).workerCustody?.state === 'released' ? true : undefined, 'RELEASE_TIMEOUT');
  await f.stop();
  expect(f.commands.filter(command => command === 'kill')).toHaveLength(2);
  expect(f.audit('recovery-detection')).toHaveLength(1);
  expect(f.audit('run-lifecycle').map(event => [event.subject.action, event.subject.holdSource ?? null])).toEqual([['hold', null], ['release-worker-custody', null]]);
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32').each([['incarnation'], ['container']] as const)('gone container (%s retained): fenced and released on the proven absence; nothing stopped', async retained => {
  const f = await fixture({ status: 'missing', retained });
  await poll(async () => task((await f.state()).run).workerCustody?.state === 'released' ? true : undefined, 'RELEASE_TIMEOUT');
  await f.stop();
  expect(f.commands).not.toContain('kill');
  expect(await f.launcherRecords()).toEqual([]);
  expect(f.audit('recovery-detection').map(event => [event.subject.rule.id, event.subject.disposition])).toEqual([['launcher-dead-gone', 'execute']]);
  expect(f.counts()).toEqual({ attempts: 1, dispatches: 1 });
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('gone container with no retained identity: fenced, never released, and the Run goes to a person through one Nervous hold', async () => {
  const f = await fixture({ status: 'missing', retained: 'none' });
  expect(await f.launcherRecords()).toHaveLength(1);
  const held = await poll(async () => { const run = (await f.state()).run as { state: { kind: string; holdSource?: string; note?: string } }; return run.state.kind === 'parked' ? run : undefined; }, 'HOLD_TIMEOUT');
  await poll(async () => f.pages.length >= 6 ? true : undefined, 'PAGES_TIMEOUT'); await f.stop();
  const [detection] = f.audit('recovery-detection');
  expect(held.state).toMatchObject({ kind: 'parked', holdSource: 'nervous', note: `nervous:termination-required:launcher-dead-gone:${detection.subject.caseId.slice(0, 12)}` });
  expect(task((await f.state()).run).workerCustody).toBeUndefined();
  expect(await f.launcherRecords()).toHaveLength(1); // no release: the evidence stays for the person
  expect(f.audit('run-lifecycle').map(event => [event.subject.action, event.subject.holdSource ?? null])).toEqual([['hold', null], ['hold', 'nervous']]);
  expect(f.counts()).toEqual({ attempts: 1, dispatches: 1 });
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('live without the owner\'s standing grant: the case is sealed as a proposal and nothing changes', async () => {
  const f = await fixture({ status: 'running', retained: 'none', standing: false });
  await poll(async () => f.audit('recovery-detection').length && f.pages.length >= 5 ? true : undefined, 'DETECTION_TIMEOUT'); await f.stop();
  expect(f.audit('recovery-detection').map(event => event.subject.disposition)).toEqual(['proposal-only']);
  expect(f.commands.every(command => ['context', 'info', 'inspect'].includes(command))).toBe(true);
  const after = await f.state();
  expect(after.attempt?.lastObservation).toBeNull();
  expect(task(after.run).workerCustody).toBeUndefined();
  expect(f.audit('run-lifecycle')).toEqual([]);
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('Q3: a created, never-started container of a dead launcher is removed by its exact id, then the slot is released on its proven absence', async () => {
  const f = await fixture({ status: 'created', retained: 'container' });
  await poll(async () => task((await f.state()).run).workerCustody?.state === 'released' ? true : undefined, 'RELEASE_TIMEOUT');
  await f.stop();
  expect(f.commands).toContain('rm'); expect(f.commands).not.toContain('kill');
  expect(f.container.status).toBe('missing');
  expect(f.audit('recovery-detection').map(event => [event.subject.rule.id, event.subject.action, event.subject.disposition])).toEqual([['launcher-dead-orphan', 'stop-orphan', 'execute']]);
  expect(f.audit('run-lifecycle').map(event => event.subject.action)).toEqual(['hold', 'release-worker-custody']);
  expect(task((await f.state()).run)).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(f.counts()).toEqual({ attempts: 1, dispatches: 1 });
  expect(await f.launcherRecords()).toEqual([]);
  expect(f.errors).toEqual([]);
});

it.skipIf(process.platform === 'win32')('S6R-5 (lead on s6r4 Q4): after the lost task continued, a restart re-applies the old sealed execute case as a no-op — no fence, stop, hold or slot on the new task', async () => {
  const f = await fixture({ status: 'running', retained: 'none', recovery: true });
  await poll(async () => task((await f.state()).run).workerCustody?.state === 'released' ? true : undefined, 'RELEASE_TIMEOUT');
  await f.stop();
  // The continuation a live decision applies (S6R-4 application, recovery principal, the owner's standing grant).
  const config = await loadConfig(f.project, f.options), integrity = await openLocalIntegrityAuthority(f.layout, config.approvals.keyFile, true);
  const owner = { id: 'owner', issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['s'] };
  const standing = { schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants: [{ id: 'recovery-standing', effect: 'allow', actions: ['apply'], scopes: ['s'],
    principals: [{ issuer: owner.issuer, subject: owner.subject }], resource: { kind: 'recovery-action', ids: ['continue-new-attempt'] } }] };
  const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  const cases = openSqliteRecoveryStore(f.ledger, options), audit = await openSqliteAuditStore(f.ledger, options);
  try {
    const app = new RecoveryApplication({ store: cases, detections: new AuditApplication(audit, integrity), recorder: target => new AuditApplication(target, integrity),
      approval: async scopeId => recoveryContinuationApproval(standing, owner, scopeId, 30), hold: async () => { throw new Error('UNEXPECTED_HOLD'); }, isolation: async () => ({ schemaVersion: 1, network: 'none', egress: { kind: 'none' } }), policyRevision: 'fixture-policy',
      now: Date.now, timeoutMs: 1000 }, { async verify() { return recoveryPrincipal(owner, ['s']); } });
    const caseId = nervousCaseId('s', 'launcher-dead-orphan', { kind: 'attempt', identity: f.identity });
    const gated = await app.assess({ schemaVersion: 1, scopeId: 's', caseId });
    expect(await app.continueLostTask({ schemaVersion: 1, scopeId: 's', caseId, evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' })).toMatchObject({ kind: 'continued' });
  } finally { cases.close(); audit.close(); }
  const continued = (await f.state()).run, kills = f.commands.filter(command => command === 'kill').length, lifecycle = f.audit('run-lifecycle').length, pages = f.pages.length;
  const inspects = f.commands.filter(command => command === 'inspect').length;
  // The old dispatch stays granted and unsettled in the inventory: the restarted Nervous meets it and replays its sealed `execute` case.
  expect((await f.state()).dispatch).toMatchObject({ launch: 'granted', terminal: null });
  expect(task(continued)).toMatchObject({ phase: 'pending', unresolvedEffects: false }); expect(task(continued).workerCustody).toBeUndefined();
  // Restart: fresh Nervous memory meets the old fenced dispatch again and replays its sealed execute case.
  const stop = await f.start();
  await poll(async () => f.pages.length >= pages + 6 ? true : undefined, 'PAGES_TIMEOUT'); await stop();
  expect((await f.state()).run).toEqual(continued);
  expect(f.commands.filter(command => command === 'kill')).toHaveLength(kills);
  expect(f.commands.filter(command => command === 'inspect').length).toBeGreaterThan(inspects);
  expect(f.audit('run-lifecycle')).toHaveLength(lifecycle); expect(f.audit('recovery-detection')).toHaveLength(1);
  expect(f.counts()).toEqual({ attempts: 1, dispatches: 1 });
  expect(f.errors).toEqual([]);
});
